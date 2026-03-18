/**
 * StudyHub Thermal Printer Engine
 * Supports: WebUSB · Web Bluetooth · LAN (WebSocket bridge)
 * Paper: 58mm (32 chars) · 80mm (48 chars)
 * Protocol: ESC/POS (Epson-compatible, works with 95% of thermal POS printers)
 */

// ─── ESC/POS Command Constants ────────────────────────────────────────────────
const ESC = 0x1B;
const GS  = 0x1D;
const FS  = 0x1C;
const DLE = 0x10;

const CMD = {
  INIT:           [ESC, 0x40],
  ALIGN_LEFT:     [ESC, 0x61, 0x00],
  ALIGN_CENTER:   [ESC, 0x61, 0x01],
  ALIGN_RIGHT:    [ESC, 0x61, 0x02],
  BOLD_ON:        [ESC, 0x45, 0x01],
  BOLD_OFF:       [ESC, 0x45, 0x00],
  DOUBLE_HEIGHT:  [ESC, 0x21, 0x10],
  DOUBLE_WIDTH:   [ESC, 0x21, 0x20],
  DOUBLE_BOTH:    [ESC, 0x21, 0x30],
  NORMAL_SIZE:    [ESC, 0x21, 0x00],
  UNDERLINE_ON:   [ESC, 0x2D, 0x01],
  UNDERLINE_OFF:  [ESC, 0x2D, 0x00],
  INVERT_ON:      [GS,  0x42, 0x01],
  INVERT_OFF:     [GS,  0x42, 0x00],
  FONT_A:         [ESC, 0x4D, 0x00],
  FONT_B:         [ESC, 0x4D, 0x01],
  LF:             [0x0A],
  CR:             [0x0D],
  FEED_1:         [ESC, 0x64, 0x01],
  FEED_2:         [ESC, 0x64, 0x02],
  FEED_3:         [ESC, 0x64, 0x03],
  FEED_4:         [ESC, 0x64, 0x04],
  CUT_FULL:       [GS,  0x56, 0x00],
  CUT_PARTIAL:    [GS,  0x56, 0x01],
  CASH_DRAWER:    [ESC, 0x70, 0x00, 0x19, 0xFF],
  BEEP:           [ESC, 0x42, 0x03, 0x02],
  // Char spacing
  CHAR_SPACING_0: [ESC, 0x20, 0x00],
};

// Bluetooth printer service UUIDs (common thermal printers)
const BT_PRINTER_SERVICE_UUIDS = [
  '000018f0-0000-1000-8000-00805f9b34fb', // Generic Serial (most common)
  '0000ffe0-0000-1000-8000-00805f9b34fb', // HM-10 BLE
  '00001101-0000-1000-8000-00805f9b34fb', // SPP Classic
  '0000ff00-0000-1000-8000-00805f9b34fb', // Custom
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2', // Xprinter BLE
  '49535343-fe7d-4ae5-8fa9-9fafd205e455', // BLE Serial
];
const BT_PRINTER_CHAR_UUIDS = [
  '00002af1-0000-1000-8000-00805f9b34fb',
  '0000ffe1-0000-1000-8000-00805f9b34fb',
  '00002a05-0000-1000-8000-00805f9b34fb',
  '000002ee-0000-1000-8000-00805f9b34fb',
  '0000ff02-0000-1000-8000-00805f9b34fb',
  '49535343-8841-43f4-a8d4-ecbe34729bb3',
];

// ─── Printer Class ────────────────────────────────────────────────────────────
class ThermalPrinter {
  constructor() {
    this.connection = null; // { type, device, write }
    this.paperWidth = 80;   // 58 or 80
    this.chars = 48;        // chars per line
    this.onStatus = null;   // callback(msg, level)
    this.onConnected = null;
    this.onDisconnected = null;
  }

  get isConnected() { return !!this.connection; }
  get connType() { return this.connection?.type || null; }

