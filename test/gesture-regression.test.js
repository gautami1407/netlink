const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const WebSocket = require('ws');
const http = require('http');
const { spawn } = require('node:child_process');
const DexileServer = require('../server.js');
const robot = require('robotjs');

const originalMouseClick = robot.mouseClick;
const originalScrollMouse = robot.scrollMouse;
const originalKeyTap = robot.keyTap;

async function waitForMessage(ws, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for expected WebSocket message')), 5000);
    const onMessage = (raw) => {
      try {
        const data = JSON.parse(raw);
        if (predicate(data)) {
          clearTimeout(timer);
          ws.off('message', onMessage);
          resolve(data);
        }
      } catch (error) {
        // ignore malformed test payloads
      }
    };
    ws.on('message', onMessage);
  });
}

test.beforeEach(() => {
  robot.mouseClick = (...args) => {
    robot.__lastMouseClickArgs = args;
  };
  robot.scrollMouse = (...args) => {
    robot.__lastScrollArgs = args;
  };
  robot.keyTap = (...args) => {
    robot.__lastKeyTapArgs = args;
  };
});

test.afterEach(() => {
  robot.mouseClick = originalMouseClick;
  robot.scrollMouse = originalScrollMouse;
  robot.keyTap = originalKeyTap;
  delete robot.__lastMouseClickArgs;
  delete robot.__lastScrollArgs;
  delete robot.__lastKeyTapArgs;
});

async function createAuthenticatedClient(server, code = server.authCode) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.httpServer.address().port}`);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  await new Promise((resolve, reject) => {
    const onMessage = (raw) => {
      try {
        const data = JSON.parse(raw);
        if (data.type === 'auth_success') {
          ws.off('message', onMessage);
          resolve();
        } else if (data.type === 'auth_failed') {
          ws.off('message', onMessage);
          reject(new Error(`Auth failed: ${data.message}`));
        }
      } catch (error) {
        // ignore
      }
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ type: 'auth', code }));
  });
  return ws;
}

async function closeServer(server) {
  for (const ws of server.wss.clients) ws.terminate();
  const httpClosed = once(server.httpServer, 'close');
  const websocketServerClosed = once(server.wss, 'close');
  server.shutdown();
  await Promise.all([httpClosed, websocketServerClosed]);
}

test('valid gestures call RobotJS with numeric scroll args and supported mouse actions', async () => {
  const server = new DexileServer(0);

  try {
    const ws = await createAuthenticatedClient(server);

    const gestureCases = [
      ['leftClick', () => robot.__lastMouseClickArgs],
      ['rightClick', () => robot.__lastMouseClickArgs],
      ['doubleClick', () => robot.__lastMouseClickArgs],
      ['scrollUp', () => robot.__lastScrollArgs],
      ['scrollDown', () => robot.__lastScrollArgs]
    ];

    for (const [gesture, getArgs] of gestureCases) {
      ws.send(JSON.stringify({ type: 'gesture', gesture }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      const args = getArgs();
      if (gesture.startsWith('scroll')) {
        assert.ok(Array.isArray(args), `${gesture} should call scrollMouse`);
        assert.equal(typeof args[0], 'number', `${gesture} must pass a numeric x scroll value`);
        assert.equal(typeof args[1], 'number', `${gesture} must pass a numeric y scroll value`);
      } else {
        assert.ok(Array.isArray(args), `${gesture} should call mouseClick`);
      }
    }

    ws.close();
  } finally {
    await closeServer(server);
  }
});

test('swipe gestures are sent with valid native gesture payloads', async () => {
  const server = new DexileServer(0);

  try {
    const ws = await createAuthenticatedClient(server);
    const tasks = [
      ['twoFingerSwipeLeft', () => robot.__lastKeyTapArgs],
      ['twoFingerSwipeRight', () => robot.__lastKeyTapArgs],
      ['threeFingerSwipeUp', () => robot.__lastKeyTapArgs]
    ];

    for (const [gesture, getArgs] of tasks) {
      ws.send(JSON.stringify({ type: 'gesture', gesture }));
      await new Promise((resolve) => setTimeout(resolve, 30));
      const args = getArgs();
      assert.ok(Array.isArray(args), `${gesture} should call keyTap`);
      assert.equal(typeof args[0], 'string', `${gesture} should tap a string key`);
      if (gesture !== 'threeFingerSwipeUp' || process.platform !== 'linux') {
        assert.ok(Array.isArray(args[1]) || args[1] === undefined, `${gesture} modifiers should be an array or undefined`);
      }
    }

    ws.close();
  } finally {
    await closeServer(server);
  }
});

test('server fails gracefully when the requested port is already in use', async () => {
  const blocker = http.createServer();
  await new Promise((resolve) => blocker.listen(0, resolve));
  const port = blocker.address().port;

  const child = spawn(process.execPath, ['server.js', String(port)], {
    cwd: require('node:path').resolve(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  const exitCode = await new Promise((resolve) => child.on('exit', resolve));
  blocker.close();

  const output = `${stdout}\n${stderr}`;
  assert.match(output, /EADDRINUSE|already in use|HTTP server failed/i, 'expected a clear port-conflict error');
  assert.notEqual(exitCode, 0, 'server should exit non-zero when its port is unavailable');
});
