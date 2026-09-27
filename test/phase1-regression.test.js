const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const DexileServer = require('../server.js');
const robot = require('robotjs');

function waitForMessage(ws, predicate, timeoutMs = 3000) {
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

async function connect(server) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.httpServer.address().port}`);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return ws;
}

async function authenticate(ws, code) {
  const result = waitForMessage(ws, (message) => message.type === 'auth_success' || message.type === 'auth_failed');
  ws.send(JSON.stringify({ type: 'auth', code }));
  const message = await result;
  assert.equal(message.type, 'auth_success', message.message || 'authentication failed');
  return message;
}

// A completed phone upload is delivered to the Windows Downloads folder. Tests
// point the server at temporary folders so the real ones are never touched.
// The transfer root matters as much as Downloads: it holds received.json, so
// leaving it on the project would let a test run rewrite the live manifest.
const TEST_DOWNLOADS = path.join(os.tmpdir(), `dexile-test-downloads-${process.pid}`);
fs.mkdirSync(TEST_DOWNLOADS, { recursive: true });
const TEST_TRANSFERS = fs.mkdtempSync(path.join(os.tmpdir(), `dexile-test-transfers-${process.pid}-`));

async function createServer() {
  const server = new DexileServer(0, { downloadsPath: TEST_DOWNLOADS, transferPath: TEST_TRANSFERS });
  if (!server.httpServer.listening) await once(server.httpServer, 'listening');
  return server;
}

async function waitForState(predicate, message) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function getSessionState(server, clientId) {
  return Array.from(server.clients.values()).find((client) => client.id === clientId);
}

function hasSession(server, clientId) {
  return Array.from(server.clients.values()).some((client) => client.id === clientId);
}

function getServerSocket(server, clientId) {
  return Array.from(server.clients.entries()).find(([, client]) => client.id === clientId)?.[0];
}

async function closeServer(server, sockets) {
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.terminate();
  }
  if (!server.httpServer.listening) return;
  const httpClosed = once(server.httpServer, 'close');
  const websocketServerClosed = once(server.wss, 'close');
  server.shutdown();
  assert.equal(server.cleanupTimer, null);
  assert.equal(server.screenCaptureTimer, null);
  await Promise.all([httpClosed, websocketServerClosed]);
}

// Native helper failures arrive as multi-line shell errors whose last line is
// generic boilerplate ("operable program or batch file."), so prefer the line
// that actually names the missing piece and fall back to the first line.
function summarizeError(message) {
  const lines = String(message || '').split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return 'unknown error';
  return lines.find((line) => /\.(exe|bat|dll)\b/i.test(line)) || lines[0];
}

// The server reports screen capability from whether screenshot-desktop *loads*.
// That is not the same question as whether this machine can actually capture a
// frame: on some systems the module loads while its native helper binary is
// missing, and the failure only surfaces on the first real capture. Probing
// with one real capture is the only way to tell "frames can be verified here"
// apart from "this environment cannot produce a frame", so the suite never has
// to choose between skipping a real test and accepting a broken one as a pass.
let screenCaptureProbe;
function probeScreenCapture() {
  if (!screenCaptureProbe) {
    screenCaptureProbe = (async () => {
      let capture;
      try {
        capture = require('screenshot-desktop');
      } catch (error) {
        return { available: false, reason: `screenshot-desktop is not installed (${summarizeError(error.message)})` };
      }
      try {
        const buffer = await capture({ format: 'jpg' });
        if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
          return { available: false, reason: 'screenshot-desktop returned an empty image' };
        }
        return { available: true, reason: null };
      } catch (error) {
        return { available: false, reason: `the native screen-capture helper is unusable (${summarizeError(error.message)})` };
      }
    })();
  }
  return screenCaptureProbe;
}

test('session management tracks independent sessions and restricts host actions', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  try {
    const host = await connect(server);
    sockets.push(host);
    const hostAuth = await authenticate(host, server.authCode);
    assert.equal(hostAuth.session.role, 'host');

    const clientA = await connect(server);
    sockets.push(clientA);
    const clientAAuth = await authenticate(clientA, server.authCode);
    const clientB = await connect(server);
    sockets.push(clientB);
    const clientBAuth = await authenticate(clientB, server.authCode);

    const unauthenticated = await connect(server);
    sockets.push(unauthenticated);
    let reply = waitForMessage(unauthenticated, (message) => message.type === 'error');
    unauthenticated.send(JSON.stringify({ type: 'session_list' }));
    assert.equal((await reply).code, 'UNAUTHENTICATED');
    reply = waitForMessage(unauthenticated, (message) => message.type === 'error');
    unauthenticated.send(JSON.stringify({ type: 'session_manage', action: 'disconnect', sessionId: clientAAuth.clientId }));
    assert.equal((await reply).code, 'UNAUTHENTICATED');

    const sessionsReply = waitForMessage(host, (message) => message.type === 'session_list');
    host.send(JSON.stringify({ type: 'session_list' }));
    const { sessions } = await sessionsReply;
    assert.equal(sessions.length, 3);
    assert.equal(sessions.filter((session) => session.role === 'host').length, 1);
    for (const session of sessions) {
      assert.equal(typeof session.id, 'string');
      assert.equal(session.authenticated, true);
      assert.equal(typeof session.connectedAt, 'number');
      assert.equal(typeof session.lastActivity, 'number');
      assert.equal(typeof session.lastHeartbeat, 'number');
      assert.equal(session.connectionState, 'connected');
      assert.equal(Object.hasOwn(session, 'ip'), false);
      assert.equal(Object.hasOwn(session, 'screenFps'), false);
    }

    const clientAId = clientAAuth.clientId;
    const clientBId = clientBAuth.clientId;
    reply = waitForMessage(clientA, (message) => message.type === 'error' && message.code === 'HOST_ONLY');
    clientA.send(JSON.stringify({ type: 'session_manage', action: 'disconnect', sessionId: clientBId }));
    assert.equal((await reply).code, 'HOST_ONLY');
    assert.equal(getSessionState(server, clientBId).authenticated, true);

    reply = waitForMessage(clientA, (message) => message.type === 'error' && message.code === 'HOST_ONLY');
    clientA.send(JSON.stringify({ type: 'emergency_stop', confirm: true }));
    assert.equal((await reply).code, 'HOST_ONLY');
    assert.equal(getSessionState(server, clientAId).authenticated, true);

    reply = waitForMessage(host, (message) => message.type === 'error' && message.code === 'SESSION_NOT_FOUND');
    host.send(JSON.stringify({ type: 'session_manage', action: 'disconnect', sessionId: 'invalid-session-id' }));
    assert.equal((await reply).code, 'SESSION_NOT_FOUND');
    reply = waitForMessage(host, (message) => message.type === 'error' && message.code === 'BAD_ARGS');
    host.send(JSON.stringify({ type: 'session_manage', action: 'promote', sessionId: clientAId }));
    assert.equal((await reply).code, 'BAD_ARGS');

    const disconnected = waitForMessage(clientA, (message) => message.type === 'session_terminated');
    host.send(JSON.stringify({ type: 'session_manage', action: 'disconnect', sessionId: clientAId }));
    assert.equal((await disconnected).action, 'disconnect');
    await waitForState(() => !hasSession(server, clientAId), 'disconnected socket remained tracked');
    assert.equal(getSessionState(server, clientBId).authenticated, true);
    assert.equal(server.getSessionList().some((session) => session.id === clientBId), true);

    const revoked = waitForMessage(clientB, (message) => message.type === 'session_terminated');
    host.send(JSON.stringify({ type: 'session_manage', action: 'revoke', sessionId: clientBId }));
    assert.equal((await revoked).action, 'revoke');
    assert.equal(getSessionState(server, clientBId).authenticated, false);
    assert.equal(server.getSessionList().some((session) => session.id === clientBId), false);
    await waitForState(() => !hasSession(server, clientBId), 'revoked socket remained tracked');

    const replacement = await connect(server);
    sockets.push(replacement);
    const replacementAuth = await authenticate(replacement, server.authCode);
    const hostId = hostAuth.clientId;
    host.close();
    await waitForState(() => !hasSession(server, hostId), 'host socket remained tracked');
    assert.equal(getSessionState(server, replacementAuth.clientId).id, server.hostClientId);
    assert.equal(server.getSessionList().find((session) => session.id === replacementAuth.clientId).role, 'host');
  } finally {
    await closeServer(server, sockets);
  }
});

test('emergency stop disables control, clears streaming state, and leaves server reusable', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  let timer;
  try {
    const host = await connect(server);
    sockets.push(host);
    const hostAuth = await authenticate(host, server.authCode);
    const normalClient = await connect(server);
    sockets.push(normalClient);
    const normalAuth = await authenticate(normalClient, server.authCode);
    const unauthenticated = await connect(server);
    sockets.push(unauthenticated);

    const hostState = getSessionState(server, hostAuth.clientId);
    const normalState = getSessionState(server, normalAuth.clientId);
    hostState.subscribedToScreen = true;
    normalState.subscribedToScreen = true;
    const pendingUploadReply = waitForMessage(normalClient, (message) => message.type === 'upload_started');
    normalClient.send(JSON.stringify({
      type: 'upload_start',
      filename: `emergency-stop-${process.pid}-${Date.now()}.txt`,
      fileSize: 64
    }));
    const pendingUpload = await pendingUploadReply;
    assert.equal(server.fileTransfer.activeTransfers.has(pendingUpload.transferId), true);
    timer = setInterval(() => {}, 60000);
    server.screenCaptureTimer = timer;

    let reply = waitForMessage(unauthenticated, (message) => message.type === 'error');
    unauthenticated.send(JSON.stringify({ type: 'emergency_stop', confirm: true }));
    assert.equal((await reply).code, 'UNAUTHENTICATED');
    assert.equal(server.screenCaptureTimer, timer);
    assert.equal(hostState.authenticated, true);

    const ack = waitForMessage(host, (message) => message.type === 'emergency_stop_ack');
    host.send(JSON.stringify({ type: 'emergency_stop', confirm: true }));
    assert.match((await ack).message, /complete/i);

    assert.equal(hostState.authenticated, false);
    assert.equal(normalState.authenticated, false);
    assert.equal(hostState.subscribedToScreen, false);
    assert.equal(normalState.subscribedToScreen, false);
    assert.equal(server.screenCaptureTimer, null);
    assert.equal(server.hostClientId, null);
    assert.equal(server.fileTransfer.activeTransfers.has(pendingUpload.transferId), false);

    let controlHandlerCalled = false;
    server.handleGesture = () => { controlHandlerCalled = true; };
    server.handleMessage(getServerSocket(server, hostAuth.clientId), { type: 'gesture', gesture: 'leftClick' });
    assert.equal(controlHandlerCalled, false);

    await waitForState(() => server.clients.size === 0, 'emergency stop did not terminate all sessions');
    const health = await fetch(`http://127.0.0.1:${server.httpServer.address().port}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, 'ok');

    const freshClient = await connect(server);
    sockets.push(freshClient);
    const freshAuth = await authenticate(freshClient, server.authCode);
    assert.equal(freshAuth.session.role, 'host');
    assert.equal(getSessionState(server, freshAuth.clientId).authenticated, true);
  } finally {
    clearInterval(timer);
    await closeServer(server, sockets);
  }
});

