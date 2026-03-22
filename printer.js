/**
 * StudyHub Thermal Printer Engine v2
 * Supports: WebUSB (Android/Windows Chrome) · Web Bluetooth (Android) · LAN TCP (Windows/Android via bridge)
 * Paper: 58mm (32 chars) · 80mm (48 chars)
 * Protocol: ESC/POS (Epson-compatible)
 */

const ESC = 0x1B, GS = 0x1D;

const CMD = {
  INIT:          [ESC, 0x40],
  ALIGN_LEFT:    [ESC, 0x61, 0x00],
  ALIGN_CENTER:  [ESC, 0x61, 0x01],
  ALIGN_RIGHT:   [ESC, 0x61, 0x02],
  BOLD_ON:       [ESC, 0x45, 0x01],
  BOLD_OFF:      [ESC, 0x45, 0x00],
  DOUBLE_HEIGHT: [ESC, 0x21, 0x10],
  DOUBLE_WIDTH:  [ESC, 0x21, 0x20],
  DOUBLE_BOTH:   [ESC, 0x21, 0x30],
  NORMAL_SIZE:   [ESC, 0x21, 0x00],
  UNDERLINE_ON:  [ESC, 0x2D, 0x01],
  UNDERLINE_OFF: [ESC, 0x2D, 0x00],
  FONT_A:        [ESC, 0x4D, 0x00],
  FONT_B:        [ESC, 0x4D, 0x01],
  LF:            [0x0A],
  FEED_1:        [ESC, 0x64, 0x01],
  FEED_2:        [ESC, 0x64, 0x02],
  FEED_3:        [ESC, 0x64, 0x03],
  CUT_FULL:      [GS,  0x56, 0x00],
  CUT_PARTIAL:   [GS,  0x56, 0x01],
  CHAR_SPACING_0:[ESC, 0x20, 0x00],
};

const BT_SERVICE_UUIDS = [
  '000018f0-0000-1000-8000-00805f9b34fb',
  '0000ffe0-0000-1000-8000-00805f9b34fb',
  '00001101-0000-1000-8000-00805f9b34fb',
  '0000ff00-0000-1000-8000-00805f9b34fb',
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',
];
const BT_CHAR_UUIDS = [
  '00002af1-0000-1000-8000-00805f9b34fb',
  '0000ffe1-0000-1000-8000-00805f9b34fb',
  '0000ff02-0000-1000-8000-00805f9b34fb',
  '49535343-8841-43f4-a8d4-ecbe34729bb3',
];

class ThermalPrinter {
  constructor() {
    this.connection = null;
    this.paperWidth = 80;
    this.chars = 48;
    this.printerName = '';
    this.onStatus = null;
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

  // ── USB via WebUSB ────────────────────────────────────────────────────────
  async connectUSB() {
    if (!navigator.usb) {
      throw new Error('WebUSB not supported. Use Google Chrome browser (not Firefox or Safari).');
    }
    this.status('Requesting USB printer…');
    let device;
    try {
      device = await navigator.usb.requestDevice({ filters: [] });
    } catch (e) {
      if (e.name === 'NotFoundError') throw new Error('No USB device selected. Please connect your printer and try again.');
      throw e;
    }
    await device.open();
    if (device.configuration === null) await device.selectConfiguration(1);

    let iface = null, endpoint = null;
    outer:
    for (const cfg of device.configurations) {
      for (const inf of cfg.interfaces) {
        for (const alt of inf.alternates) {
          for (const ep of alt.endpoints) {
            if (ep.direction === 'out') { iface = inf; endpoint = ep; break outer; }
          }
        }
      }
    }
    if (!endpoint) throw new Error('No output endpoint found. Make sure this is a printer device.');
    await device.claimInterface(iface.interfaceNumber);

    const epNum = endpoint.endpointNumber;
    this.printerName = device.productName || 'USB Printer';
    this.connection = {
      type: 'USB', device,
      iface: iface.interfaceNumber,
      write: async (data) => {
        const CHUNK = 64;
        for (let i = 0; i < data.length; i += CHUNK) {
          await device.transferOut(epNum, data.slice(i, i + CHUNK));
        }
      }
    };
    this.status(`USB connected: ${this.printerName}`, 'success');
    if (this.onConnected) this.onConnected('USB', this.printerName);
  }

  // ── Bluetooth ─────────────────────────────────────────────────────────────
  async connectBluetooth() {
    if (!navigator.bluetooth) {
      throw new Error('Web Bluetooth not supported. Enable it in Chrome flags or use Chrome on Android.');
    }
    this.status('Scanning for Bluetooth printers…');
    let device, characteristic;

    for (const svcUUID of BT_SERVICE_UUIDS) {
      try {
        device = await navigator.bluetooth.requestDevice({
          filters: [{ services: [svcUUID] }],
          optionalServices: BT_SERVICE_UUIDS,
        });
        break;
      } catch (e) {
        if (e.name === 'NotFoundError') continue;
        if (e.name === 'SecurityError') throw new Error('Bluetooth permission denied.');
        if (e.message?.includes('cancel')) throw new Error('Bluetooth scan cancelled.');
      }
    }

    if (!device) {
      device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: BT_SERVICE_UUIDS,
      }).catch(() => { throw new Error('No Bluetooth printer found or scan was cancelled.'); });
    }

