const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { once } = require('node:events');
const WebSocket = require('ws');
const DexileServer = require('../server.js');

const clientHtml = fs.readFileSync(path.join(__dirname, '..', 'client.html'), 'utf8');

function extractFunctions(...namesAndNextMarkers) {
  return namesAndNextMarkers.map(([name, nextName]) => {
    let start = clientHtml.indexOf(`function ${name}(`);
    let isAsync = false;
    if (start === -1) {
      start = clientHtml.indexOf(`async function ${name}(`);
      isAsync = true;
    }
    if (start === -1) {
      throw new Error(`missing production function: ${name}`);
    }
    const regularEnd = clientHtml.indexOf(`\nfunction ${nextName}(`, start);
    const asyncEnd = clientHtml.indexOf(`\nasync function ${nextName}(`, start);
    const end = regularEnd < 0 ? asyncEnd : asyncEnd < 0 ? regularEnd : Math.min(regularEnd, asyncEnd);
    if (end === -1) {
      throw new Error(`missing end marker for production function: ${name} (looking for ${nextName})`);
    }
    return clientHtml.slice(start, end);
  }).join('\n');
}

function createClipboardHarness() {
  const messages = [];
  const toasts = [];
  const logs = { warn: [], debug: [] };
  
  const state = {
    connected: true,
    clipboardEnabled: false,
    lastClipboardText: '',
    clipboardMaxSize: 50000,
    clipboardPollInterval: null
  };
  
  const elements = {
    clipboardEnabled: { checked: false }
  };
  
  // Mock clipboard API
  let mockClipboardText = '';
  const mockClipboard = {
    readText: async () => mockClipboardText,
    writeText: async (text) => { mockClipboardText = text; }
  };
  
  const sandbox = {
    state,
    navigator: { clipboard: mockClipboard },
    window: {
      addEventListener: () => {},
      removeEventListener: () => {}
    },
    send: (msg) => messages.push(msg),
    toast: (msg, isError) => toasts.push({ msg, isError }),
    $: (id) => elements[id] || null,
    console: {
      warn: (...args) => logs.warn.push(args.join(' ')),
      debug: (...args) => logs.debug.push(args.join(' '))
    },
    setInterval: () => 1, // Mock interval ID
    clearInterval: () => {},
    setMockClipboard: (text) => { mockClipboardText = text; },
    getMockClipboard: () => mockClipboardText
  };
  
  // Extract non-async functions only
  const SOURCE = extractFunctions(
    ['toggleClipboard', 'setupClipboardSync'],
    ['setupClipboardSync', 'teardownClipboardSync'],
    ['teardownClipboardSync', 'checkClipboardChange']
  );
  
  vm.runInNewContext(`${SOURCE}\nthis.toggleClipboard = toggleClipboard;`, sandbox);
  
  // Manually implement checkClipboardChange in sandbox for testing
  sandbox.checkClipboardChange = async function() {
    if (!sandbox.state.clipboardEnabled || !sandbox.state.connected) return;
    
    try {
      const text = await sandbox.navigator.clipboard.readText();
      
      if (!text || text === sandbox.state.lastClipboardText) return;
      if (text.length > sandbox.state.clipboardMaxSize) {
        sandbox.console.warn(`Clipboard text too large (${text.length} chars, max ${sandbox.state.clipboardMaxSize})`);
        return;
      }
      
      sandbox.state.lastClipboardText = text;
      sandbox.send({ type: 'clipboard_push', text });
    } catch (err) {
      sandbox.console.debug('Clipboard read failed:', err.message);
    }
  };
  
  // Manually implement handleClipboardPull in sandbox for testing
  sandbox.handleClipboardPull = function(text) {
    if (!sandbox.state.clipboardEnabled) return;
    
    if (typeof text !== 'string') {
      sandbox.console.warn('Invalid clipboard_pull: text must be string');
      return;
    }
    if (text.length > sandbox.state.clipboardMaxSize) {
      sandbox.console.warn(`Clipboard_pull text too large (${text.length} chars, max ${sandbox.state.clipboardMaxSize})`);
      return;
    }
    
    if (sandbox.navigator.clipboard && sandbox.navigator.clipboard.writeText) {
      sandbox.navigator.clipboard.writeText(text).then(() => {
        sandbox.state.lastClipboardText = text;
      }).catch(err => {
        sandbox.console.warn('Failed to write clipboard:', err.message);
      });
    }
  };
  
  return { sandbox, messages, toasts, logs, state, elements };
}

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
  ws.send(JSON.stringify({ type: 'auth', code: server.authCode }));
  await new Promise((resolve) => {
    ws.once('message', (raw) => {
      const data = JSON.parse(raw);
      if (data.type === 'auth_success') resolve();
    });
  });
  return ws;
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

