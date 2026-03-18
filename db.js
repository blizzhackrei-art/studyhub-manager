/**
 * StudyHub Firebase Database Layer
 * ─────────────────────────────────
 * Wraps Firebase Firestore with:
 *  - Real-time listeners for seats, rates, sessions
 *  - Automatic offline persistence (IndexedDB cache)
 *  - LocalStorage fallback when Firebase is not configured
 *  - Sync status indicator
 */

const FirebaseDB = (() => {

  // ── Internal state ──────────────────────────────────────────────────────
  let _db = null;
  let _configured = false;
  let _online = navigator.onLine;
  let _listeners = [];          // active Firestore unsubscribe fns
  let _syncStatus = 'local';    // 'local' | 'connecting' | 'synced' | 'offline' | 'error'
  let _onSyncChange = null;     // callback(status, message)
  let _onDataChange = null;     // callback(collection, docs)

  // ── LocalStorage fallback (same as before) ──────────────────────────────
  const LS = {
    get(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch { return def; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  };

  // ── Firebase config storage ─────────────────────────────────────────────
  const getConfig = () => LS.get('sh_firebase_config', null);
  const setConfig = (cfg) => LS.set('sh_firebase_config', cfg);
  const isConfigured = () => !!getConfig();

  // ── Load Firebase SDK dynamically ───────────────────────────────────────
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
      s.onerror = () => reject(new Error('Failed to load Firebase SDK. Check internet connection.'));
      document.head.appendChild(s);
    });
  });

  // ── Initialize Firebase ─────────────────────────────────────────────────
  const init = async (config) => {
    setSyncStatus('connecting', 'Connecting to Firebase…');
    try {
      await loadFirebaseSDK();

      // Init app (avoid duplicate)
      if (!firebase.apps.length) {
        firebase.initializeApp(config);
      }

      _db = firebase.firestore();

      // Enable offline persistence
      await _db.enablePersistence({ synchronizeTabs: true }).catch(err => {
        if (err.code === 'failed-precondition') {
          console.warn('FirestoreDB: Multiple tabs open, persistence enabled in one tab only.');
        } else if (err.code === 'unimplemented') {
          console.warn('FirestoreDB: Offline persistence not supported on this browser.');
        }
      });

      _configured = true;
      setConfig(config);
      setSyncStatus('synced', 'Connected to Firebase');

      // Monitor online/offline
      window.addEventListener('online',  () => setSyncStatus('synced',   'Back online — syncing…'));
      window.addEventListener('offline', () => setSyncStatus('offline',  'Offline — changes saved locally'));

      return true;
    } catch (e) {
      setSyncStatus('error', 'Firebase error: ' + e.message);
      throw e;
    }
  };

  // ── Reconnect with saved config ─────────────────────────────────────────
  const reconnect = async () => {
    const cfg = getConfig();
    if (!cfg) return false;
    try {
      await init(cfg);
      return true;
    } catch {
      return false;
    }
  };

  const disconnect = () => {
    _listeners.forEach(u => u());
    _listeners = [];
    _db = null;
    _configured = false;
    setConfig(null);
    setSyncStatus('local', 'Disconnected from Firebase');
  };

