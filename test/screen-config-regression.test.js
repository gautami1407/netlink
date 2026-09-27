const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const WebSocket = require('ws');
const DexileServer = require('../server.js');

function waitForMessage(ws, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Timed out waiting for expected WebSocket message')), timeoutMs);
    const onMessage = (raw) => {
      try {
        const message = JSON.parse(raw);
        if (predicate(message)) finish(null, message);
      } catch (error) {
        finish(error);
      }
    };
    const onClose = () => finish(new Error('WebSocket closed before expected message'));
    const finish = (error, message) => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('close', onClose);
      if (error) reject(error);
      else resolve(message);
    };
    ws.on('message', onMessage);
    ws.once('close', onClose);
  });
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
  const authReply = waitForMessage(ws, message => message.type === 'auth_success');
  ws.send(JSON.stringify({ type: 'auth', code: server.authCode }));
  return { ws, auth: await authReply };
}

function getServerClient(server, id) {
  return Array.from(server.clients.values()).find(client => client.id === id);
}

function getServerSocket(server, id) {
  return Array.from(server.clients.entries()).find(([, client]) => client.id === id)?.[0];
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setImmediate(resolve));
  }
}

async function closeServer(server, sockets) {
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.terminate();
  }
  if (!server.httpServer.listening) return;
  const httpClosed = once(server.httpServer, 'close');
  const websocketClosed = once(server.wss, 'close');
  server.shutdown();
  await Promise.all([httpClosed, websocketClosed]);
}

test('screen profile defaults, valid targets, strict validation, and per-session authorization', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  try {
    const host = await connect(server);
    sockets.push(host.ws);
    const hostState = getServerClient(server, host.auth.clientId);
    assert.equal(hostState.screenQuality, 'BALANCED');
    assert.equal(hostState.screenFps, 6);

    const profiles = [['LOW', 3], ['BALANCED', 6], ['HIGH', 15]];
    for (const [quality, fps] of profiles) {
      const reply = waitForMessage(host.ws, message => message.type === 'screen_configured');
      host.ws.send(JSON.stringify({ type: 'screen_config', quality, fps }));
      const configured = await reply;
      assert.equal(configured.quality, quality);
      assert.equal(configured.targetFps, fps);
      assert.equal(hostState.screenQuality, quality);
      assert.equal(hostState.screenFps, fps);
      assert.equal(hostState.authenticated, true);
      assert.equal(host.ws.readyState, WebSocket.OPEN);
    }

    for (const fps of [10, 15, 20, 30]) {
      const reply = waitForMessage(host.ws, message => message.type === 'screen_configured');
      host.ws.send(JSON.stringify({ type: 'screen_config', quality: 'BALANCED', fps }));
      assert.equal((await reply).targetFps, fps);
      assert.equal(hostState.screenFps, fps);
    }

    const beforeInvalid = { quality: hostState.screenQuality, fps: hostState.screenFps };
    for (const invalidFps of [1000, -10, '30', null, 9]) {
      const reply = waitForMessage(host.ws, message => message.type === 'error');
      host.ws.send(JSON.stringify({ type: 'screen_config', quality: 'BALANCED', fps: invalidFps }));
      assert.equal((await reply).code, 'BAD_ARGS');
      assert.deepEqual({ quality: hostState.screenQuality, fps: hostState.screenFps }, beforeInvalid);
    }

    const invalidQuality = waitForMessage(host.ws, message => message.type === 'error');
    host.ws.send(JSON.stringify({ type: 'screen_config', quality: 'ULTRA', fps: 15 }));
    assert.equal((await invalidQuality).code, 'BAD_ARGS');
    assert.equal(hostState.authenticated, true);

    const normalClient = await connect(server);
    sockets.push(normalClient.ws);
    const normalState = getServerClient(server, normalClient.auth.clientId);
    const hostConfigBefore = { quality: hostState.screenQuality, fps: hostState.screenFps };
    const ownConfig = waitForMessage(normalClient.ws, message => message.type === 'screen_configured');
    normalClient.ws.send(JSON.stringify({
      type: 'screen_config', sessionId: hostState.id, quality: 'LOW', fps: 3
    }));
    await ownConfig;
    assert.deepEqual({ quality: hostState.screenQuality, fps: hostState.screenFps }, hostConfigBefore);
    assert.equal(normalState.screenQuality, 'LOW');
    assert.equal(normalState.screenFps, 3);

    const unauthenticated = new WebSocket(`ws://127.0.0.1:${server.httpServer.address().port}`);
    sockets.push(unauthenticated);
    await new Promise((resolve, reject) => {
      unauthenticated.once('open', resolve);
      unauthenticated.once('error', reject);
    });
    const unauthorizedReply = waitForMessage(unauthenticated, message => message.type === 'error');
    unauthenticated.send(JSON.stringify({ type: 'screen_config', quality: 'HIGH', fps: 30 }));
    assert.equal((await unauthorizedReply).code, 'UNAUTHENTICATED');
  } finally {
    await closeServer(server, sockets);
  }
});

