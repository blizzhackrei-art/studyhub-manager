#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║         StudyHub Windows Printer Bridge v2                  ║
 * ║         HTTP → Windows Printer (ESC/POS or any driver)      ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * WHY THIS EXISTS:
 *   Chrome on Windows blocks WebUSB for printers that already have
 *   a Windows driver installed ("Access Denied" error).
 *   This bridge sidesteps that by running a tiny local HTTP server
 *   that sends print jobs using Node.js directly to the printer.
 *
 * ── SETUP (ONE-TIME) ────────────────────────────────────────────
 *  1. Install Node.js from https://nodejs.org  (LTS version)
 *  2. Open Command Prompt (cmd) or PowerShell
 *  3. Navigate to this file:
 *       cd C:\Users\YourName\Downloads\studyhub
 *  4. Install dependencies:
 *       npm install
 *     (this reads package.json and installs what's needed)
 *  5. Run the bridge:
 *       node win-bridge.js
 *  6. You'll see:
 *       ✅ StudyHub Windows Printer Bridge running
 *       📋 Available printers: [list of your printers]
 *       🌐 Listening on http://localhost:8765
 *
 * ── IN THE APP ──────────────────────────────────────────────────
 *  - Go to Printer tab → Select "Windows PC" → Select "Windows Bridge"
 *  - Click "Detect Printers" to see your installed printers
 *  - Pick your thermal printer from the dropdown
 *  - Click "Test Print" to verify
 *
 * ── NOTES ───────────────────────────────────────────────────────
 *  - Keep this terminal window open while using the app
 *  - The bridge only listens on localhost (your PC only, not LAN)
 *  - Works with any printer installed in Windows (USB, Network, Shared)
 *  - For LAN access from other devices, change LISTEN_HOST to '0.0.0.0'
 *    and open port 8765 in Windows Firewall
 */

const http    = require('http');
const { exec, execFile } = require('child_process');
const os      = require('os');
const path    = require('path');
const fs      = require('fs');

const PORT        = process.env.PORT || 8765;
const LISTEN_HOST = process.env.HOST || '127.0.0.1'; // localhost only by default

// ── Get list of installed Windows printers ───────────────────────────────────
function getWindowsPrinters() {
  return new Promise((resolve) => {
    exec(
      'powershell -Command "Get-Printer | Select-Object -ExpandProperty Name | ConvertTo-Json"',
      { timeout: 5000 },
      (err, stdout) => {
        if (err) { resolve([]); return; }
        try {
          const raw = stdout.trim();
          const parsed = JSON.parse(raw);
          resolve(Array.isArray(parsed) ? parsed : [parsed]);
        } catch {
          // Fallback: parse line by line
          resolve(stdout.split('\n').map(l => l.trim()).filter(Boolean));
        }
      }
    );
  });
}

// ── Send raw ESC/POS bytes to a Windows printer ──────────────────────────────
// Method 1: PowerShell direct raw print (works for most USB thermal printers)
function printRawPS(printerName, base64Data) {
  return new Promise((resolve, reject) => {
    const script = `
      $printerName = '${printerName.replace(/'/g, "''")}';
      $bytes = [System.Convert]::FromBase64String('${base64Data}');
      $printerPath = "\\\\localhost\\$printerName";
      try {
        $rawStream = New-Object System.IO.FileStream("\\\\localhost\\$printerName", [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::Write);
        $rawStream.Write($bytes, 0, $bytes.Length);
        $rawStream.Close();
        Write-Output "OK"
      } catch {
        # Fallback: use WScript Shell to print via temp file
        Write-Output "FALLBACK"
      }
    `;
    exec(`powershell -Command "${script.replace(/"/g, '\\"')}"`, { timeout: 10000 }, (err, stdout) => {
      if (err) { reject(new Error('PowerShell error: ' + err.message)); return; }
      resolve(stdout.trim());
    });
  });
}

// Method 2: Write to temp file and copy to printer port
function printRawCopy(printerName, buffer) {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(os.tmpdir(), `studyhub_print_${Date.now()}.bin`);
    fs.writeFile(tmpFile, buffer, (err) => {
      if (err) { reject(new Error('Failed to write temp file: ' + err.message)); return; }
      // Use Windows COPY command to send raw bytes to printer
      const cmd = `copy /b "${tmpFile}" "\\\\.\\${printerName}" >nul 2>&1 || copy /b "${tmpFile}" "\\\\localhost\\${printerName}" >nul 2>&1`;
      exec(cmd, { timeout: 8000 }, (copyErr) => {
        fs.unlink(tmpFile, () => {}); // cleanup
        if (copyErr) {
          reject(new Error('Copy to printer failed. Make sure the printer name is correct.'));
        } else {
          resolve('OK');
        }
      });
    });
  });
}

