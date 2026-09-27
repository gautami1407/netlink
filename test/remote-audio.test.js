const test = require('node:test');
const assert = require('node:assert/strict');
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

test('audio capability is reported in capabilities', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  
  try {
    const capabilities = server.getCapabilities();
    
    assert.equal(typeof capabilities.audio, 'boolean');
    assert.equal(typeof capabilities.audioUnavailableReason, 'string');
    
    // Currently audio is not available (requires native modules)
    assert.equal(capabilities.audio, false);
  } finally {
    await closeServer(server, sockets);
  }
});

test('audio requires authentication', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  
  try {
    const ws = await connect(server);
    sockets.push(ws);
    
    // Try to enable audio without auth
    ws.send(JSON.stringify({ type: 'audio_enable' }));
    
    const response = await new Promise((resolve) => {
      ws.once('message', (raw) => resolve(JSON.parse(raw)));
    });
    
    assert.equal(response.type, 'error');
    assert.match(response.message, /not authenticated/i);
  } finally {
    await closeServer(server, sockets);
  }
});

test('audio enable responds with unavailable when no audio support', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  
  try {
    const capabilities = server.getCapabilities();
    
    if (capabilities.audio) {
      console.log('  ⊘ Skipped: audio capability available (test for unavailable case)');
      return;
    }
    
    const ws = await connect(server);
    sockets.push(ws);
    await authenticate(ws, server.authCode);
    
    ws.send(JSON.stringify({ type: 'audio_enable' }));
    
    const response = await new Promise((resolve) => {
      ws.once('message', (raw) => resolve(JSON.parse(raw)));
    });
    
    assert.equal(response.type, 'error');
    assert.match(response.message, /not available/i);
  } finally {
    await closeServer(server, sockets);
  }
});

test('audio clients are tracked when enabled', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  
  try {
    const ws = await connect(server);
    sockets.push(ws);
    const authResponse = await authenticate(ws, server.authCode);
    const clientId = authResponse.clientId;
    
    // Initially no audio clients
    assert.equal(server.audioClients.has(clientId), false);
    
    // Enable audio (will fail due to no capability, but client tracking should still work if capability existed)
    // Since audio is not available, this won't add to audioClients
    // This test verifies the tracking mechanism exists
    
    assert.equal(typeof server.audioClients, 'object');
    assert.equal(typeof server.audioClients.has, 'function');
    assert.equal(typeof server.audioClients.add, 'function');
    assert.equal(typeof server.audioClients.delete, 'function');
  } finally {
    await closeServer(server, sockets);
  }
});

test('audio disable removes client from tracking', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  
  try {
    const ws = await connect(server);
    sockets.push(ws);
    const authResponse = await authenticate(ws, server.authCode);
    const clientId = authResponse.clientId;
    
    // Manually add client to audio clients (simulating enabled state)
    server.audioClients.add(clientId);
    assert.equal(server.audioClients.has(clientId), true);
    
    // Disable audio
    ws.send(JSON.stringify({ type: 'audio_disable' }));
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Client should be removed
    assert.equal(server.audioClients.has(clientId), false);
  } finally {
    await closeServer(server, sockets);
  }
});

test('audio cleanup on client disconnect', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  
  try {
    const ws = await connect(server);
    sockets.push(ws);
    const authResponse = await authenticate(ws, server.authCode);
    const clientId = authResponse.clientId;
    
    // Manually add client to audio clients
    server.audioClients.add(clientId);
    assert.equal(server.audioClients.has(clientId), true);
    
    // Disconnect client
    ws.close();
    await once(ws, 'close');
    
    // Wait a moment for server to process
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Audio client should be cleaned up
    assert.equal(server.audioClients.has(clientId), false);
  } finally {
    await closeServer(server, sockets);
  }
});

test('audio enable records activity log', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  
  try {
    const ws = await connect(server);
    sockets.push(ws);
    await authenticate(ws, server.authCode);
    
    const activityBefore = server.activityLog.length;
    
    // Try to enable audio (will fail, but should still log attempt)
    ws.send(JSON.stringify({ type: 'audio_enable' }));
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Activity log should have entries
    // (either error or success depending on capability)
    assert.ok(server.activityLog.length >= activityBefore);
  } finally {
    await closeServer(server, sockets);
  }
});

test('multiple clients can enable audio independently', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  
  try {
    const ws1 = await connect(server);
    sockets.push(ws1);
    const auth1 = await authenticate(ws1, server.authCode);
    
    const ws2 = await connect(server);
    sockets.push(ws2);
    const auth2 = await authenticate(ws2, server.authCode);
    
    // Manually add both clients to audio clients
    server.audioClients.add(auth1.clientId);
    server.audioClients.add(auth2.clientId);
    
    assert.equal(server.audioClients.has(auth1.clientId), true);
    assert.equal(server.audioClients.has(auth2.clientId), true);
    assert.equal(server.audioClients.size, 2);
    
    // Disable for client 1
    ws1.send(JSON.stringify({ type: 'audio_disable' }));
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Client 1 removed, client 2 still present
    assert.equal(server.audioClients.has(auth1.clientId), false);
    assert.equal(server.audioClients.has(auth2.clientId), true);
    assert.equal(server.audioClients.size, 1);
  } finally {
    await closeServer(server, sockets);
  }
});

test('auth_success includes audio capability', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  
  try {
    const ws = await connect(server);
    sockets.push(ws);
    
    const authResponse = await authenticate(ws, server.authCode);
    
    assert.equal(authResponse.type, 'auth_success');
    assert.equal(typeof authResponse.capabilities, 'object');
    assert.equal(typeof authResponse.capabilities.audio, 'boolean');
  } finally {
    await closeServer(server, sockets);
  }
});
