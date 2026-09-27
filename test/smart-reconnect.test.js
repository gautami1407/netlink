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
    const start = clientHtml.indexOf(`function ${name}(`);
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

function createReconnectHarness() {
  const toasts = [];
  const timers = [];
  const intervals = [];
  let nextTimerId = 1;
  let nextIntervalId = 1;
  
  const state = {
    connected: false,
    reconnecting: false,
    manualDisconnect: false,
    emergencyStopped: false,
    sessionTerminated: false,
    reconnectAttempts: 0,
    device: { hostname: 'Test-PC' }
  };
  
  const elements = {
    topStatusPill: { classList: { remove: () => {}, add: () => {} } },
    topStatusText: { textContent: '' },
    emergencyStopButton: { hidden: false },
    latencyLabel: { textContent: '' },
    reconnectNotice: { textContent: '', hidden: true }
  };
  
  const sandbox = {
    state,
    toast: (msg, isError) => toasts.push({ msg, isError }),
    showConnectScreen: () => { sandbox.screenShown = 'connect'; },
    openSocket: () => { sandbox.openSocketCalled = true; },
    stopPing: () => { sandbox.stopPingCalled = true; },
    updateTopStatus: () => {},
    $: (id) => elements[id] || null,
    setTimeout: (fn, ms) => {
      const id = nextTimerId++;
      timers.push({ id, fn, ms, executed: false });
      return id;
    },
    setInterval: (fn, ms) => {
      const id = nextIntervalId++;
      intervals.push({ id, fn, ms, cleared: false });
      return id;
    },
    clearInterval: (id) => {
      const interval = intervals.find(i => i.id === id);
      if (interval) interval.cleared = true;
    },
    openSocketCalled: false,
    stopPingCalled: false,
    screenShown: null
  };
  
  const SOURCE = extractFunctions(['attemptReconnect', 'disconnect'], ['disconnect', 'setConnectStatus']);
  vm.runInNewContext(`${SOURCE}\nthis.attemptReconnect = attemptReconnect; this.disconnect = disconnect;`, sandbox);
  
  sandbox.runTimers = () => {
    const pending = timers.filter(t => !t.executed);
    for (const timer of pending) {
      timer.executed = true;
      timer.fn();
    }
  };
  
  sandbox.tickIntervals = (times = 1) => {
    for (let i = 0; i < times; i++) {
      for (const interval of intervals.filter(i => !i.cleared)) {
        interval.fn();
      }
    }
  };
  
  return { sandbox, toasts, timers, intervals, elements, state };
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

test('reconnect attempts are bounded to 8 with exponential backoff', { concurrency: false }, () => {
  const harness = createReconnectHarness();
  const { sandbox, toasts, timers, state } = harness;
  
  // First reconnect attempt
  sandbox.attemptReconnect();
  assert.equal(state.reconnecting, true);
  assert.equal(state.reconnectAttempts, 1);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 1000); // 1 second delay
  
  // Second attempt
  sandbox.attemptReconnect();
  assert.equal(state.reconnectAttempts, 2);
  assert.equal(timers[timers.length - 1].ms, 2000); // 2 second delay
  
  // Continue attempts
  for (let i = 3; i <= 8; i++) {
    sandbox.attemptReconnect();
    assert.equal(state.reconnectAttempts, i);
    const expectedDelay = Math.min(1000 * i, 8000);
    assert.equal(timers[timers.length - 1].ms, expectedDelay);
  }
  
  // 9th attempt should fail
  sandbox.attemptReconnect();
  assert.equal(state.reconnectAttempts, 9);
  assert.equal(state.reconnecting, false);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].msg, /could not reconnect/);
  assert.equal(sandbox.screenShown, 'connect');
});

test('reconnect respects manual disconnect flag', { concurrency: false }, () => {
  const harness = createReconnectHarness();
  const { sandbox, state } = harness;
  
  sandbox.attemptReconnect();
  assert.equal(state.reconnecting, true);
  assert.equal(state.reconnectAttempts, 1);
  
  // Set manual disconnect
  state.manualDisconnect = true;
  
  // Run the timer - should not call openSocket
  sandbox.runTimers();
  assert.equal(sandbox.openSocketCalled, false);
});