  setPaperWidth(mm) {
    this.paperWidth = mm;
    this.chars = mm === 58 ? 32 : 48;
  }

  status(msg, level = 'info') {
    console.log(`[Printer] ${msg}`);
    if (this.onStatus) this.onStatus(msg, level);
  }

  // ── USB via WebUSB ─────────────────────────────────────────────────────────
  async connectUSB() {
    if (!navigator.usb) throw new Error('WebUSB not supported in this browser. Use Chrome on Android.');
    this.status('Requesting USB device…');
    let device;
    try {
      device = await navigator.usb.requestDevice({ filters: [] });
    } catch (e) {
      if (e.name === 'NotFoundError') throw new Error('No USB device selected.');
      throw e;
    }
    await device.open();
    if (device.configuration === null) await device.selectConfiguration(1);

    // Find bulk-out endpoint
    let iface = null, endpoint = null;
    outer:
    for (const cfg of device.configurations) {
      for (const inf of cfg.interfaces) {
        for (const alt of inf.alternates) {
          for (const ep of alt.endpoints) {
            if (ep.direction === 'out' && ep.type === 'bulk') {
              iface = inf; endpoint = ep; break outer;
            }
          }
        }
      }
    }
    if (!endpoint) {
      // Try interrupt out
      outer2:
      for (const cfg of device.configurations) {
        for (const inf of cfg.interfaces) {
          for (const alt of inf.alternates) {
            for (const ep of alt.endpoints) {
              if (ep.direction === 'out') {
                iface = inf; endpoint = ep; break outer2;
              }
            }
          }
        }
      }
    }
    if (!endpoint) throw new Error('No output endpoint found on USB device.');
    await device.claimInterface(iface.interfaceNumber);

    const epNum = endpoint.endpointNumber;
    this.connection = {
      type: 'USB',
      device,
      iface: iface.interfaceNumber,
      write: async (data) => {
        const CHUNK = 64;
        for (let i = 0; i < data.length; i += CHUNK) {
          await device.transferOut(epNum, data.slice(i, i + CHUNK));
        }
      }
    };
    this.status(`USB connected: ${device.productName || 'Thermal Printer'}`, 'success');
    if (this.onConnected) this.onConnected('USB', device.productName);
  }

  // ── Bluetooth via Web Bluetooth ────────────────────────────────────────────
  async connectBluetooth() {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth not supported. Enable it in Chrome flags or use Chrome on Android.');
    this.status('Scanning for Bluetooth printers…');

    let device, server, characteristic;

    // Try each known service UUID
    for (const svcUUID of BT_PRINTER_SERVICE_UUIDS) {
      try {
        device = await navigator.bluetooth.requestDevice({
          filters: [{ services: [svcUUID] }],
          optionalServices: BT_PRINTER_SERVICE_UUIDS,
        });
        break;
      } catch (e) {
        if (e.name === 'NotFoundError') continue;
        if (e.name === 'SecurityError') throw new Error('Bluetooth permission denied.');
        // User cancelled
        if (e.message && e.message.includes('cancel')) throw new Error('Bluetooth scan cancelled.');
      }
    }

    // If all filtered scans fail, try acceptAllDevices
    if (!device) {
      try {
        device = await navigator.bluetooth.requestDevice({
          acceptAllDevices: true,
          optionalServices: BT_PRINTER_SERVICE_UUIDS,
        });
      } catch (e) {
        throw new Error('No Bluetooth printer found or user cancelled.');
      }
    }

    this.status(`Connecting to ${device.name || 'BT device'}…`);
    server = await device.gatt.connect();

    // Find writable characteristic
    const services = await server.getPrimaryServices();
    for (const svc of services) {
      const chars = await svc.getCharacteristics();
      for (const ch of chars) {
        if (ch.properties.write || ch.properties.writeWithoutResponse) {
          characteristic = ch; break;
        }
      }
      if (characteristic) break;
    }

    if (!characteristic) throw new Error('No writable characteristic found on Bluetooth printer.');

    device.addEventListener('gattserverdisconnected', () => {
      this.connection = null;
      this.status('Bluetooth printer disconnected', 'warn');
      if (this.onDisconnected) this.onDisconnected();
    });

    const useResponse = characteristic.properties.write;
    this.connection = {
      type: 'Bluetooth',
      device,
      write: async (data) => {
        const CHUNK = 20; // BLE MTU safe chunk size
        for (let i = 0; i < data.length; i += CHUNK) {
          const chunk = data.slice(i, i + CHUNK);
          if (useResponse) {
            await characteristic.writeValue(chunk);
          } else {
            await characteristic.writeValueWithoutResponse(chunk);
          }
          await new Promise(r => setTimeout(r, 30)); // small delay between chunks
        }
      }
    };
    this.status(`Bluetooth connected: ${device.name || 'Printer'}`, 'success');
    if (this.onConnected) this.onConnected('Bluetooth', device.name);
  }

