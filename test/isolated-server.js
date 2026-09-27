const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const DexileServer = require('../server.js');

async function createIsolatedServer() {
  const transferPath = fs.mkdtempSync(path.join(os.tmpdir(), 'dexile-ws-'));
  const server = new DexileServer(0, { transferPath });
  if (!server.httpServer.listening) await once(server.httpServer, 'listening');
  return server;
}

function removeTransferTree(server) {
  if (!server || !server.fileTransferPath) return;
  try {
    fs.rmSync(server.fileTransferPath, { recursive: true, force: true });
  } catch (error) {
    // Temp trees can still be locked on Windows for a moment after close.
  }
}

module.exports = { createIsolatedServer, removeTransferTree };