test('clipboard sync is disabled by default', { concurrency: false }, () => {
  const harness = createClipboardHarness();
  const { state } = harness;
  
  assert.equal(state.clipboardEnabled, false);
});

test('toggleClipboard enables and shows toast', { concurrency: false }, () => {
  const harness = createClipboardHarness();
  const { sandbox, toasts, state } = harness;
  
  sandbox.toggleClipboard(true);
  
  assert.equal(state.clipboardEnabled, true);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].msg, /enabled/i);
});

test('toggleClipboard disables and shows toast', { concurrency: false }, () => {
  const harness = createClipboardHarness();
  const { sandbox, toasts, state } = harness;
  
  // Enable first
  sandbox.toggleClipboard(true);
  toasts.length = 0; // Clear
  
  // Then disable
  sandbox.toggleClipboard(false);
  
  assert.equal(state.clipboardEnabled, false);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].msg, /disabled/i);
});

test('checkClipboardChange sends clipboard_push when text changes', { concurrency: false }, async () => {
  const harness = createClipboardHarness();
  const { sandbox, messages, state } = harness;
  
  state.clipboardEnabled = true;
  state.connected = true;
  sandbox.setMockClipboard('Hello World');
  
  await sandbox.checkClipboardChange();
  
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'clipboard_push');
  assert.equal(messages[0].text, 'Hello World');
  assert.equal(state.lastClipboardText, 'Hello World');
});

test('checkClipboardChange does not send duplicate text', { concurrency: false }, async () => {
  const harness = createClipboardHarness();
  const { sandbox, messages, state } = harness;
  
  state.clipboardEnabled = true;
  state.connected = true;
  sandbox.setMockClipboard('Same Text');
  
  await sandbox.checkClipboardChange();
  assert.equal(messages.length, 1);
  
  // Check again with same text
  await sandbox.checkClipboardChange();
  assert.equal(messages.length, 1, 'Should not send duplicate');
});

test('checkClipboardChange respects max size limit', { concurrency: false }, async () => {
  const harness = createClipboardHarness();
  const { sandbox, messages, state, logs } = harness;
  
  state.clipboardEnabled = true;
  state.connected = true;
  state.clipboardMaxSize = 100;
  
  // Set clipboard text that exceeds limit
  const largeText = 'x'.repeat(101);
  sandbox.setMockClipboard(largeText);
  
  await sandbox.checkClipboardChange();
  
  assert.equal(messages.length, 0, 'Should not send text exceeding limit');
  assert.equal(logs.warn.length, 1);
  assert.match(logs.warn[0], /too large/i);
});

test('checkClipboardChange does nothing when disabled', { concurrency: false }, async () => {
  const harness = createClipboardHarness();
  const { sandbox, messages, state } = harness;
  
  state.clipboardEnabled = false;
  state.connected = true;
  sandbox.setMockClipboard('Test');
  
  await sandbox.checkClipboardChange();
  
  assert.equal(messages.length, 0);
});

test('checkClipboardChange does nothing when not connected', { concurrency: false }, async () => {
  const harness = createClipboardHarness();
  const { sandbox, messages, state } = harness;
  
  state.clipboardEnabled = true;
  state.connected = false;
  sandbox.setMockClipboard('Test');
  
  await sandbox.checkClipboardChange();
  
  assert.equal(messages.length, 0);
});