  // ── LAN via WebSocket Bridge ───────────────────────────────────────────────
  // Requires a tiny WebSocket→TCP bridge running on same network
  // Bridge script is provided separately (ws-bridge.js)
  async connectLAN(ip, port = 9100, wsPort = 8765) {
    this.status(`Connecting to ${ip}:${port} via LAN…`);
    return new Promise((resolve, reject) => {
      const wsUrl = `ws://${ip}:${wsPort}`;
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`LAN connection timed out. Make sure the bridge is running on ${ip}:${wsPort}`));
      }, 5000);

      ws.onopen = () => {
        clearTimeout(timer);
        // Send target TCP info
        ws.send(JSON.stringify({ type: 'connect', host: ip, port }));
      };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.status === 'ready') {
            this.connection = {
              type: 'LAN',
              ip, port,
              ws,
              write: async (data) => {
                ws.send(data);
              }
            };
            ws.onclose = () => {
              this.connection = null;
              this.status('LAN printer disconnected', 'warn');
              if (this.onDisconnected) this.onDisconnected();
            };
            this.status(`LAN connected: ${ip}:${port}`, 'success');
            if (this.onConnected) this.onConnected('LAN', `${ip}:${port}`);
            resolve();
          } else if (msg.status === 'error') {
            reject(new Error(msg.message || 'LAN connection failed'));
          }
        } catch {}
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`Cannot reach printer bridge at ${wsUrl}. See LAN setup guide.`));
      };
    });
  }

  // ── Disconnect ─────────────────────────────────────────────────────────────
  async disconnect() {
    if (!this.connection) return;
    try {
      const t = this.connection.type;
      if (t === 'USB') {
        await this.connection.device.releaseInterface(this.connection.iface);
        await this.connection.device.close();
      } else if (t === 'Bluetooth') {
        this.connection.device.gatt.disconnect();
      } else if (t === 'LAN') {
        this.connection.ws.close();
      }
    } catch {}
    this.connection = null;
    this.status('Printer disconnected');
    if (this.onDisconnected) this.onDisconnected();
  }

  // ─── ESC/POS Builder ───────────────────────────────────────────────────────
  _encode(str) {
    // UTF-8 safe encode for ASCII-compatible thermal printers
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) { bytes.push(0xC0 | (c >> 6)); bytes.push(0x80 | (c & 0x3F)); }
      else { bytes.push(0xE0 | (c >> 12)); bytes.push(0x80 | ((c >> 6) & 0x3F)); bytes.push(0x80 | (c & 0x3F)); }
    }
    return bytes;
  }

  _text(str) { return this._encode(str); }
  _cmd(...cmds) { return cmds.flat(); }
  _concat(...parts) { return parts.flat(); }

  // Pad/truncate string to exact width
  _pad(str, width, align = 'left', fill = ' ') {
    str = String(str || '');
    if (str.length > width) str = str.slice(0, width);
    const pad = fill.repeat(width - str.length);
    return align === 'right' ? pad + str : align === 'center' ? ' '.repeat(Math.floor((width - str.length)/2)) + str + ' '.repeat(Math.ceil((width - str.length)/2)) : str + pad;
  }

  // Two-column line (left + right)
  _twoCol(left, right, width) {
    const rLen = String(right).length;
    const lLen = width - rLen - 1;
    return this._pad(left, lLen, 'left') + ' ' + this._pad(right, rLen, 'right');
  }

  // Three-column line (item table row)
  _threeCol(name, qty, price, width) {
    const qtyStr = String(qty);
    const priceStr = String(price);
    const nameLen = width - qtyStr.length - priceStr.length - 2;
    return this._pad(name, nameLen, 'left') + ' ' + qtyStr + ' ' + this._pad(priceStr, priceStr.length, 'right');
  }

  _divider(char = '-') { return char.repeat(this.chars); }
  _dblDivider() { return '='.repeat(this.chars); }

  // ─── Receipt Builder ───────────────────────────────────────────────────────
  buildReceipt(data) {
    /**
     * data = {
     *   shopName, shopAddress, shopPhone,
     *   receiptNo, seatName, seatType,
     *   customerName, checkIn, checkOut,
     *   duration, rateName, ratePerHour,
     *   minCharge, subtotal, total,
     *   cashier, note
     * }
     */
    const W = this.chars;
    const bytes = [];
    const push = (...b) => bytes.push(...b.flat());

    // Init
    push(CMD.INIT);
    push(CMD.CHAR_SPACING_0);
    push(CMD.FONT_A);

    // ── Header ──
    push(CMD.ALIGN_CENTER);
    push(CMD.BOLD_ON);
    push(CMD.DOUBLE_BOTH);
    push(this._text(data.shopName || 'STUDYHUB'));
    push(CMD.LF);
    push(CMD.NORMAL_SIZE);
    push(CMD.BOLD_OFF);
    push(CMD.ALIGN_CENTER);
    if (data.shopTagline) { push(this._text(data.shopTagline)); push(CMD.LF); }
    if (data.shopAddress) { push(this._text(data.shopAddress)); push(CMD.LF); }
    if (data.shopPhone)   { push(this._text('Tel: ' + data.shopPhone)); push(CMD.LF); }

    push(CMD.FEED_1);
    push(CMD.ALIGN_CENTER);
    push(CMD.BOLD_ON);
    push(this._text('OFFICIAL RECEIPT'));
    push(CMD.BOLD_OFF);
    push(CMD.LF);
    push(this._text(this._divider('=')));
    push(CMD.LF);

    // ── Receipt Info ──
    push(CMD.ALIGN_LEFT);
    push(this._text(this._twoCol('Receipt #:', data.receiptNo || '—', W))); push(CMD.LF);
    push(this._text(this._twoCol('Date:', data.checkOut || '—', W))); push(CMD.LF);
    push(this._text(this._twoCol('Cashier:', data.cashier || 'Staff', W))); push(CMD.LF);
    push(this._text(this._divider())); push(CMD.LF);

    // ── Seat & Customer ──
    push(CMD.BOLD_ON);
    push(this._text('SEAT DETAILS')); push(CMD.LF);
    push(CMD.BOLD_OFF);
    push(this._text(this._twoCol('Seat:', data.seatName || '—', W))); push(CMD.LF);
    push(this._text(this._twoCol('Type:', data.seatType || '—', W))); push(CMD.LF);
    push(this._text(this._twoCol('Customer:', data.customerName || '—', W))); push(CMD.LF);
    push(this._text(this._divider())); push(CMD.LF);

    // ── Time ──
    push(CMD.BOLD_ON);
    push(this._text('SESSION TIME')); push(CMD.LF);
    push(CMD.BOLD_OFF);
    push(this._text(this._twoCol('Check-in:', data.checkIn || '—', W))); push(CMD.LF);
    push(this._text(this._twoCol('Check-out:', data.checkOut || '—', W))); push(CMD.LF);
    push(this._text(this._twoCol('Duration:', data.duration || '—', W))); push(CMD.LF);
    push(this._text(this._divider())); push(CMD.LF);

    // ── Charges ──
    push(CMD.BOLD_ON);
    push(this._text('CHARGES')); push(CMD.LF);
    push(CMD.BOLD_OFF);
    push(this._text(this._twoCol('Rate Plan:', data.rateName || '—', W))); push(CMD.LF);
    push(this._text(this._twoCol('Rate/Hour:', 'P' + (data.ratePerHour || 0).toFixed(2), W))); push(CMD.LF);
    if (data.minCharge) push(this._text(this._twoCol('Min. Charge:', 'P' + Number(data.minCharge).toFixed(2), W))), push(CMD.LF);
    push(this._text(this._divider('='))); push(CMD.LF);

    // ── Total ──
    push(CMD.ALIGN_CENTER);
    push(CMD.BOLD_ON);
    push(CMD.DOUBLE_HEIGHT);
    push(this._text('TOTAL AMOUNT'));
    push(CMD.LF);
    push(CMD.DOUBLE_BOTH);
    push(this._text('P' + Number(data.total || 0).toFixed(2)));
    push(CMD.LF);
    push(CMD.NORMAL_SIZE);
    push(CMD.BOLD_OFF);

    // ── Note ──
    push(this._text(this._divider('='))); push(CMD.LF);
    push(CMD.ALIGN_CENTER);
    if (data.note) { push(this._text(data.note)); push(CMD.LF); }
    push(this._text('Thank you for choosing StudyHub!')); push(CMD.LF);
    push(this._text('See you again soon.')); push(CMD.LF);

    // Footer
    push(CMD.FEED_3);
    push(CMD.CUT_PARTIAL);

    return new Uint8Array(bytes);
  }

  // ─── Test Print ────────────────────────────────────────────────────────────
  buildTestPrint() {
    const W = this.chars;
    const bytes = [];
    const push = (...b) => bytes.push(...b.flat());

    push(CMD.INIT);
    push(CMD.ALIGN_CENTER);
    push(CMD.BOLD_ON);
    push(CMD.DOUBLE_BOTH);
    push(this._text('STUDYHUB'));
    push(CMD.LF);
    push(CMD.NORMAL_SIZE);
    push(CMD.BOLD_OFF);
    push(this._text('Printer Test Page'));
    push(CMD.LF);
    push(this._text(this._divider('='))); push(CMD.LF);
    push(CMD.ALIGN_LEFT);
    push(this._text(`Paper Width: ${this.paperWidth}mm`)); push(CMD.LF);
    push(this._text(`Chars/line:  ${this.chars}`)); push(CMD.LF);
    push(this._text(`Connection:  ${this.connType}`)); push(CMD.LF);
    push(this._text(this._divider())); push(CMD.LF);
    push(CMD.BOLD_ON); push(this._text('Bold Text')); push(CMD.BOLD_OFF); push(CMD.LF);
    push(CMD.DOUBLE_HEIGHT); push(this._text('Dbl Height')); push(CMD.NORMAL_SIZE); push(CMD.LF);
    push(CMD.DOUBLE_WIDTH); push(this._text('Dbl Width')); push(CMD.NORMAL_SIZE); push(CMD.LF);
    push(CMD.ALIGN_CENTER); push(this._text('Centered')); push(CMD.LF);
    push(CMD.ALIGN_RIGHT);  push(this._text('Right Align')); push(CMD.LF);
    push(CMD.ALIGN_LEFT);
    push(this._text(this._divider())); push(CMD.LF);
    push(this._text('ABCDEFGHIJKLMNOPQRSTUVWXYZ')); push(CMD.LF);
    push(this._text('abcdefghijklmnopqrstuvwxyz')); push(CMD.LF);
    push(this._text('0123456789 !@#$%^&*()')); push(CMD.LF);
    push(this._text(this._divider('='))); push(CMD.LF);
    push(CMD.ALIGN_CENTER);
    push(this._text('Printer OK!')); push(CMD.LF);
    push(CMD.FEED_3);
    push(CMD.CUT_PARTIAL);

    return new Uint8Array(bytes);
  }

  // ─── Send to Printer ───────────────────────────────────────────────────────
  async print(data) {
    if (!this.isConnected) throw new Error('Printer not connected.');
    this.status('Sending to printer…');
    await this.connection.write(data);
    this.status('Print job sent!', 'success');
  }

  async printReceipt(sessionData) {
    const receipt = this.buildReceipt(sessionData);
    await this.print(receipt);
  }

  async printTest() {
    const test = this.buildTestPrint();
    await this.print(test);
  }
}