// Update sync status in UI
function updateSyncUI(status, message) {
  const statusEl = document.getElementById('sync-status');
  const dotEl = document.getElementById('sync-dot');
  const textEl = document.getElementById('sync-text');
  
  if(!statusEl || !dotEl || !textEl) return;

  statusEl.className = `sync-status ${status}`;
  dotEl.className = `sync-dot ${status}`;
  textEl.textContent = message;
}

  // ── Sync status helper ──────────────────────────────────────────────────
  const setSyncStatus = (status, msg) => {
    _syncStatus = status;
    updateSyncUI(status, msg);
    if(_onSyncChange) _onSyncChange(status, msg);
};

  // ── CRUD Operations ─────────────────────────────────────────────────────

  // Upsert a document
  async function set(collection, id, data) {
    // Always write to localStorage first (instant, offline-safe)
    const all = LS.get('sh_' + collection, []);
    const idx = all.findIndex(d => d.id === id);
    const doc = { ...data, id, _updatedAt: Date.now() };
    if (idx >= 0) all[idx] = doc; else all.push(doc);
    LS.set('sh_' + collection, all);

    // Then write to Firestore if connected
    if (_db && _configured) {
      try {
        await _db.collection(collection).doc(id).set({ ...doc }, { merge: true });
      } catch (e) {
        console.warn('Firestore set failed (will sync when online):', e.message);
      }
    }
  }

  // Delete a document
  const remove = async (collection, id) => {
    const all = LS.get('sh_' + collection, []);
    LS.set('sh_' + collection, all.filter(d => d.id !== id));

    if (_db && _configured) {
      try {
        await _db.collection(collection).doc(id).delete();
      } catch (e) {
        console.warn('Firestore delete failed:', e.message);
      }
    }
  };

  // Get all docs from collection (from localStorage, Firestore listener keeps it fresh)
  const getAll = (collection, def = []) => {
    return LS.get('sh_' + collection, def);
  };

  // ── Real-time listeners ─────────────────────────────────────────────────
  const listen = (collection, onChange) => {
    if (!_db || !_configured) return;

    const unsubscribe = _db.collection(collection)
      .onSnapshot(
        { includeMetadataChanges: false },
        (snapshot) => {
          const docs = snapshot.docs.map(d => ({ ...d.data(), id: d.id }));
          // Update localStorage cache
          LS.set('sh_' + collection, docs);
          // Notify app
          if (onChange) onChange(collection, docs);
          if (_onDataChange) _onDataChange(collection, docs);
          setSyncStatus('synced', 'Synced · ' + new Date().toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' }));
        },
        (error) => {
          console.error('Firestore listener error:', error);
          setSyncStatus('error', 'Sync error: ' + error.message);
        }
      );

    _listeners.push(unsubscribe);
    return unsubscribe;
  };

  // ── Bulk seed (first-time setup) ────────────────────────────────────────
  const seedIfEmpty = async (collection, docs) => {
    if (!_db || !_configured) return;
    try {
      const snap = await _db.collection(collection).limit(1).get();
      if (snap.empty) {
        const batch = _db.batch();
        docs.forEach(doc => {
          batch.set(_db.collection(collection).doc(doc.id), { ...doc, _updatedAt: Date.now() });
        });
        await batch.commit();
      }
    } catch (e) {
      console.warn('Seed failed:', e.message);
    }
  };

  // ── Public API ──────────────────────────────────────────────────────────
  return {
    init,
    reconnect,
    disconnect,
    isConfigured,
    getConfig,
    set,
    remove,
    getAll,
    listen,
    seedIfEmpty,
    get configured() { return _configured; },
    get syncStatus() { return _syncStatus; },
    set onSyncChange(fn) { _onSyncChange = fn; },
    set onDataChange(fn) { _onDataChange = fn; },
    // LocalStorage direct access (for settings/printer which don't need sync)
    lsGet: LS.get,
    lsSet: LS.set,
  };
})();

window.FirebaseDB = FirebaseDB;

// Add this function to db.js
function getPaymentTypes() {
    return JSON.parse(localStorage.getItem('sh_paymentTypes')) || [
        {id: 'cash', name: 'Cash', isActive: true},
        {id: 'gcash', name: 'GCash', isActive: true}
    ];
}

function savePaymentTypes(paymentTypes) {
    localStorage.setItem('sh_paymentTypes', JSON.stringify(paymentTypes));
}

// Add to db.js
function getUsers() {
    return JSON.parse(localStorage.getItem('sh_users')) || [
        {id: 'admin', name: 'Admin', pin: '1234', role: 'admin'},
        {id: 'staff1', name: 'Staff 1', pin: '1111', role: 'staff'}
    ];
}

function saveUsers(users) {
    localStorage.setItem('sh_users', JSON.stringify(users));
}

function getCurrentUser() {
    return JSON.parse(localStorage.getItem('sh_currentUser'));
}

function saveCurrentUser(user) {
    localStorage.setItem('sh_currentUser', JSON.stringify(user));
}

// Add these event listeners at the end of db.js
window.addEventListener('online', () => FirebaseDB.reconnect());
window.addEventListener('offline', () => setSyncStatus('offline', 'Working offline'));