    this.status(`Connecting to ${device.name || 'BT device'}…`);
    const server = await device.gatt.connect();
    const services = await server.getPrimaryServices();
    for (const svc of services) {
      const chars = await svc.getCharacteristics();
      for (const ch of chars) {
        if (ch.properties.write || ch.properties.writeWithoutResponse) { characteristic = ch; break; }
      }
      if (characteristic) break;
    }
    if (!characteristic) throw new Error('No writable characteristic found. Make sure this is a thermal printer.');

    device.addEventListener('gattserverdisconnected', () => {
      this.connection = null;
      this.status('Bluetooth printer disconnected', 'warn');
      if (this.onDisconnected) this.onDisconnected();
    });

    const useResponse = characteristic.properties.write;
    this.printerName = device.name || 'BT Printer';
    this.connection = {
      type: 'Bluetooth', device,
      write: async (data) => {
        const CHUNK = 20;
        for (let i = 0; i < data.length; i += CHUNK) {
          const chunk = data.slice(i, i + CHUNK);
          if (useResponse) await characteristic.writeValue(chunk);
          else await characteristic.writeValueWithoutResponse(chunk);
          await new Promise(r => setTimeout(r, 30));
        }
      }
    };
    this.status(`Bluetooth connected: ${this.printerName}`, 'success');
    if (this.onConnected) this.onConnected('Bluetooth', this.printerName);
  }

  // ── LAN via WebSocket bridge ──────────────────────────────────────────────
  async connectLAN(ip, port = 9100, wsPort = 8765) {
    if (!ip) throw new Error('Please enter the printer IP address.');
    this.status(`Connecting to printer at ${ip}:${port}…`);
    return new Promise((resolve, reject) => {
      const wsUrl = `ws://${ip}:${wsPort}`;
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`Connection timed out. Make sure:\n1. The bridge (ws-bridge.js) is running on the PC\n2. IP address is correct: ${ip}\n3. Both devices are on the same WiFi`));
      }, 6000);

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'connect', host: ip, port }));
      };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.status === 'ready') {
            clearTimeout(timer);
            this.printerName = `LAN ${ip}:${port}`;
            this.connection = {
              type: 'LAN', ip, port, ws,
              write: async (data) => { ws.send(data); }
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
            clearTimeout(timer);
            reject(new Error(msg.message || 'LAN printer connection failed'));
          }
        } catch {}
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`Cannot reach printer bridge at ${wsUrl}.\nMake sure ws-bridge.js is running on the PC.`));
      };
    });
  }

  // ── Disconnect ────────────────────────────────────────────────────────────
  async disconnect() {
    if (!this.connection) return;
    try {
      if (this.connection.type === 'USB') {
        await this.connection.device.releaseInterface(this.connection.iface);
        await this.connection.device.close();
      } else if (this.connection.type === 'Bluetooth') {
        this.connection.device.gatt.disconnect();
      } else if (this.connection.type === 'LAN') {
        this.connection.ws.close();
      }
    } catch {}
    this.connection = null;
    this.printerName = '';
    this.status('Printer disconnected');
    if (this.onDisconnected) this.onDisconnected();
  }

  // ── ESC/POS helpers ───────────────────────────────────────────────────────
  _encode(str) {
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
  _pad(str, width, align = 'left', fill = ' ') {
    str = String(str || '');
    if (str.length > width) str = str.slice(0, width);
    const pad = fill.repeat(Math.max(0, width - str.length));
    return align === 'right' ? pad + str : align === 'center' ? ' '.repeat(Math.floor((width - str.length) / 2)) + str + ' '.repeat(Math.ceil((width - str.length) / 2)) : str + pad;
  }
  _twoCol(left, right, width) {
    const rLen = String(right).length;
    return this._pad(left, width - rLen - 1, 'left') + ' ' + this._pad(right, rLen, 'right');
  }
  _divider(char = '-') { return char.repeat(this.chars); }

  // ── Receipt Builder ───────────────────────────────────────────────────────
  buildReceipt(data) {
    const W = this.chars;
    const bytes = [];
    const push = (...b) => bytes.push(...b.flat());

    push(CMD.INIT, CMD.CHAR_SPACING_0, CMD.FONT_A);
    push(CMD.ALIGN_CENTER, CMD.BOLD_ON, CMD.DOUBLE_BOTH);
    push(this._text(data.shopName || 'STUDYHUB'));
    push(CMD.LF, CMD.NORMAL_SIZE, CMD.BOLD_OFF);
    if (data.shopTagline) { push(this._text(data.shopTagline)); push(CMD.LF); }
    if (data.shopAddress) { push(this._text(data.shopAddress)); push(CMD.LF); }
    if (data.shopPhone) { push(this._text('Tel: ' + data.shopPhone)); push(CMD.LF); }
    push(CMD.FEED_1, CMD.ALIGN_CENTER, CMD.BOLD_ON);
    push(this._text('OFFICIAL RECEIPT'));
    push(CMD.BOLD_OFF, CMD.LF);
    push(this._text(this._divider('='))); push(CMD.LF);

    push(CMD.ALIGN_LEFT);
    push(this._text(this._twoCol('Receipt #:', data.receiptNo || '—', W))); push(CMD.LF);
    push(this._text(this._twoCol('Date:', data.date || '—', W))); push(CMD.LF);
    push(this._text(this._twoCol('Time:', data.time || '—', W))); push(CMD.LF);
    push(this._text(this._twoCol('Cashier:', data.cashier || 'Staff', W))); push(CMD.LF);
    push(this._text(this._divider())); push(CMD.LF);

    push(CMD.BOLD_ON); push(this._text('SEAT DETAILS')); push(CMD.LF, CMD.BOLD_OFF);
    push(this._text(this._twoCol('Seat:', data.seat || '—', W))); push(CMD.LF);
    push(this._text(this._twoCol('Customer:', data.customer || '—', W))); push(CMD.LF);
    push(this._text(this._twoCol('Duration:', data.duration || '—', W))); push(CMD.LF);
    push(this._text(this._divider())); push(CMD.LF);

    push(CMD.BOLD_ON); push(this._text('CHARGES')); push(CMD.LF, CMD.BOLD_OFF);
    push(this._text(this._twoCol('Original Bill:', 'P' + Number(data.originalBill || 0).toFixed(2), W))); push(CMD.LF);
    if (data.discount > 0) { push(this._text(this._twoCol('Discount:', '-P' + Number(data.discount).toFixed(2), W))); push(CMD.LF); }
    push(this._text(this._twoCol('Payment:', data.paymentType || '—', W))); push(CMD.LF);
    push(this._text(this._divider('='))); push(CMD.LF);

    push(CMD.ALIGN_CENTER, CMD.BOLD_ON, CMD.DOUBLE_HEIGHT);
    push(this._text('TOTAL AMOUNT')); push(CMD.LF);
    push(CMD.DOUBLE_BOTH);
    push(this._text('P' + Number(data.total || 0).toFixed(2))); push(CMD.LF);
    push(CMD.NORMAL_SIZE, CMD.BOLD_OFF);

    if (data.paymentType === 'Cash' || data.amountReceived > 0) {
      push(CMD.ALIGN_LEFT);
      push(this._text(this._twoCol('Amount Received:', 'P' + Number(data.amountReceived || 0).toFixed(2), W))); push(CMD.LF);
      push(this._text(this._twoCol('Change:', 'P' + Number(data.change || 0).toFixed(2), W))); push(CMD.LF);
    }

    push(this._text(this._divider('='))); push(CMD.LF);
    push(CMD.ALIGN_CENTER);
    if (data.footerNote) { push(this._text(data.footerNote)); push(CMD.LF); }
    push(this._text('Thank you for using StudyHub!')); push(CMD.LF);
    push(CMD.FEED_3, CMD.CUT_PARTIAL);

    return new Uint8Array(bytes);
  }

  // ── EOD Report Builder ────────────────────────────────────────────────────
  buildEODReport(data) {
    const W = this.chars;
    const bytes = [];
    const push = (...b) => bytes.push(...b.flat());

    push(CMD.INIT, CMD.ALIGN_CENTER, CMD.BOLD_ON, CMD.DOUBLE_BOTH);
    push(this._text(data.shopName || 'STUDYHUB'));
    push(CMD.LF, CMD.NORMAL_SIZE);
    push(this._text('END OF DAY REPORT'));
    push(CMD.LF, CMD.BOLD_OFF);
    push(this._text(this._divider('='))); push(CMD.LF);

    push(CMD.ALIGN_LEFT);
    push(this._text(this._twoCol('Date:', data.date, W))); push(CMD.LF);
    push(this._text(this._twoCol('Time:', data.time, W))); push(CMD.LF);
    push(this._text(this._twoCol('Cashier:', data.cashier || 'Staff', W))); push(CMD.LF);
    push(this._text(this._divider())); push(CMD.LF);

    push(CMD.BOLD_ON); push(this._text("TODAY'S SUMMARY")); push(CMD.LF, CMD.BOLD_OFF);
    push(this._text(this._twoCol('Total Sessions:', data.totalSessions, W))); push(CMD.LF);
    push(this._text(this._twoCol('Total Hours:', data.totalHours, W))); push(CMD.LF);
    push(this._text(this._divider('='))); push(CMD.LF);

    push(CMD.ALIGN_CENTER, CMD.BOLD_ON, CMD.DOUBLE_HEIGHT);
    push(this._text('TOTAL REVENUE')); push(CMD.LF);
    push(CMD.DOUBLE_BOTH);
    push(this._text('P' + Number(data.totalRevenue || 0).toFixed(2))); push(CMD.LF);
    push(CMD.NORMAL_SIZE, CMD.BOLD_OFF);
    push(this._text(this._divider('='))); push(CMD.LF);
    push(CMD.ALIGN_CENTER);
    push(this._text('*** END OF REPORT ***')); push(CMD.LF);
    push(CMD.FEED_3, CMD.CUT_PARTIAL);

    return new Uint8Array(bytes);
  }

  // ── Test Print Builder ────────────────────────────────────────────────────
  buildTestPrint() {
    const W = this.chars;
    const bytes = [];
    const push = (...b) => bytes.push(...b.flat());

    push(CMD.INIT, CMD.ALIGN_CENTER, CMD.BOLD_ON, CMD.DOUBLE_BOTH);
    push(this._text('STUDYHUB')); push(CMD.LF);
    push(CMD.NORMAL_SIZE, CMD.BOLD_OFF);
    push(this._text('Printer Test Page')); push(CMD.LF);
    push(this._text(this._divider('='))); push(CMD.LF);
    push(CMD.ALIGN_LEFT);
    push(this._text(`Paper: ${this.paperWidth}mm | Chars: ${this.chars}`)); push(CMD.LF);
    push(this._text(`Connection: ${this.connType || 'Unknown'}`)); push(CMD.LF);
    push(this._text(`Time: ${new Date().toLocaleString('en-PH')}`)); push(CMD.LF);
    push(this._text(this._divider())); push(CMD.LF);
    push(CMD.BOLD_ON); push(this._text('Bold Text')); push(CMD.BOLD_OFF); push(CMD.LF);
    push(CMD.DOUBLE_HEIGHT); push(this._text('Double Height')); push(CMD.NORMAL_SIZE); push(CMD.LF);
    push(CMD.ALIGN_CENTER); push(this._text('Centered Text')); push(CMD.LF);
    push(CMD.ALIGN_LEFT);
    push(this._text(this._divider('='))); push(CMD.LF);
    push(CMD.ALIGN_CENTER);
    push(CMD.BOLD_ON); push(this._text('Printer OK!')); push(CMD.BOLD_OFF); push(CMD.LF);
    push(CMD.FEED_3, CMD.CUT_PARTIAL);

    return new Uint8Array(bytes);
  }

  // ── Send to Printer ───────────────────────────────────────────────────────
  async print(data) {
    if (!this.isConnected) throw new Error('Printer not connected.');
    this.status('Sending to printer…');
    await this.connection.write(data);
    this.status('Print sent!', 'success');
  }

  async printReceipt(data) { await this.print(this.buildReceipt(data)); }
  async printTest() { await this.print(this.buildTestPrint()); }
  async printEOD(data) { await this.print(this.buildEODReport(data)); }
}

window.ThermalPrinter = ThermalPrinter;
window.printer = new ThermalPrinter();