// ─── End of Day Report Builder ───
  buildEODReport(data) {
    const W = this.chars;
    const bytes = [];
    const push = (...b) => bytes.push(...b.flat());

    push(CMD.INIT);
    push(CMD.CHAR_SPACING_0);
    push(CMD.FONT_A);

    // Header
    push(CMD.ALIGN_CENTER);
    push(CMD.BOLD_ON);
    push(CMD.DOUBLE_BOTH);
    push(this._text(data.shopName || 'STUDYHUB'));
    push(CMD.LF);
    push(CMD.NORMAL_SIZE);
    push(this._text('END OF DAY REPORT'));
    push(CMD.LF);
    push(CMD.BOLD_OFF);
    push(this._text(this._divider('=')));
    push(CMD.LF);

    // Info
    push(CMD.ALIGN_LEFT);
    push(this._text(this._twoCol('Date:', data.date, W))); push(CMD.LF);
    push(this._text(this._twoCol('Time Generated:', data.time, W))); push(CMD.LF);
    push(this._text(this._twoCol('Cashier:', data.cashier || 'Staff', W))); push(CMD.LF);
    push(this._text(this._divider())); push(CMD.LF);

    // Stats
    push(CMD.BOLD_ON);
    push(this._text('TODAY\'S SUMMARY')); push(CMD.LF);
    push(CMD.BOLD_OFF);
    push(this._text(this._twoCol('Total Sessions:', data.totalSessions, W))); push(CMD.LF);
    push(this._text(this._twoCol('Total Hours:', data.totalHours, W))); push(CMD.LF);
    push(this._text(this._divider('='))); push(CMD.LF);

    // Revenue
    push(CMD.ALIGN_CENTER);
    push(CMD.BOLD_ON);
    push(CMD.DOUBLE_HEIGHT);
    push(this._text('TOTAL REVENUE')); push(CMD.LF);
    push(CMD.DOUBLE_BOTH);
    push(this._text('P' + Number(data.totalRevenue || 0).toFixed(2))); push(CMD.LF);
    push(CMD.NORMAL_SIZE);
    push(CMD.BOLD_OFF);

    // Footer
    push(this._text(this._divider('='))); push(CMD.LF);
    push(CMD.ALIGN_CENTER);
    push(this._text('*** END OF REPORT ***')); push(CMD.LF);
    push(CMD.FEED_3);
    push(CMD.CUT_PARTIAL);

    return new Uint8Array(bytes);
  }

  async printEOD(data) {
    const report = this.buildEODReport(data);
    await this.print(report);
  }

// ─── Export global instance ────────────────────────────────────────────────────
window.ThermalPrinter = ThermalPrinter;
window.printer = new ThermalPrinter();

// Add to printReceipt function:
if (window.isWindows && settings.platform === 'windows') {
  // Windows-specific printing logic
  return printViaWindowsBridge(data);
}

// Add Windows bridge printing
async function printViaWindowsBridge(data) {
  const response = await fetch(`http://${settings.lanIp}:${settings.laBridgePort}/print`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(data)
  });
  
  if (!response.ok) throw new Error('Windows bridge error');
  return response.json();
}