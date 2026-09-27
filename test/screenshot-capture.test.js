const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
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

test('server reports screenshot capability', { concurrency: false }, async () => {
  const server = await createServer();
  
  try {
    const capabilities = server.getCapabilities();
    
    assert.equal(typeof capabilities.screen, 'boolean');
    
    if (capabilities.screen) {
      console.log('  ✓ Screenshot capability available');
    } else {
      console.log('  ⚠ Screenshot capability unavailable:', capabilities.screenUnavailableReason);
    }
  } finally {
    await closeServer(server, []);
  }
});

test('screenshot capture requires authentication', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  
  try {
    const ws = await connect(server);
    sockets.push(ws);
    
    // Try to capture without auth
    ws.send(JSON.stringify({ type: 'screenshot_capture' }));
    
    const response = await new Promise((resolve) => {
      ws.once('message', (raw) => resolve(JSON.parse(raw)));
    });
    
    assert.equal(response.type, 'error');
    assert.match(response.message, /not authenticated/i);
  } finally {
    await closeServer(server, sockets);
  }
});

test('screenshot capture works when authenticated and capability available', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  
  try {
    const capabilities = server.getCapabilities();
    
    if (!capabilities.screen) {
      console.log('  ⊘ Skipped: screenshot capability unavailable');
      return;
    }
    
    const ws = await connect(server);
    sockets.push(ws);
    await authenticate(ws, server.authCode);
    
    // Request screenshot
    ws.send(JSON.stringify({ type: 'screenshot_capture' }));
    
    const response = await new Promise((resolve) => {
      ws.once('message', (raw) => resolve(JSON.parse(raw)));
    });
    
    assert.equal(response.type, 'screenshot_saved');
    assert.equal(typeof response.filename, 'string');
    assert.match(response.filename, /^screenshot-\d+\.png$/);
    assert.equal(typeof response.size, 'number');
    assert.ok(response.size > 0);
    assert.equal(typeof response.timestamp, 'number');
    
    // Verify file was created
    const filepath = path.join(server.fileTransferPath, 'incoming', response.filename);
    assert.ok(fs.existsSync(filepath));
    
    // Verify file size matches
    const stats = fs.statSync(filepath);
    assert.equal(stats.size, response.size);
    
    // Clean up
    fs.unlinkSync(filepath);
  } finally {
    await closeServer(server, sockets);
  }
});

test('screenshot is saved to incoming directory', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  
  try {
    const capabilities = server.getCapabilities();
    
    if (!capabilities.screen) {
      console.log('  ⊘ Skipped: screenshot capability unavailable');
      return;
    }
    
    const ws = await connect(server);
    sockets.push(ws);
    await authenticate(ws, server.authCode);
    
    ws.send(JSON.stringify({ type: 'screenshot_capture' }));
    
    const response = await new Promise((resolve) => {
      ws.once('message', (raw) => resolve(JSON.parse(raw)));
    });
    
    const expectedPath = path.join(server.fileTransferPath, 'incoming', response.filename);
    assert.ok(fs.existsSync(expectedPath));
    
    // Clean up
    fs.unlinkSync(expectedPath);
  } finally {
    await closeServer(server, sockets);
  }
});

test('screenshot filename includes timestamp', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  
  try {
    const capabilities = server.getCapabilities();
    
    if (!capabilities.screen) {
      console.log('  ⊘ Skipped: screenshot capability unavailable');
      return;
    }
    
    const ws = await connect(server);
    sockets.push(ws);
    await authenticate(ws, server.authCode);
    
    const before = Date.now();
    
    ws.send(JSON.stringify({ type: 'screenshot_capture' }));
    
    const response = await new Promise((resolve) => {
      ws.once('message', (raw) => resolve(JSON.parse(raw)));
    });
    
    const after = Date.now();
    
    // Extract timestamp from filename
    const match = response.filename.match(/screenshot-(\d+)\.png/);
    assert.ok(match);
    
    const timestamp = parseInt(match[1]);
    assert.ok(timestamp >= before && timestamp <= after);
    
    // Clean up
    const filepath = path.join(server.fileTransferPath, 'incoming', response.filename);
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
    }
  } finally {
    await closeServer(server, sockets);
  }
});