test('connection telemetry uses measured RTT, detects stale heartbeats, and tolerates malformed values', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  const originalMouseClick = robot.mouseClick;
  try {
    const host = await connect(server);
    sockets.push(host);
    const hostAuth = await authenticate(host, server.authCode);
    const client = getSessionState(server, hostAuth.clientId);
    assert.equal(server.getConnectionQuality().connectionState, 'connected');
    assert.equal(server.getConnectionQuality().latencyMs, null);

    const sentAt = Date.now();
    const firstPong = waitForMessage(host, (message) => message.type === 'pong');
    host.send(JSON.stringify({ type: 'ping', t: sentAt }));
    const pong = await firstPong;
    assert.equal(pong.clientTime, sentAt);
    assert.equal(typeof pong.serverTime, 'number');
    const measuredRtt = Math.max(0, Date.now() - pong.clientTime);

    const secondPong = waitForMessage(host, (message) => message.type === 'pong');
    host.send(JSON.stringify({ type: 'ping', t: Date.now(), rttMs: measuredRtt }));
    await secondPong;
    assert.equal(client.lastRtt, measuredRtt);
    assert.equal(server.getConnectionQuality().latencyMs, measuredRtt);
    assert.equal(server.getSessionList()[0].connectionState, 'connected');

    const oldHeartbeat = client.lastHeartbeat;
    const malformedPong = waitForMessage(host, (message) => message.type === 'pong');
    host.send(JSON.stringify({ type: 'ping', t: 'bad-timestamp', rttMs: -1 }));
    const malformed = await malformedPong;
    assert.equal(malformed.clientTime, null);
    assert.equal(client.lastRtt, null);
    assert.ok(client.lastHeartbeat >= oldHeartbeat);
    assert.equal(server.getConnectionQuality().connectionState, 'connected');
    assert.equal(server.getConnectionQuality().latencyMs, null);

    client.lastActivity = 0;
    const statusReply = waitForMessage(host, (message) => message.type === 'status');
    host.send(JSON.stringify({ type: 'get_status' }));
    const status = await statusReply;
    assert.equal(status.connectionQuality.connectionState, 'connected');
    assert.ok(client.lastActivity > 0);
    assert.equal(Object.hasOwn(status.connectionQuality, 'reconnectState'), false);

    let clickCount = 0;
    robot.mouseClick = () => { clickCount += 1; };
    const gestureActivity = waitForMessage(host, (message) => message.type === 'activity' && message.activity.type === 'gesture');
    host.send(JSON.stringify({ type: 'gesture', gesture: 'leftClick' }));
    await gestureActivity;
    assert.equal(clickCount, 1);

    client.lastHeartbeat = Date.now() - 16000;
    assert.equal(server.getConnectionQuality().connectionState, 'stale');
    assert.equal(server.getSessionList()[0].connectionState, 'stale');
    const recoveryPong = waitForMessage(host, (message) => message.type === 'pong');
    host.send(JSON.stringify({ type: 'ping', t: Date.now(), rttMs: measuredRtt }));
    await recoveryPong;
    assert.equal(server.getConnectionQuality().connectionState, 'connected');
    assert.equal(server.getSessionList()[0].connectionState, 'connected');

    const telemetry = JSON.stringify({ sessions: server.getSessionList(), quality: server.getConnectionQuality() });
    for (const sensitiveField of ['"ip"', '"hostname"', '"authCode"', '"screenFps"']) {
      assert.equal(telemetry.includes(sensitiveField), false);
    }
    assert.doesNotThrow(() => server.handlePing(host, { t: {}, rttMs: 'invalid' }));
  } finally {
    robot.mouseClick = originalMouseClick;
    await closeServer(server, sockets);
  }
});