test('live screen configuration replaces one timer and disconnect restores defaults', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;
  const timers = [];
  global.setInterval = (callback, delay) => {
    const timer = { callback, delay, cleared: false };
    timers.push(timer);
    return timer;
  };
  global.clearInterval = (timer) => {
    if (timer && Object.prototype.hasOwnProperty.call(timer, 'cleared')) timer.cleared = true;
    else realClearInterval(timer);
  };
  try {
    const client = await connect(server);
    sockets.push(client.ws);
    const clientState = getServerClient(server, client.auth.clientId);
    const serverSocket = getServerSocket(server, client.auth.clientId);
    clientState.subscribedToScreen = true;
    server.updateScreenCaptureLoop();
    assert.equal(timers.filter(timer => !timer.cleared).length, 1);
    const firstTimer = server.screenCaptureTimer;

    server.handleScreenConfig(serverSocket, { type: 'screen_config', quality: 'LOW', fps: 3 });
    assert.equal(firstTimer.cleared, true);
    assert.equal(timers.filter(timer => !timer.cleared).length, 1);
    assert.equal(server.screenCaptureTimer.delay, Math.round(1000 / 3));

    const secondTimer = server.screenCaptureTimer;
    server.handleScreenConfig(serverSocket, { type: 'screen_config', quality: 'HIGH', fps: 30 });
    assert.equal(secondTimer.cleared, true);
    assert.equal(timers.filter(timer => !timer.cleared).length, 1);
    assert.equal(server.screenCaptureTimer.delay, Math.round(1000 / 30));
    assert.equal(clientState.authenticated, true);
    assert.equal(client.ws.readyState, WebSocket.OPEN);

    server.handleScreenUnsubscribe(serverSocket);
    assert.equal(server.screenCaptureTimer, null);
    assert.equal(timers.filter(timer => !timer.cleared).length, 0);

    const close = once(client.ws, 'close');
    client.ws.close();
    await close;
    await waitFor(() => !getServerClient(server, client.auth.clientId), 'disconnected screen session remained tracked');
    const freshClient = await connect(server);
    sockets.push(freshClient.ws);
    const freshState = getServerClient(server, freshClient.auth.clientId);
    assert.equal(freshState.screenQuality, 'BALANCED');
    assert.equal(freshState.screenFps, 6);
  } finally {
    if (server.screenCaptureTimer) {
      global.clearInterval(server.screenCaptureTimer);
      server.screenCaptureTimer = null;
    }
    global.setInterval = realSetInterval;
    global.clearInterval = realClearInterval;
    if (server.cleanupTimer) {
      realClearInterval(server.cleanupTimer);
      server.cleanupTimer = null;
    }
    await closeServer(server, sockets);
  }
});