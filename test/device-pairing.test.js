const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const WebSocket = require('ws');
const DexileServer = require('../server.js');

async function createServer() {
  const server = new DexileServer(0);
  if (!server.httpServer.listening) await once(server.httpServer, 'listening');
  return server;
}

async function connect(server) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.httpServer.address().port}`);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return ws;
}

async function authenticate(ws, authCode) {
  ws.send(JSON.stringify({ type: 'auth', code: authCode }));
  return new Promise((resolve) => {
    ws.once('message', (raw) => {
      const data = JSON.parse(raw);
      if (data.type === 'auth_success') resolve(data);
    });
  });
}

async function closeServer(server, sockets) {
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.terminate();
    }
  }
  if (!server.httpServer.listening) return;
  const httpClosed = once(server.httpServer, 'close');
  const websocketClosed = once(server.wss, 'close');
  server.shutdown();
  await Promise.all([httpClosed, websocketClosed]);
}

// ============================================================================
// Tests
// ============================================================================

test('server generates 8-character auth code on startup', { concurrency: false }, async () => {
  const server = await createServer();
  
  try {
    assert.equal(typeof server.authCode, 'string');
    assert.equal(server.authCode.length, 8);
    assert.match(server.authCode, /^[0-9A-F]{8}$/);
  } finally {
    await closeServer(server, []);
  }
});

test('first authenticated client becomes host', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  
  try {
    const ws = await connect(server);
    sockets.push(ws);
    
    const authResponse = await authenticate(ws, server.authCode);
    
    assert.equal(authResponse.type, 'auth_success');
    assert.equal(authResponse.session.role, 'host');
    assert.equal(authResponse.clientId, server.hostClientId);
  } finally {
    await closeServer(server, sockets);
  }
});

test('subsequent clients are assigned client role', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  
  try {
    // First client becomes host
    const host = await connect(server);
    sockets.push(host);
    await authenticate(host, server.authCode);
    
    // Second client should be regular client
    const client = await connect(server);
    sockets.push(client);
    const authResponse = await authenticate(client, server.authCode);
    
    assert.equal(authResponse.session.role, 'client');
    assert.notEqual(authResponse.clientId, server.hostClientId);
  } finally {
    await closeServer(server, sockets);
  }
});

test('host role is reassigned when original host disconnects', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  
  try {
    // First client becomes host
    const host = await connect(server);
    sockets.push(host);
    const hostAuth = await authenticate(host, server.authCode);
    const firstHostId = hostAuth.clientId;
    
    // Second client
    const client = await connect(server);
    sockets.push(client);
    const clientAuth = await authenticate(client, server.authCode);
    assert.equal(clientAuth.session.role, 'client');
    const secondClientId = clientAuth.clientId;
    
    // Host disconnects
    host.close();
    await once(host, 'close');
    
    // Wait for server to process disconnect and reassign host
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // The second client should now be the host (server should have reassigned)
    // Verify by checking server's hostClientId
    assert.equal(server.hostClientId, secondClientId);
    
    // Third client connects - should be regular client since host already exists
    const newClient = await connect(server);
    sockets.push(newClient);
    const newClientAuth = await authenticate(newClient, server.authCode);
    
    assert.equal(newClientAuth.session.role, 'client');
  } finally {
    await closeServer(server, sockets);
  }
});

test('auth code can be regenerated', { concurrency: false }, async () => {
  const server = await createServer();
  const originalCode = server.authCode;
  
  try {
    const newCode = server.regenerateAuthCode();
    
    assert.equal(typeof newCode, 'string');
    assert.equal(newCode.length, 8);
    assert.match(newCode, /^[0-9A-F]{8}$/);
    assert.notEqual(newCode, originalCode);
    assert.equal(server.authCode, newCode);
  } finally {
    await closeServer(server, []);
  }
});

test('old auth code becomes invalid after regeneration', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  const oldCode = server.authCode;
  
  try {
    server.regenerateAuthCode();
    
    const ws = await connect(server);
    sockets.push(ws);
    
    ws.send(JSON.stringify({ type: 'auth', code: oldCode }));
    
    const response = await new Promise((resolve) => {
      ws.once('message', (raw) => resolve(JSON.parse(raw)));
    });
    
    assert.equal(response.type, 'auth_failed');
    assert.match(response.message, /invalid/i);
  } finally {
    await closeServer(server, sockets);
  }
});

test('new auth code works after regeneration', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  
  try {
    const newCode = server.regenerateAuthCode();
    
    const ws = await connect(server);
    sockets.push(ws);
    
    const authResponse = await authenticate(ws, newCode);
    
    assert.equal(authResponse.type, 'auth_success');
  } finally {
    await closeServer(server, sockets);
  }
});

test('the server exposes an auth code and LAN address but no QR or pairing payload', { concurrency: false }, async () => {
  const server = await createServer();
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };

  try {
    server.displayAuthCode();
    assert.equal(typeof server.authCode, 'string');
    assert.equal(server.authCode.length, 8);
    assert.equal(typeof server.getLanAddress(), 'string');

    const banner = lines.join('\n');
    // The code and the LAN address are printed so a person can type them in.
    assert.match(banner, /Auth code:\s+[0-9A-F]{8}/);
    assert.match(banner, /LAN address:/);
    // Nothing offers a shortcut around address + code.
    assert.doesNotMatch(banner, /QR/i);
    assert.doesNotMatch(banner, /pair/i);
    assert.doesNotMatch(banner, /scan/i);

    // The QR dependency is gone from the manifest.
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.equal(Object.prototype.hasOwnProperty.call(manifest.dependencies, 'qrcode'), false);
    const clientHtml = fs.readFileSync(path.join(__dirname, '..', 'client.html'), 'utf8');
    assert.doesNotMatch(clientHtml, /importPairingData|QR Code/i);
    const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.doesNotMatch(serverSource, /require\('qrcode'\)|QRCode\./);
  } finally {
    console.log = originalLog;
    await closeServer(server, []);
  }
});

test('multiple clients can authenticate with same code', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  
  try {
    const ws1 = await connect(server);
    const ws2 = await connect(server);
    const ws3 = await connect(server);
    sockets.push(ws1, ws2, ws3);
    
    const auth1 = await authenticate(ws1, server.authCode);
    const auth2 = await authenticate(ws2, server.authCode);
    const auth3 = await authenticate(ws3, server.authCode);
    
    assert.equal(auth1.type, 'auth_success');
    assert.equal(auth2.type, 'auth_success');
    assert.equal(auth3.type, 'auth_success');
    
    // First is host, others are clients
    assert.equal(auth1.session.role, 'host');
    assert.equal(auth2.session.role, 'client');
    assert.equal(auth3.session.role, 'client');
  } finally {
    await closeServer(server, sockets);
  }
});

test('auth failure increments attempt counter', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  
  try {
    const ws = await connect(server);
    sockets.push(ws);
    
    // First failed attempt
    ws.send(JSON.stringify({ type: 'auth', code: 'WRONGCOD' }));
    const response1 = await new Promise((resolve) => {
      ws.once('message', (raw) => resolve(JSON.parse(raw)));
    });
    
    assert.equal(response1.type, 'auth_failed');
    assert.equal(response1.reason, 'invalid_code');
  } finally {
    await closeServer(server, sockets);
  }
});

test('auth lockout after max attempts', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  
  try {
    const ws = await connect(server);
    sockets.push(ws);
    
    // Make 5 failed attempts (MAX_AUTH_ATTEMPTS)
    for (let i = 0; i < 5; i++) {
      ws.send(JSON.stringify({ type: 'auth', code: 'WRONGCOD' }));
      await new Promise((resolve) => {
        ws.once('message', () => resolve());
      });
    }
    
    // 6th attempt should be locked
    ws.send(JSON.stringify({ type: 'auth', code: 'WRONGCOD' }));
    const lockedResponse = await new Promise((resolve) => {
      ws.once('message', (raw) => resolve(JSON.parse(raw)));
    });
    
    assert.equal(lockedResponse.type, 'auth_failed');
    assert.equal(lockedResponse.reason, 'locked');
    assert.match(lockedResponse.message, /too many attempts/i);
  } finally {
    await closeServer(server, sockets);
  }
});

test('successful auth clears failed attempt counter', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  
  try {
    const ws = await connect(server);
    sockets.push(ws);
    
    // Failed attempt
    ws.send(JSON.stringify({ type: 'auth', code: 'WRONGCOD' }));
    await new Promise((resolve) => {
      ws.once('message', () => resolve());
    });
    
    // Successful auth should clear counter
    const authResponse = await authenticate(ws, server.authCode);
    assert.equal(authResponse.type, 'auth_success');
    
    // Disconnect and try with wrong code again - counter should be reset
    ws.close();
    await once(ws, 'close');
    
    const ws2 = await connect(server);
    sockets.push(ws2);
    
    ws2.send(JSON.stringify({ type: 'auth', code: 'WRONGCOD' }));
    const response = await new Promise((resolve) => {
      ws2.once('message', (raw) => resolve(JSON.parse(raw)));
    });
    
    // Should not be locked since previous successful auth cleared the counter
    assert.equal(response.reason, 'invalid_code');
    assert.notEqual(response.reason, 'locked');
  } finally {
    await closeServer(server, sockets);
  }
});
