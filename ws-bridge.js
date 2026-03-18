#!/usr/bin/env node
/**
 * StudyHub LAN Printer Bridge
 * ────────────────────────────
 * This tiny Node.js script bridges WebSocket (from the browser PWA)
 * to TCP port 9100 on your LAN thermal printer.
 *
 * SETUP (one-time, on a PC or Raspberry Pi on the same WiFi):
 *   1. Install Node.js: https://nodejs.org
 *   2. npm install ws
 *   3. node ws-bridge.js
 *
 * The bridge listens on port 8765 by default.
 * Your Android phone/tablet must be on the same WiFi network.
 *
 * In the StudyHub app → Settings → Printer → LAN:
 *   IP Address: your printer's IP (e.g. 192.168.1.100)
 *   Printer Port: 9100 (default for most thermal printers)
 *   Bridge IP: the IP of this PC (e.g. 192.168.1.50)
 *   Bridge Port: 8765
 */

const WebSocket = require('ws');
const net = require('net');

const WS_PORT = process.env.WS_PORT || 8765;
const wss = new WebSocket.Server({ port: WS_PORT });

console.log(`\n🖨️  StudyHub LAN Printer Bridge`);
console.log(`📡 WebSocket listening on ws://0.0.0.0:${WS_PORT}`);
console.log(`\nOpen StudyHub → Settings → Printer → LAN`);
console.log(`Enter this machine's IP and port ${WS_PORT}\n`);

wss.on('connection', (ws) => {
  console.log('Browser connected to bridge');
  let tcpSocket = null;
  let ready = false;

  ws.on('message', (msg) => {
    // First message is JSON config
    if (!ready) {
      try {
        const cfg = JSON.parse(msg.toString());
        if (cfg.type === 'connect') {
          console.log(`Connecting to printer at ${cfg.host}:${cfg.port}…`);
          tcpSocket = new net.Socket();
          tcpSocket.setTimeout(4000);

          tcpSocket.connect(cfg.port, cfg.host, () => {
            ready = true;
            console.log(`✅ TCP connected to ${cfg.host}:${cfg.port}`);
            ws.send(JSON.stringify({ status: 'ready' }));
          });

          tcpSocket.on('error', (err) => {
            console.error('TCP error:', err.message);
            ws.send(JSON.stringify({ status: 'error', message: err.message }));
            ws.close();
          });

          tcpSocket.on('timeout', () => {
            tcpSocket.destroy();
            ws.send(JSON.stringify({ status: 'error', message: 'TCP connection timed out' }));
            ws.close();
          });

          tcpSocket.on('close', () => {
            ready = false;
            ws.close();
          });
        }
      } catch (e) {
        console.error('Bridge parse error:', e);
      }
      return;
    }

    // Subsequent messages are raw ESC/POS bytes → forward to printer
    if (tcpSocket && ready) {
      const buf = Buffer.isBuffer(msg) ? msg : Buffer.from(msg);
      tcpSocket.write(buf, (err) => {
        if (err) console.error('TCP write error:', err.message);
        else process.stdout.write('.');
      });
    }
  });

  ws.on('close', () => {
    console.log('\nBrowser disconnected');
    if (tcpSocket) { tcpSocket.destroy(); tcpSocket = null; }
  });
});
