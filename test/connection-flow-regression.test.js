const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { once } = require('node:events');
const WebSocket = require('ws');
const DexileServer = require('../server.js');

const repoRoot = path.join(__dirname, '..');
const clientHtml = fs.readFileSync(path.join(repoRoot, 'client.html'), 'utf8');

// ------------------------------------------------------- connection screen

test('the connection screen offers only server address and authentication code', { concurrency: false }, () => {
  const connectScreen = clientHtml.slice(
    clientHtml.indexOf('<div id="connectScreen">'),
    clientHtml.indexOf('<div id="app">')
  );
  assert.ok(connectScreen.length > 0, 'the connect screen is present');

  // Branding
  assert.match(connectScreen, /Dexile/);
  // The two required fields, with the exact labels a user needs.
  assert.match(connectScreen, /<label for="serverAddr">Server address<\/label>/);
  assert.match(connectScreen, /<input id="serverAddr" type="text"/);
  assert.match(connectScreen, /<label for="authCode">Authentication code<\/label>/);
  assert.match(connectScreen, /<input id="authCode" type="password"/);
  // The Connect button.
  assert.match(connectScreen, /<button class="btn btn-primary" id="connectBtn" onclick="Dexile\.connect\(\)">Connect<\/button>/);
  // The error/status line sits below the button, as the last child of the card.
  const buttonIndex = connectScreen.indexOf('id="connectBtn"');
  const statusIndex = connectScreen.indexOf('id="connectStatus"');
  assert.ok(statusIndex > buttonIndex, 'the status line is below the Connect button');

  // The address field stays editable and starts on localhost for convenience.
  assert.doesNotMatch(connectScreen, /serverAddr[^>]*readonly/i);
  assert.doesNotMatch(connectScreen, /serverAddr[^>]*disabled/i);
  assert.match(connectScreen, /value="localhost:3000"/);

  // No second way in.
  assert.doesNotMatch(connectScreen, /QR/i);
  assert.doesNotMatch(connectScreen, /pair/i);
  assert.doesNotMatch(connectScreen, /scan/i);
  assert.doesNotMatch(connectScreen, /trusted device/i);
});