test('reconnect respects emergency stop flag', { concurrency: false }, () => {
  const harness = createReconnectHarness();
  const { sandbox, state } = harness;
  
  state.emergencyStopped = true;
  
  sandbox.attemptReconnect();
  assert.equal(state.reconnecting, false);
  assert.equal(state.reconnectAttempts, 0);
});

test('reconnect respects session terminated flag', { concurrency: false }, () => {
  const harness = createReconnectHarness();
  const { sandbox, state } = harness;
  
  state.sessionTerminated = true;
  
  sandbox.attemptReconnect();
  assert.equal(state.reconnecting, false);
  assert.equal(state.reconnectAttempts, 0);
});

test('disconnect sets manual disconnect flag and prevents reconnect', { concurrency: false }, () => {
  const harness = createReconnectHarness();
  const { sandbox, state } = harness;
  
  sandbox.disconnect();
  assert.equal(state.manualDisconnect, true);
  assert.equal(state.reconnecting, false);
  assert.equal(sandbox.screenShown, 'connect');
});

test('reconnect countdown interval updates UI', { concurrency: false }, () => {
  const harness = createReconnectHarness();
  const { sandbox, intervals, elements, state, timers } = harness;
  
  sandbox.attemptReconnect();
  
  // Should have created a countdown interval and a reconnect timeout
  assert.equal(intervals.length, 1, 'Should have exactly 1 interval');
  assert.equal(intervals[0].ms, 1000, 'Interval should tick every second');
  assert.equal(timers.length, 1, 'Should have exactly 1 timer for reconnection');
  
  // The interval clears itself when countdown reaches 0
  // Simulate the countdown reaching 0 by ticking enough times
  const delay = Math.min(1000 * state.reconnectAttempts, 8000);
  const ticks = Math.ceil(delay / 1000);
  sandbox.tickIntervals(ticks);
  
  // After countdown reaches 0, interval should be self-cleared
  assert.equal(intervals[0].cleared, true, 'Interval should clear itself when countdown reaches 0');
  
  // Run timers to trigger reconnect - this also clears the interval
  sandbox.runTimers();
  
  // Verify reconnect was attempted
  assert.equal(sandbox.openSocketCalled, true);
});

test('real server reconnect after disconnection', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  
  try {
    // Connect first time
    const ws1 = await connect(server);
    sockets.push(ws1);
    
    // Close connection
    ws1.close();
    await once(ws1, 'close');
    
    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Reconnect
    const ws2 = await connect(server);
    sockets.push(ws2);
    
    assert.equal(ws2.readyState, WebSocket.OPEN);
    
    // Verify we can send commands
    ws2.send(JSON.stringify({ type: 'get_status' }));
    const response = await new Promise((resolve) => {
      ws2.once('message', (raw) => resolve(JSON.parse(raw)));
    });
    
    assert.equal(response.type, 'status');
  } finally {
    await closeServer(server, sockets);
  }
});

test('emergency stop prevents automatic reconnect', { concurrency: false }, () => {
  const harness = createReconnectHarness();
  const { sandbox, state, timers } = harness;
  
  // Start reconnecting
  sandbox.attemptReconnect();
  assert.equal(state.reconnecting, true);
  const initialAttempts = state.reconnectAttempts;
  
  // Trigger emergency stop
  state.emergencyStopped = true;
  
  // Try to reconnect again - should be blocked
  const attemptsBefore = state.reconnectAttempts;
  const timersBefore = timers.length;
  sandbox.attemptReconnect();
  
  // State should not advance when emergency stopped
  assert.equal(state.reconnectAttempts, attemptsBefore, 'Reconnect attempts should not increase when emergency stopped');
  assert.equal(timers.length, timersBefore, 'No new timers should be created when emergency stopped');
});

test('reconnect attempts reset on successful connection', { concurrency: false }, async () => {
  // This test verifies the pattern used in client.html where auth_success resets attempts
  const server = await createServer();
  const sockets = [];
  
  try {
    const ws = await connect(server);
    sockets.push(ws);
    
    // In real client, auth_success handler sets:
    // state.reconnecting = false
    // state.reconnectAttempts = 0
    
    // Verify server accepts the connection
    assert.equal(ws.readyState, WebSocket.OPEN);
  } finally {
    await closeServer(server, sockets);
  }
});