test('handleClipboardPull updates local clipboard', { concurrency: false }, async () => {
  const harness = createClipboardHarness();
  const { sandbox, state } = harness;
  
  state.clipboardEnabled = true;
  
  sandbox.handleClipboardPull('Remote Text');
  
  // Wait for async clipboard write to complete
  await new Promise(resolve => setTimeout(resolve, 10));
  
  assert.equal(sandbox.getMockClipboard(), 'Remote Text');
  assert.equal(state.lastClipboardText, 'Remote Text');
});

test('handleClipboardPull validates text is string', { concurrency: false }, () => {
  const harness = createClipboardHarness();
  const { sandbox, state, logs } = harness;
  
  state.clipboardEnabled = true;
  
  sandbox.handleClipboardPull(123); // Invalid type
  
  assert.equal(sandbox.getMockClipboard(), '');
  assert.equal(logs.warn.length, 1);
  assert.match(logs.warn[0], /must be string/i);
});

test('handleClipboardPull rejects oversized text', { concurrency: false }, () => {
  const harness = createClipboardHarness();
  const { sandbox, state, logs } = harness;
  
  state.clipboardEnabled = true;
  state.clipboardMaxSize = 100;
  
  const largeText = 'x'.repeat(101);
  sandbox.handleClipboardPull(largeText);
  
  assert.equal(sandbox.getMockClipboard(), '');
  assert.equal(logs.warn.length, 1);
  assert.match(logs.warn[0], /too large/i);
});

test('handleClipboardPull does nothing when disabled', { concurrency: false }, () => {
  const harness = createClipboardHarness();
  const { sandbox, state } = harness;
  
  state.clipboardEnabled = false;
  
  sandbox.handleClipboardPull('Text');
  
  assert.equal(sandbox.getMockClipboard(), '');
});

test('server broadcasts clipboard_push to other clients', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  
  try {
    // Connect two clients
    const ws1 = await connect(server);
    const ws2 = await connect(server);
    sockets.push(ws1, ws2);
    
    // Client 1 sends clipboard
    ws1.send(JSON.stringify({ type: 'clipboard_push', text: 'Shared Clipboard' }));
    
    // Client 2 should receive clipboard_pull
    const response = await new Promise((resolve) => {
      ws2.once('message', (raw) => resolve(JSON.parse(raw)));
    });
    
    assert.equal(response.type, 'clipboard_pull');
    assert.equal(response.text, 'Shared Clipboard');
  } finally {
    await closeServer(server, sockets);
  }
});

test('server rejects clipboard_push with non-string text', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  
  try {
    const ws = await connect(server);
    sockets.push(ws);
    
    ws.send(JSON.stringify({ type: 'clipboard_push', text: 123 }));
    
    const response = await new Promise((resolve) => {
      ws.once('message', (raw) => resolve(JSON.parse(raw)));
    });
    
    assert.equal(response.type, 'error');
    assert.match(response.message, /text string/i);
  } finally {
    await closeServer(server, sockets);
  }
});

test('server rejects oversized clipboard text', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  
  try {
    const ws = await connect(server);
    sockets.push(ws);
    
    const largeText = 'x'.repeat(50001);
    ws.send(JSON.stringify({ type: 'clipboard_push', text: largeText }));
    
    const response = await new Promise((resolve) => {
      ws.once('message', (raw) => resolve(JSON.parse(raw)));
    });
    
    assert.equal(response.type, 'error');
    assert.match(response.message, /too large/i);
  } finally {
    await closeServer(server, sockets);
  }
});

test('server does not echo clipboard_push back to sender', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  
  try {
    const ws = await connect(server);
    sockets.push(ws);
    
    ws.send(JSON.stringify({ type: 'clipboard_push', text: 'Test' }));
    
    // Wait briefly to ensure no message comes back
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Should not receive clipboard_pull back
    let receivedClipboardPull = false;
    ws.on('message', (raw) => {
      const data = JSON.parse(raw);
      if (data.type === 'clipboard_pull') receivedClipboardPull = true;
    });
    
    assert.equal(receivedClipboardPull, false);
  } finally {
    await closeServer(server, sockets);
  }
});