test('screenshot is saved as PNG format', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  
  try {
    const capabilities = server.getCapabilities();
    
    if (!capabilities.screen) {
      console.log('  ⊘ Skipped: screenshot capability unavailable');
      return;
    }
    
    const ws = await connect(server);
    sockets.push(ws);
    await authenticate(ws, server.authCode);
    
    ws.send(JSON.stringify({ type: 'screenshot_capture' }));
    
    const response = await new Promise((resolve) => {
      ws.once('message', (raw) => resolve(JSON.parse(raw)));
    });
    
    assert.ok(response.filename.endsWith('.png'));
    
    // Verify PNG magic bytes
    const filepath = path.join(server.fileTransferPath, 'incoming', response.filename);
    const buffer = fs.readFileSync(filepath);
    
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    assert.equal(buffer[0], 0x89);
    assert.equal(buffer[1], 0x50);
    assert.equal(buffer[2], 0x4E);
    assert.equal(buffer[3], 0x47);
    
    // Clean up
    fs.unlinkSync(filepath);
  } finally {
    await closeServer(server, sockets);
  }
});

test('multiple screenshots create unique filenames', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  
  try {
    const capabilities = server.getCapabilities();
    
    if (!capabilities.screen) {
      console.log('  ⊘ Skipped: screenshot capability unavailable');
      return;
    }
    
    const ws = await connect(server);
    sockets.push(ws);
    await authenticate(ws, server.authCode);
    
    // Capture two screenshots
    ws.send(JSON.stringify({ type: 'screenshot_capture' }));
    
    const response1 = await new Promise((resolve) => {
      ws.once('message', (raw) => resolve(JSON.parse(raw)));
    });
    
    // Small delay to ensure different timestamp
    await new Promise(resolve => setTimeout(resolve, 10));
    
    ws.send(JSON.stringify({ type: 'screenshot_capture' }));
    
    const response2 = await new Promise((resolve) => {
      ws.once('message', (raw) => resolve(JSON.parse(raw)));
    });
    
    // Filenames should be different
    assert.notEqual(response1.filename, response2.filename);
    
    // Both files should exist
    const filepath1 = path.join(server.fileTransferPath, 'incoming', response1.filename);
    const filepath2 = path.join(server.fileTransferPath, 'incoming', response2.filename);
    
    assert.ok(fs.existsSync(filepath1));
    assert.ok(fs.existsSync(filepath2));
    
    // Clean up
    fs.unlinkSync(filepath1);
    fs.unlinkSync(filepath2);
  } finally {
    await closeServer(server, sockets);
  }
});

test('screenshot records activity log', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  
  try {
    const capabilities = server.getCapabilities();
    
    if (!capabilities.screen) {
      console.log('  ⊘ Skipped: screenshot capability unavailable');
      return;
    }
    
    const ws = await connect(server);
    sockets.push(ws);
    await authenticate(ws, server.authCode);
    
    const activityBefore = server.activityLog.length;
    
    ws.send(JSON.stringify({ type: 'screenshot_capture' }));
    
    await new Promise((resolve) => {
      ws.once('message', () => resolve());
    });
    
    // Should have added activity entry
    assert.ok(server.activityLog.length > activityBefore);
    
    const lastActivity = server.activityLog[server.activityLog.length - 1];
    assert.equal(lastActivity.type, 'screenshot');
    assert.match(lastActivity.message, /screenshot captured/i);
    
    // Clean up screenshot file
    const filepath = path.join(server.fileTransferPath, 'incoming');
    const files = fs.readdirSync(filepath);
    const screenshotFiles = files.filter(f => f.startsWith('screenshot-'));
    for (const file of screenshotFiles) {
      fs.unlinkSync(path.join(filepath, file));
    }
  } finally {
    await closeServer(server, sockets);
  }
});
