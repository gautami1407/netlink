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

test('server responds to ping with pong', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  
  try {
    const ws = await connect(server);
    sockets.push(ws);
    await authenticate(ws, server.authCode);
    
    ws.send(JSON.stringify({ type: 'ping' }));
    
    const response = await new Promise((resolve) => {
      const handler = (raw) => {
        const data = JSON.parse(raw);
        if (data.type === 'pong') {
          resolve(data);
        } else {
          ws.once('message', handler);
        }
      };
      ws.once('message', handler);
    });
    
    assert.equal(response.type, 'pong');
  } finally {
    await closeServer(server, sockets);
  }
});

test('ping does not require authentication', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  
  try {
    const ws = await connect(server);
    sockets.push(ws);
    
    // Send ping without auth
    ws.send(JSON.stringify({ type: 'ping' }));
    
    const response = await new Promise((resolve) => {
      ws.once('message', (raw) => resolve(JSON.parse(raw)));
    });
    
    // Should get pong back (ping/pong typically don't require auth for health checks)
    assert.equal(response.type, 'pong');
  } finally {
    await closeServer(server, sockets);
  }
});

test('server activity log exists and is accessible', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  
  try {
    assert.ok(Array.isArray(server.activityLog));
    assert.equal(typeof server.activityLog.length, 'number');
  } finally {
    await closeServer(server, sockets);
  }
});

test('activity log records connection events', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  
  try {
    const activityBefore = server.activityLog.length;
    
    const ws = await connect(server);
    sockets.push(ws);
    await authenticate(ws, server.authCode);
    
    // Wait for activity to be recorded
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Should have recorded auth activity
    assert.ok(server.activityLog.length > activityBefore);
    
    const recentActivity = server.activityLog.slice(activityBefore);
    const hasAuthActivity = recentActivity.some(a => 
      a.message && a.message.toLowerCase().includes('auth')
    );
    assert.ok(hasAuthActivity);
  } finally {
    await closeServer(server, sockets);
  }
});

test('server telemetry includes uptime', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  
  try {
    assert.equal(typeof server.startTime, 'number');
    assert.ok(server.startTime > 0);
    
    const uptime = Date.now() - server.startTime;
    assert.ok(uptime >= 0);
  } finally {
    await closeServer(server, sockets);
  }
});

test('server tracks connected clients count', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  
  try {
    const ws1 = await connect(server);
    sockets.push(ws1);
    await authenticate(ws1, server.authCode);
    
    const ws2 = await connect(server);
    sockets.push(ws2);
    await authenticate(ws2, server.authCode);
    
    // Server should track 2 clients
    const authenticatedClients = Array.from(server.clients.values())
      .filter(c => c.authenticated);
    assert.equal(authenticatedClients.length, 2);
  } finally {
    await closeServer(server, sockets);
  }
});

test('diagnostics can track multiple ping-pong exchanges', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  
  try {
    const ws = await connect(server);
    sockets.push(ws);
    await authenticate(ws, server.authCode);
    
    let pongCount = 0;
    const pongs = [];
    
    ws.on('message', (raw) => {
      const data = JSON.parse(raw);
      if (data.type === 'pong') {
        pongs.push(data);
      }
    });
    
    // Send multiple pings
    ws.send(JSON.stringify({ type: 'ping' }));
    ws.send(JSON.stringify({ type: 'ping' }));
    ws.send(JSON.stringify({ type: 'ping' }));
    
    // Wait for responses
    await new Promise(resolve => setTimeout(resolve, 500));
    
    assert.ok(pongs.length >= 3);
  } finally {
    await closeServer(server, sockets);
  }
});