test('existing input, screen, transfer, and reconnect paths remain operational', { concurrency: false }, async (t) => {
  const server = await createServer();
  const sockets = [];
  const originalMousePos = robot.getMousePos;
  const originalMouseMove = robot.moveMouse;
  const originalKeyTap = robot.keyTap;
  const filename = `phase1-check-${process.pid}-${Date.now()}.txt`;
  const outgoingPath = path.join(server.fileTransferPath, 'outgoing', filename);
  const incomingPath = path.join(server.fileTransferPath, 'incoming', filename);
  const transferBytes = Buffer.from('Dexile transfer round-trip');
  let mousePosition;
  let mouseMoved;
  let keyTapped;
  try {
    fs.writeFileSync(outgoingPath, transferBytes);
    const client = await connect(server);
    sockets.push(client);
    const auth = await authenticate(client, server.authCode);

    robot.getMousePos = () => ({ x: 40, y: 50 });
    robot.moveMouse = (x, y) => { mouseMoved = [x, y]; };
    robot.keyTap = (...args) => { keyTapped = args; };
    client.send(JSON.stringify({ type: 'mouse_move', deltaX: 3, deltaY: 4 }));
    client.send(JSON.stringify({ type: 'keyboard', key: 'a', ctrlKey: true }));
    const inputBarrier = waitForMessage(client, (message) => message.type === 'status');
    client.send(JSON.stringify({ type: 'get_status' }));
    await inputBarrier;
    mousePosition = mouseMoved;
    assert.deepEqual(mousePosition, [43, 54]);
    assert.equal(keyTapped[0], 'a');
    assert.ok(keyTapped[1].includes('control'));

    const screenResult = waitForMessage(client, (message) =>
      message.type === 'screen_frame' || message.type === 'screen_error' ||
      (message.type === 'error' && message.code === 'SCREENSHOT_UNAVAILABLE'), 10000);
    client.send(JSON.stringify({ type: 'screen_subscribe', fps: 1 }));
    const screenMessage = await screenResult;
    // Frame contents are asserted in "real screen frames stream with a measured
    // fps", which is skipped with an explicit reason when this environment
    // cannot capture at all. This test only checks the environment-independent
    // contract: the server reports what it can actually do, and tears down.
    if (!server.getCapabilities().screen) {
      assert.equal(screenMessage.code, 'SCREENSHOT_UNAVAILABLE');
    } else {
      assert.ok(
        screenMessage.type === 'screen_frame' || screenMessage.type === 'screen_error',
        `expected a screen_frame or an honest screen_error, got ${screenMessage.type}`
      );
      if (screenMessage.type === 'screen_error') {
        t.diagnostic(`SCREEN ENVIRONMENT UNAVAILABLE: ${screenMessage.message}`);
      }
    }
    client.send(JSON.stringify({ type: 'screen_unsubscribe' }));
    const unsubscribedBarrier = waitForMessage(client, (message) => message.type === 'status');
    client.send(JSON.stringify({ type: 'get_status' }));
    await unsubscribedBarrier;
    assert.equal(getSessionState(server, auth.clientId).subscribedToScreen, false);
    assert.equal(server.screenCaptureTimer, null);

    const uploadStarted = waitForMessage(client, (message) => message.type === 'upload_started');
    client.send(JSON.stringify({ type: 'upload_start', filename, fileSize: transferBytes.length }));
    const upload = await uploadStarted;
    const uploadCompleted = waitForMessage(client, (message) =>
      message.type === 'transfer_completed' && message.transferId === upload.transferId);
    client.send(JSON.stringify({
      type: 'upload_chunk',
      transferId: upload.transferId,
      chunkIndex: 0,
      data: transferBytes.toString('base64'),
      isLastChunk: true
    }));
    await uploadCompleted;
    // The upload is delivered to the Windows Downloads folder with its bytes intact.
    const deliveredPath = path.join(TEST_DOWNLOADS, filename);
    assert.equal(fs.existsSync(deliveredPath), true, 'the uploaded file must exist in Downloads');
    assert.deepEqual(fs.readFileSync(deliveredPath), transferBytes);
    assert.equal(fs.existsSync(incomingPath), false, 'nothing is left in the staging directory');

    const downloadStarted = waitForMessage(client, (message) => message.type === 'download_started');
    client.send(JSON.stringify({ type: 'download_start', filename }));
    const download = await downloadStarted;
    const downloadChunk = waitForMessage(client, (message) => message.type === 'download_chunk');
    client.send(JSON.stringify({ type: 'download_chunk_request', transferId: download.transferId, chunkIndex: 0 }));
    const chunk = await downloadChunk;
    assert.equal(chunk.isLastChunk, true);
    assert.deepEqual(Buffer.from(chunk.data, 'base64'), transferBytes);

    client.close();
    await waitForState(() => !hasSession(server, auth.clientId), 'closed client remained tracked before reconnect');
    const reconnected = await connect(server);
    sockets.push(reconnected);
    const reconnectAuth = await authenticate(reconnected, server.authCode);
    assert.equal(reconnectAuth.session.role, 'host');
    assert.equal(getSessionState(server, reconnectAuth.clientId).authenticated, true);
  } finally {
    robot.getMousePos = originalMousePos;
    robot.moveMouse = originalMouseMove;
    robot.keyTap = originalKeyTap;
    for (const file of [incomingPath, outgoingPath, path.join(TEST_DOWNLOADS, filename)]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    await closeServer(server, sockets);
  }
});

test('real screen frames stream with a measured fps', { concurrency: false }, async (t) => {
  // This is the assertion that actually proves screen streaming works. It is
  // skipped â€” never softened, never silently passed â€” when this environment
  // cannot produce a frame at all.
  const probe = await probeScreenCapture();
  if (!probe.available) {
    t.skip(`SCREEN ENVIRONMENT UNAVAILABLE: ${probe.reason}`);
    return;
  }
  const server = await createServer();
  const sockets = [];
  try {
    assert.equal(server.getCapabilities().screen, true, 'the server must advertise screen capture when frames are possible');
    const client = await connect(server);
    sockets.push(client);
    const auth = await authenticate(client, server.authCode);

    const firstFrame = waitForMessage(client, (message) =>
      message.type === 'screen_frame' || message.type === 'screen_error' ||
      (message.type === 'error' && message.code === 'SCREENSHOT_UNAVAILABLE'), 10000);
    client.send(JSON.stringify({ type: 'screen_subscribe', fps: 1 }));
    const screenMessage = await firstFrame;

    // A real environment must stream a real frame. A screen_error here is a
    // genuine failure, not an environment excuse, because the probe proved a
    // capture is possible on this machine.
    assert.equal(screenMessage.type, 'screen_frame', `expected a real screen_frame, got ${screenMessage.type}: ${screenMessage.message || screenMessage.code || ''}`);
    assert.equal(typeof screenMessage.capturedAt, 'number');
    assert.equal(screenMessage.fps, null);
    const measuredFrame = await waitForMessage(client, (message) => message.type === 'screen_frame', 10000);
    assert.equal(typeof measuredFrame.fps, 'number');
    assert.ok(measuredFrame.fps > 0);

    client.send(JSON.stringify({ type: 'screen_unsubscribe' }));
    const unsubscribedBarrier = waitForMessage(client, (message) => message.type === 'status');
    client.send(JSON.stringify({ type: 'get_status' }));
    await unsubscribedBarrier;
    assert.equal(getSessionState(server, auth.clientId).subscribedToScreen, false);
    assert.equal(server.screenCaptureTimer, null);
  } finally {
    await closeServer(server, sockets);
  }
});

test('a capture failure is reported as screen_error and never as a screen_frame', { concurrency: false }, async (t) => {
  // Only meaningful where the server advertises screen capture but this machine
  // genuinely cannot capture. It asserts the honest-failure contract, so a
  // broken helper is verified rather than merely tolerated.
  const probe = await probeScreenCapture();
  const server = await createServer();
  const sockets = [];
  try {
    if (!server.getCapabilities().screen) {
      t.skip(`SCREEN ENVIRONMENT UNAVAILABLE: the server reports screen capture as unavailable (${server.getCapabilities().screenUnavailableReason})`);
      return;
    }
    if (probe.available) {
      t.skip('This environment can capture frames, so the error path is not exercised here');
      return;
    }
    const client = await connect(server);
    sockets.push(client);
    const auth = await authenticate(client, server.authCode);

    const result = waitForMessage(client, (message) =>
      message.type === 'screen_frame' || message.type === 'screen_error' ||
      (message.type === 'error' && message.code === 'SCREENSHOT_UNAVAILABLE'), 10000);
    client.send(JSON.stringify({ type: 'screen_subscribe', fps: 1 }));
    const screenMessage = await result;

    t.diagnostic(`SCREEN ENVIRONMENT UNAVAILABLE: ${screenMessage.message || screenMessage.code}`);
    assert.notEqual(screenMessage.type, 'screen_frame', 'a failed capture must never be reported as a real frame');
    assert.equal(screenMessage.type, 'screen_error');
    assert.equal(typeof screenMessage.message, 'string');
    assert.ok(screenMessage.message.length > 0, 'screen_error must carry a reason');

    client.send(JSON.stringify({ type: 'screen_unsubscribe' }));
    const unsubscribedBarrier = waitForMessage(client, (message) => message.type === 'status');
    client.send(JSON.stringify({ type: 'get_status' }));
    await unsubscribedBarrier;
    assert.equal(getSessionState(server, auth.clientId).subscribedToScreen, false);
    assert.equal(server.screenCaptureTimer, null);
  } finally {
    await closeServer(server, sockets);
  }
});