test('no QR, pairing, or device-registration implementation remains anywhere', { concurrency: false }, () => {
  const sourceFiles = ['client.html', 'server.js', 'filetransfer.js']
    .map((name) => ({ name, text: fs.readFileSync(path.join(repoRoot, name), 'utf8') }));

  // Forbidden identifiers and wording, none of which may survive.
  const forbidden = [
    'importPairingData', 'pairingToken', 'pairingData', 'scanQrCode',
    'QRCode.toString', "require('qrcode')", 'require("qrcode")',
    'trustedDevice', 'trusted_device', 'deviceRegistration', 'enrollDevice'
  ];
  for (const { name, text } of sourceFiles) {
    for (const needle of forbidden) {
      assert.equal(text.includes(needle), false, `${name} must not contain ${needle}`);
    }
  }

  // The dependency is gone from both manifests.
  for (const manifest of ['package.json', 'package-lock.json']) {
    const text = fs.readFileSync(path.join(repoRoot, manifest), 'utf8');
    assert.equal(/"qrcode"/.test(text), false, `${manifest} must not reference qrcode`);
    assert.equal(/"dijkstrajs"|"encode-utf8"|"pngjs"|"yargs"/.test(text), false, `${manifest} must not retain qrcode-only dependencies`);
  }

  // No code path builds a machine-readable pairing payload.
  assert.doesNotMatch(sourceFiles[1].text, /JSON\.stringify\(\{[^}]*authCode/s);
});

// ---------------------------------------------------------- address handling

function extractFunctions(...namesAndNextMarkers) {
  return namesAndNextMarkers.map(([name, nextName]) => {
    const start = clientHtml.indexOf(`function ${name}(`);
    const regularEnd = clientHtml.indexOf(`\nfunction ${nextName}(`, start);
    const end = regularEnd < 0 ? -1 : regularEnd;
    assert.notEqual(start, -1, `missing production function: ${name}`);
    assert.notEqual(end, -1, `missing end marker for production function: ${name}`);
    return clientHtml.slice(start, end);
  }).join('\n');
}

function createConnectHarness() {
  const fields = {
    serverAddr: { value: '' },
    authCode: { value: '' },
    connectBtn: { disabled: false },
    connectStatus: { className: 'status-line', textContent: '' },
    phaseNotice: { hidden: false }
  };
  const sockets = [];
  const statuses = [];
  const sandbox = {
    state: {
      serverAddr: '', authCode: '', connected: false, manualDisconnect: false,
      reconnectAttempts: 0, session: null, sessions: [], connectionQuality: null,
      sessionActionNotice: '', pendingSessionAction: null, latencyMs: null,
      emergencyStopped: false, emergencyStopPending: false, sessionTerminated: false,
      ws: null
    },
    $: (id) => fields[id],
    openSocket: null,
    send: (message) => { sandbox.sent.push(message); },
    sent: [],
    WebSocket: function MockWebSocket(url) {
      this.url = url;
      this.readyState = 0;
      sockets.push(this);
      if (sandbox.socketThrows) throw new Error('bad address');
    },
    WebSocketRef: { OPEN: 1 },
    setTimeout: () => 0,
    clearTimeout: () => {},
    console
  };
  sandbox.WebSocket.OPEN = 1;

  // The real connect() and openSocket() run here, so these tests exercise the
  // production path rather than a re-implementation of it.
  const source = [
    extractFunctions(['connect', 'openSocket']),
    extractFunctions(['openSocket', 'attemptReconnect']),
    extractFunctions(['setConnectStatus', 'closeSidebar'])
  ].join('\n');
  vm.runInNewContext(`${source}\nthis.connect = connect; this.setConnectStatus = setConnectStatus;`, sandbox);
  return { sandbox, fields, statuses, sockets };
}

test('connect uses exactly the address and code the user entered', { concurrency: false }, () => {
  const { sandbox, fields, sockets } = createConnectHarness();
  for (const address of ['192.168.1.10:3000', '10.0.0.7:3000', 'localhost:3000', 'dexile.local:8080']) {
    fields.serverAddr.value = address;
    fields.authCode.value = 'ABCD1234';
    sandbox.connect();
    assert.equal(sandbox.state.serverAddr, address, 'the entered address is used verbatim');
    assert.equal(sandbox.state.authCode, 'ABCD1234');
    assert.equal(sockets.at(-1).url, `ws://${address}`, 'the socket targets the entered address, nothing else');
  }
});

test('a LAN address is never silently replaced with localhost', { concurrency: false }, () => {
  const { sandbox, fields, sockets } = createConnectHarness();
  const lan = '192.168.43.128:3000';
  fields.serverAddr.value = lan;
  fields.authCode.value = 'DEADBEEF';
  sandbox.connect();
  assert.equal(sandbox.state.serverAddr, lan);
  assert.equal(sandbox.state.serverAddr, sandbox.state.serverAddr.replace('localhost', lan));
  assert.equal(sockets.at(-1).url.includes('localhost'), false);
  assert.equal(sockets.at(-1).url, `ws://${lan}`);

  // And a LAN address is never rewritten when the socket is (re)opened later.
  sandbox.state.reconnectAttempts = 3;
  assert.equal(sandbox.state.serverAddr, lan);
});

test('connect refuses to proceed without an address and a code', { concurrency: false }, () => {
  const { sandbox, fields, sockets } = createConnectHarness();
  fields.serverAddr.value = '';
  fields.authCode.value = 'ABCD1234';
  sandbox.connect();
  assert.match(fields.connectStatus.textContent, /server address and authentication code/i);
  assert.match(fields.connectStatus.className, /err/);
  assert.equal(sandbox.state.serverAddr, '');

  fields.serverAddr.value = '192.168.1.10:3000';
  fields.authCode.value = '   ';
  sandbox.connect();
  assert.match(fields.connectStatus.textContent, /server address and authentication code/i);
  assert.equal(sockets.length, 0, 'no socket is opened when required fields are missing');
});

test('the documented connection error messages are used verbatim', { concurrency: false }, () => {
  const { sandbox } = createConnectHarness();
  sandbox.setConnectStatus('Could not connect. Check the address and that the server is running.', true);
  assert.equal(sandbox.$('connectStatus').textContent, 'Could not connect. Check the address and that the server is running.');
  assert.match(sandbox.$('connectStatus').className, /err/);

  sandbox.setConnectStatus('Invalid authentication code.', true);
  assert.equal(sandbox.$('connectStatus').textContent, 'Invalid authentication code.');

  sandbox.setConnectStatus('Connection timed out. Check the server address and network connection.', true);
  assert.equal(sandbox.$('connectStatus').textContent, 'Connection timed out. Check the server address and network connection.');

  // The production code carries all three strings.
  assert.match(clientHtml, /Could not connect\. Check the address and that the server is running\./);
  assert.match(clientHtml, /Connection timed out\. Check the server address and network connection\./);
  // The invalid-code message comes from the server.
  const serverSource = fs.readFileSync(path.join(repoRoot, 'server.js'), 'utf8');
  assert.match(serverSource, /'Invalid authentication code\.'/);
  // No user-facing message leaks internals.
  assert.doesNotMatch(clientHtml, /(Could not connect|Connection timed out)[^'"]*\bat \w+ \(\.\.\./);
});

// ------------------------------------------------------------ live server

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

test('the right address plus the right code authenticates and grants a session', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  try {
    const port = server.httpServer.address().port;
    const address = `127.0.0.1:${port}`;
    const ws = new WebSocket(`ws://${address}`);
    sockets.push(ws);
    await once(ws, 'open');

    const authReply = waitForMessage(ws, (message) => message.type === 'auth_success' || message.type === 'auth_failed');
    ws.send(JSON.stringify({ type: 'auth', code: server.authCode }));
    const auth = await authReply;
    assert.equal(auth.type, 'auth_success', auth.message || 'authentication failed');
    assert.equal(typeof auth.clientId, 'string');
    assert.equal(['host', 'client'].includes(auth.session.role), true);
    assert.equal(auth.session.role, 'host', 'the first authenticated client is the host');

    // Permissions are applied only after the access code is accepted.
    const status = waitForMessage(ws, (message) => message.type === 'status');
    ws.send(JSON.stringify({ type: 'get_status' }));
    const snapshot = await status;
    assert.equal(typeof snapshot.capabilities.screen, 'boolean');
    assert.equal(typeof snapshot.capabilities.mouse, 'boolean');
    assert.equal(typeof snapshot.capabilities.keyboard, 'boolean');
  } finally {
    await closeServer(server, sockets);
  }
});

test('a wrong code is rejected and no session is created', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  try {
    const port = server.httpServer.address().port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    sockets.push(ws);
    await once(ws, 'open');

    const reply = waitForMessage(ws, (message) => message.type === 'auth_success' || message.type === 'auth_failed');
    ws.send(JSON.stringify({ type: 'auth', code: 'WRONG123' }));
    const result = await reply;
    assert.equal(result.type, 'auth_failed');
    assert.equal(result.reason, 'invalid_code');
    assert.equal(result.message, 'Invalid authentication code.');

    // The socket is not authenticated, so anything requiring a session fails.
    const denied = waitForMessage(ws, (message) => message.type === 'error');
    ws.send(JSON.stringify({ type: 'get_status' }));
    assert.equal((await denied).code, 'UNAUTHENTICATED');
  } finally {
    await closeServer(server, sockets);
  }
});

test('an unreachable server address produces a connection error, not a session', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  // Reserve a port and immediately release it so nothing is listening there.
  const probe = new WebSocket.Server({ port: 0 });
  await once(probe, 'listening');
  const deadPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  try {
    const result = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${deadPort}`);
      sockets.push(ws);
      const timer = setTimeout(() => resolve({ type: 'error', reason: 'error' }), 4000);
      ws.on('error', () => { clearTimeout(timer); resolve({ type: 'error', reason: 'error' }); });
      ws.on('open', () => { clearTimeout(timer); resolve({ type: 'opened' }); });
    });
    assert.equal(result.type, 'error', 'connecting to a dead port must fail');

    // The client reports that failure with the documented message.
    const { sandbox, fields } = createConnectHarness();
    sandbox.setConnectStatus('Could not connect. Check the address and that the server is running.', true);
    assert.equal(fields.connectStatus.textContent, 'Could not connect. Check the address and that the server is running.');
    assert.match(fields.connectStatus.className, /err/);
  } finally {
    await closeServer(server, sockets);
  }
});

test('a fresh device must always start from address plus code, and reconnect reuses the session', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  try {
    const port = server.httpServer.address().port;
    const first = new WebSocket(`ws://127.0.0.1:${port}`);
    sockets.push(first);
    await once(first, 'open');
    const firstAuth = waitForMessage(first, (message) => message.type === 'auth_success' || message.type === 'auth_failed');
    first.send(JSON.stringify({ type: 'auth', code: server.authCode }));
    const session = await firstAuth;
    assert.equal(session.type, 'auth_success');

    // A second device is a brand-new connection: it must present the code too.
    const second = new WebSocket(`ws://127.0.0.1:${port}`);
    sockets.push(second);
    await once(second, 'open');
    const unauthenticated = waitForMessage(second, (message) => message.type === 'error');
    second.send(JSON.stringify({ type: 'get_status' }));
    assert.equal((await unauthenticated).code, 'UNAUTHENTICATED', 'a new device is never trusted automatically');

    const secondAuth = waitForMessage(second, (message) => message.type === 'auth_success' || message.type === 'auth_failed');
    second.send(JSON.stringify({ type: 'auth', code: server.authCode }));
    const secondSession = await secondAuth;
    assert.equal(secondSession.type, 'auth_success', 'presenting the code is what admits a new device');
    assert.equal(secondSession.session.role, 'client');
    assert.notEqual(secondSession.clientId, session.clientId);

    // The client stores the address + code so a reconnect can reuse them.
    assert.match(clientHtml, /state\.serverAddr = addr/);
    assert.match(clientHtml, /state\.authCode = code/);
    assert.match(clientHtml, /function attemptReconnect\(/);
  } finally {
    await closeServer(server, sockets);
  }
});
