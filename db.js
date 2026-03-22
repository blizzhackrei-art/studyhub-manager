/**
 * StudyHub Firebase Database Layer v2
 * ─────────────────────────────────────
 * - Real-time Firestore listeners
 * - Offline-first: localStorage queue for pending writes
 * - Auto-sync pending writes when back online
 * - Sync status indicator
 */

const FirebaseDB = (() => {
  let _db = null;
  let _configured = false;
  let _online = navigator.onLine;
  let _listeners = [];
  let _syncStatus = 'local';
  let _onSyncChange = null;
  let _onDataChange = null;
  let _pendingQueue = [];
  let _syncInProgress = false;

  // ── LocalStorage helpers ──────────────────────────────────────────────────
  const LS = {
    get(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch { return def; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  };

  // ── Offline write queue ──────────────────────────────────────────────────
  const loadQueue = () => { _pendingQueue = LS.get('sh_pending_queue', []); };
  const saveQueue = () => { LS.set('sh_pending_queue', _pendingQueue); };
  const enqueue = (op) => {
    // Deduplicate: replace existing set op for same doc
    if (op.type === 'set') {
      const idx = _pendingQueue.findIndex(q => q.type === 'set' && q.collection === op.collection && q.id === op.id);
      if (idx >= 0) { _pendingQueue[idx] = { ...op, _queuedAt: Date.now() }; saveQueue(); return; }
    }
    _pendingQueue.push({ ...op, _queuedAt: Date.now() });
    saveQueue();
  };

  // ── Config storage ──────────────────────────────────────────────────────
  const getConfig = () => LS.get('sh_firebase_config', null);
  const setConfig = (cfg) => LS.set('sh_firebase_config', cfg);
  const isConfigured = () => !!getConfig();

  // ── Load Firebase SDK ───────────────────────────────────────────────────
  const loadFirebaseSDK = () => new Promise((resolve, reject) => {
    if (window.firebase) { resolve(); return; }
    const scripts = [
      'https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js',
      'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore-compat.js',
    ];
    let loaded = 0;
    scripts.forEach(src => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => { loaded++; if (loaded === scripts.length) resolve(); };
      s.onerror = () => reject(new Error('Failed to load Firebase SDK. Check your internet connection.'));
      document.head.appendChild(s);
    });
  });

  // ── Init ────────────────────────────────────────────────────────────────
  const init = async (config) => {
    setSyncStatus('connecting', 'Connecting…');
    loadQueue();
    try {
      await loadFirebaseSDK();
      if (!firebase.apps.length) firebase.initializeApp(config);
      _db = firebase.firestore();
      await _db.enablePersistence({ synchronizeTabs: true }).catch(err => {
        if (err.code !== 'failed-precondition' && err.code !== 'unimplemented')
          console.warn('Persistence warning:', err.code);
      });
      _configured = true;
      setConfig(config);
      await flushQueue();
      setSyncStatus('synced', 'Synced');
      window.addEventListener('online', handleOnline);
      window.addEventListener('offline', handleOffline);
      return true;
    } catch (e) {
      setSyncStatus('error', 'Firebase error: ' + e.message);
      throw e;
    }
  };

  const handleOnline = async () => {
    _online = true;
    setSyncStatus('connecting', 'Reconnecting…');
    try { await flushQueue(); setSyncStatus('synced', 'Back online · Synced'); } catch {}
  };

  const handleOffline = () => {
    _online = false;
    setSyncStatus('offline', 'Offline · Saving locally');
  };

  // ── Flush pending offline queue ──────────────────────────────────────────
  const flushQueue = async () => {
    if (_syncInProgress || !_db || !_configured || _pendingQueue.length === 0) return;
    _syncInProgress = true;
    const pending = _pendingQueue.length;
    setSyncStatus('connecting', `Syncing ${pending} pending changes…`);
    const toProcess = [..._pendingQueue];
    const failed = [];
    for (const op of toProcess) {
      try {
        if (op.type === 'set') {
          await _db.collection(op.collection).doc(op.id).set(op.data, { merge: true });
        } else if (op.type === 'delete') {
          await _db.collection(op.collection).doc(op.id).delete();
        }
      } catch (e) {
        console.warn('Queue flush failed:', e.message);
        failed.push(op);
      }
    }
    _pendingQueue = failed;
    saveQueue();
    _syncInProgress = false;
  };

  const reconnect = async () => {
    const cfg = getConfig();
    if (!cfg) return false;
    try { await init(cfg); return true; } catch { return false; }
  };

  const disconnect = () => {
    _listeners.forEach(u => u());
    _listeners = [];
    _db = null;
    _configured = false;
    setConfig(null);
    setSyncStatus('local', 'Disconnected');
  };

  // ── Sync status UI ──────────────────────────────────────────────────────
  const setSyncStatus = (status, msg) => {
    _syncStatus = status;
    _updateSyncUI(status, msg);
    if (_onSyncChange) _onSyncChange(status, msg);
  };

  function _updateSyncUI(status, message) {
    const dotEl = document.getElementById('sync-dot');
    const textEl = document.getElementById('sync-text');
    if (!dotEl || !textEl) return;
    const colors = { synced: '#00c896', connecting: '#f59e0b', offline: '#4d6680', error: '#ef4444', local: '#4d6680' };
    dotEl.style.background = colors[status] || '#4d6680';
    dotEl.style.boxShadow = status === 'synced' ? '0 0 6px #00c896' : 'none';
    textEl.textContent = message;
  }

  // ── CRUD ────────────────────────────────────────────────────────────────
  async function set(collection, id, data) {
    const doc = { ...data, id, _updatedAt: Date.now() };
    // Always write locally first (instant & offline-safe)
    const all = LS.get('sh_' + collection, []);
    const idx = all.findIndex(d => d.id === id);
    if (idx >= 0) all[idx] = doc; else all.push(doc);
    LS.set('sh_' + collection, all);

    if (_db && _configured) {
      if (navigator.onLine) {
        try {
          await _db.collection(collection).doc(id).set(doc, { merge: true });
        } catch (e) {
          console.warn('Firestore write failed, queuing:', e.message);
          enqueue({ type: 'set', collection, id, data: doc });
        }
      } else {
        enqueue({ type: 'set', collection, id, data: doc });
      }
    }
  }

  const remove = async (collection, id) => {
    const all = LS.get('sh_' + collection, []);
    LS.set('sh_' + collection, all.filter(d => d.id !== id));
    if (_db && _configured) {
      if (navigator.onLine) {
        try { await _db.collection(collection).doc(id).delete(); }
        catch (e) { enqueue({ type: 'delete', collection, id }); }
      } else {
        enqueue({ type: 'delete', collection, id });
      }
    }
  };

  const getAll = (collection, def = []) => LS.get('sh_' + collection, def);

  // ── Real-time listeners ─────────────────────────────────────────────────
  const listen = (collection, onChange) => {
    if (!_db || !_configured) return;
    const unsubscribe = _db.collection(collection)
      .onSnapshot({ includeMetadataChanges: false }, (snapshot) => {
        const docs = snapshot.docs.map(d => ({ ...d.data(), id: d.id }));
        LS.set('sh_' + collection, docs);
        if (onChange) onChange(collection, docs);
        if (_onDataChange) _onDataChange(collection, docs);
        const pendingLabel = _pendingQueue.length > 0 ? ` · ${_pendingQueue.length} pending` : '';
        setSyncStatus('synced', 'Synced · ' + new Date().toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' }) + pendingLabel);
      }, (error) => {
        console.error('Firestore listener error:', error);
        setSyncStatus('error', 'Sync error');
      });
    _listeners.push(unsubscribe);
    return unsubscribe;
  };

  const seedIfEmpty = async (collection, docs) => {
    if (!_db || !_configured) return;
    try {
      const snap = await _db.collection(collection).limit(1).get();
      if (snap.empty) {
        const batch = _db.batch();
        docs.forEach(doc => batch.set(_db.collection(collection).doc(doc.id), { ...doc, _updatedAt: Date.now() }));
        await batch.commit();
      }
    } catch (e) { console.warn('Seed failed:', e.message); }
  };

  return {
    init, reconnect, disconnect, isConfigured, getConfig,
    set, remove, getAll, listen, seedIfEmpty, flushQueue,
    get configured() { return _configured; },
    get syncStatus() { return _syncStatus; },
    get pendingCount() { return _pendingQueue.length; },
    set onSyncChange(fn) { _onSyncChange = fn; },
    set onDataChange(fn) { _onDataChange = fn; },
    lsGet: LS.get,
    lsSet: LS.set,
  };
})();

window.FirebaseDB = FirebaseDB;

// ── Payment Types ────────────────────────────────────────────────────────────
function getPaymentTypes() {
  return JSON.parse(localStorage.getItem('sh_paymentTypes')) || [
    { id: 'cash', name: 'Cash', isActive: true },
    { id: 'gcash', name: 'GCash', isActive: true }
  ];
}
function savePaymentTypes(pt) { localStorage.setItem('sh_paymentTypes', JSON.stringify(pt)); }

// ── User Management ──────────────────────────────────────────────────────────
function getUsers() {
  return JSON.parse(localStorage.getItem('sh_users')) || [
    { id: 'admin', name: 'Admin', pin: '1234', role: 'admin', color: '#00c896' },
    { id: 'staff1', name: 'Staff 1', pin: '1111', role: 'staff', color: '#6366f1' }
  ];
}
function saveUsers(users) { localStorage.setItem('sh_users', JSON.stringify(users)); }
function getCurrentUser() { return JSON.parse(localStorage.getItem('sh_currentUser')); }
function saveCurrentUser(user) { localStorage.setItem('sh_currentUser', JSON.stringify(user)); }
function clearCurrentUser() { localStorage.removeItem('sh_currentUser'); }

// ── Auto-reconnect on network restore ───────────────────────────────────────
window.addEventListener('online', () => {
  if (window.FirebaseDB && window.FirebaseDB.configured) FirebaseDB.reconnect();
});