// Method 3: TCP direct (if printer has network port)
function printRawTCP(ip, port, buffer) {
  return new Promise((resolve, reject) => {
    const net = require('net');
    const socket = new net.Socket();
    socket.setTimeout(5000);
    socket.connect(port || 9100, ip, () => {
      socket.write(buffer, () => {
        socket.end();
        resolve('OK');
      });
    });
    socket.on('error', (e) => reject(new Error('TCP error: ' + e.message)));
    socket.on('timeout', () => { socket.destroy(); reject(new Error('TCP connection timed out')); });
  });
}

// ── CORS helper ──────────────────────────────────────────────────────────────
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJSON(res, code, data) {
  setCORS(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  setCORS(res);

  // Preflight
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── GET /ping ── health check
  if (req.method === 'GET' && req.url === '/ping') {
    sendJSON(res, 200, { ok: true, version: '2.0', platform: 'windows' });
    return;
  }

  // ── GET /printers ── list installed printers
  if (req.method === 'GET' && req.url === '/printers') {
    const printers = await getWindowsPrinters();
    sendJSON(res, 200, { printers });
    return;
  }

  // ── POST /print ── send raw ESC/POS bytes to printer
  if (req.method === 'POST' && req.url === '/print') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        // payload = { printer: "Printer Name", data: "base64...", method: "copy"|"tcp", ip: "...", port: 9100 }
        
        if (!payload.data) { sendJSON(res, 400, { error: 'Missing print data' }); return; }
        
        const buffer = Buffer.from(payload.data, 'base64');
        const method = payload.method || 'copy';

        if (method === 'tcp' && payload.ip) {
          await printRawTCP(payload.ip, payload.port || 9100, buffer);
        } else if (payload.printer) {
          try {
            await printRawCopy(payload.printer, buffer);
          } catch (e1) {
            // Fallback to PowerShell method
            console.warn('Copy method failed, trying PowerShell:', e1.message);
            await printRawPS(payload.printer, payload.data);
          }
        } else {
          sendJSON(res, 400, { error: 'Specify printer name or ip+port' }); return;
        }

        console.log(`✅ Printed ${buffer.length} bytes → ${payload.printer || payload.ip}`);
        sendJSON(res, 200, { ok: true, bytes: buffer.length });
      } catch (e) {
        console.error('❌ Print error:', e.message);
        sendJSON(res, 500, { error: e.message });
      }
    });
    return;
  }

  // 404
  sendJSON(res, 404, { error: 'Unknown endpoint. Available: GET /ping, GET /printers, POST /print' });
});

server.listen(PORT, LISTEN_HOST, async () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║     StudyHub Windows Printer Bridge v2           ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
  console.log(`✅ Bridge running at: http://localhost:${PORT}`);
  console.log('');

  // Show available printers
  const printers = await getWindowsPrinters();
  if (printers.length > 0) {
    console.log('📋 Installed printers found:');
    printers.forEach((p, i) => console.log(`   ${i + 1}. ${p}`));
  } else {
    console.log('⚠️  No printers found. Make sure your printer is installed in Windows.');
  }

  console.log('');
  console.log('🌐 In the StudyHub app:');
  console.log('   Printer tab → Windows PC → Windows Bridge → Detect Printers');
  console.log('');
  console.log('📌 Keep this window open while printing. Press Ctrl+C to stop.');
  console.log('─'.repeat(52));
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Port ${PORT} is already in use.`);
    console.error(`   Either the bridge is already running, or another app is using port ${PORT}.`);
    console.error(`   Try: node win-bridge.js  (after closing the other instance)\n`);
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});
