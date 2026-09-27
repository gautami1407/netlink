const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const WebSocket = require('ws');
const FileTransferManager = require('../filetransfer.js');
const { createIsolatedServer, removeTransferTree } = require('./isolated-server');

// ------------------------------------------------------------------ harness

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
  return createIsolatedServer();
}

async function connect(server, { auth = true } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.httpServer.address().port}`);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  if (!auth) return ws;
  const result = waitForMessage(ws, (message) => message.type === 'auth_success' || message.type === 'auth_failed');
  ws.send(JSON.stringify({ type: 'auth', code: server.authCode }));
  const message = await result;
  assert.equal(message.type, 'auth_success', message.message || 'authentication failed');
  return ws;
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
  removeTransferTree(server);
}

function sharedPath(server, location, name) {
  return path.join(server.fileTransferPath, location === 'from-laptop' ? 'outgoing' : 'incoming', name);
}

function seed(server, files) {
  const created = [];
  for (const { location, name, contents } of files) {
    const target = sharedPath(server, location, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
    created.push(target);
  }
  return {
    cleanup() { for (const file of created) { if (fs.existsSync(file)) fs.unlinkSync(file); } }
  };
}

async function downloadAll(ws, started, totalBytes) {
  const chunks = [];
  let index = 0;
  while (true) {
    const reply = waitForMessage(ws, (message) =>
      message.type === 'download_chunk' || message.type === 'download_error');
    ws.send(JSON.stringify({ type: 'download_chunk_request', transferId: started.transferId, chunkIndex: index }));
    const chunk = await reply;
    if (chunk.type === 'download_error') return chunk;
    chunks.push(Buffer.from(chunk.data, 'base64'));
    if (chunk.isLastChunk) break;
    index += 1;
  }
  assert.equal(Buffer.concat(chunks).length, totalBytes);
  return Buffer.concat(chunks);
}

// ------------------------------------------------------- name validation unit

test('shared file names reject every path-shaped input', { concurrency: false }, () => {
  const manager = new FileTransferManager(path.join(os.tmpdir(), `dexile-shared-names-${process.pid}`));
  const accepted = [
    'a.txt', 'Receipt_20260921.pdf', 'my file (1).png', 'a.b.c.tar.gz', 'ünïcode ✓.txt',
    '.hidden', 'nul name.txt', 'file .txt', 'x'.repeat(255)
  ];
  for (const name of accepted) {
    assert.equal(manager.assertSharedFileName(name), name, `${name} should be accepted`);
  }

  const rejected = [
    '../file.txt', '../../file.txt', '../../../etc/passwd',
    '..\\..\\file.txt', '..\\file.txt', 'sub/dir.txt', 'sub\\dir.txt',
    'C:\\Windows\\file.txt', 'C:/Windows/file.txt', 'c:file.txt',
    '/etc/passwd', '/absolute/path.txt', '\\\\server\\share\\file.txt',
    '~', '~/.ssh/id_rsa', '~/.bashrc',
    '.', '..', 'a..b', 'x'.repeat(256),
    '', 'tab\tname.txt', 'new\nline.txt',
    '%2e%2e%2fetc%2fpasswd', '%252e%252e%252fetc%252fpasswd',
    '..%2f..%2fetc%2fpasswd', '....//....//etc/passwd', '..;/etc/passwd'
  ];
  for (const name of rejected) {
    assert.throws(() => manager.assertSharedFileName(name), /Invalid filename/, `${JSON.stringify(name)} should be rejected`);
  }

  for (const bad of [undefined, null, 42, {}, [], true]) {
    assert.throws(() => manager.assertSharedFileName(bad), /Invalid filename/, `${JSON.stringify(bad)} should be rejected`);
  }
});

test('resolveSharedFile never leaves the approved root', { concurrency: false }, () => {
  const base = path.join(os.tmpdir(), `dexile-shared-resolve-${process.pid}`);
  const manager = new FileTransferManager(base);
  const root = path.resolve(base);

  for (const location of ['from-laptop', 'from-phone', 'outgoing', 'incoming']) {
    const resolved = manager.resolveSharedFile('safe.txt', location, { required: false });
    assert.equal(path.dirname(resolved.filePath), path.join(root, manager.resolveLocationDir(location)));
  }

  // A known-good path is found, and nothing outside either root is reachable.
  fs.mkdirSync(path.join(root, 'outgoing'), { recursive: true });
  fs.mkdirSync(path.join(root, 'incoming'), { recursive: true });
  fs.writeFileSync(path.join(root, 'outgoing', 'safe.txt'), 'ok');
  fs.writeFileSync(path.join(root, '..', 'outside.txt'), 'nope');
  assert.equal(fs.readFileSync(manager.resolveSharedFile('safe.txt', 'from-laptop').filePath, 'utf8'), 'ok');
  assert.throws(() => manager.resolveSharedFile('outside.txt', 'from-laptop'), /File not found/);
  assert.throws(() => manager.resolveSharedFile('../../outside.txt', 'from-laptop'), /Invalid filename/);
  assert.throws(() => manager.resolveSharedFile('safe.txt', 'unknown-location'), /Unknown shared location/);
  assert.throws(() => manager.resolveSharedFile('safe.txt', '/etc'), /Unknown shared location/);
  assert.throws(() => manager.resolveSharedFile('safe.txt', '../../'), /Unknown shared location/);
});

test('listSharedFiles returns logical locations and no filesystem paths', { concurrency: false }, () => {
  const base = path.join(os.tmpdir(), `dexile-shared-list-${process.pid}`);
  const manager = new FileTransferManager(base);
  fs.mkdirSync(path.join(base, 'outgoing'), { recursive: true });
  fs.mkdirSync(path.join(base, 'incoming'), { recursive: true });
  fs.writeFileSync(path.join(base, 'outgoing', 'Receipt.pdf'), 'a'.repeat(10));
  fs.writeFileSync(path.join(base, 'incoming', 'Project.zip'), 'b'.repeat(5));
  fs.mkdirSync(path.join(base, 'outgoing', 'a-directory'), { recursive: true });

  const files = manager.listSharedFiles();
  assert.equal(files.length, 2, 'directories are not listed as files');
  const receipt = files.find((file) => file.name === 'Receipt.pdf');
  assert.equal(receipt.location, 'from-laptop');
  assert.equal(receipt.type, 'application/pdf');
  assert.equal(receipt.size, 10);
  assert.equal(typeof receipt.modifiedAt, 'string');
  const project = files.find((file) => file.name === 'Project.zip');
  assert.equal(project.location, 'from-phone');
  assert.equal(project.type, 'application/zip');

  const serialised = JSON.stringify(files);
  assert.doesNotMatch(serialised, /filePath|serverPath|absolutePath/);
  assert.doesNotMatch(serialised, /transfers/);
  assert.doesNotMatch(serialised, /[A-Za-z]:\\\\/);
  assert.doesNotMatch(serialised, /\\\\/);
});

test('server-derived MIME types are used, and unknown types become octet-stream', { concurrency: false }, () => {
  const manager = new FileTransferManager(path.join(os.tmpdir(), `dexile-shared-mime-${process.pid}`));
  const expected = {
    'a.pdf': 'application/pdf', 'a.PNG': 'image/png', 'a.jpg': 'image/jpeg',
    'a.jpeg': 'image/jpeg', 'a.gif': 'image/gif', 'a.webp': 'image/webp',
    'a.svg': 'image/svg+xml', 'a.txt': 'text/plain', 'a.csv': 'text/csv',
    'a.json': 'application/json', 'a.mp3': 'audio/mpeg', 'a.wav': 'audio/wav',
    'a.mp4': 'video/mp4', 'a.webm': 'video/webm', 'a.zip': 'application/zip',
    'a.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'a.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'a.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'a.exe': 'application/octet-stream', 'a.unknown': 'application/octet-stream',
    'noextension': 'application/octet-stream', 'constructor.pdf': 'application/pdf',
    '__proto__.pdf': 'application/pdf', 'a.': 'application/octet-stream'
  };
  for (const [name, mime] of Object.entries(expected)) {
    assert.equal(manager.getMimeType(name), mime, name);
  }
});

// ------------------------------------------------------------ protocol tests

test('list_shared_files returns metadata and rejects unauthenticated listing', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  const files = seed(server, [
    { location: 'from-laptop', name: 'Receipt.pdf', contents: 'a'.repeat(2048) },
    { location: 'from-phone', name: 'Project.zip', contents: 'b'.repeat(512) }
  ]);
  try {
    const anonymous = await connect(server, { auth: false });
    sockets.push(anonymous);
    let denied = waitForMessage(anonymous, (message) => message.type === 'error');
    anonymous.send(JSON.stringify({ type: 'list_shared_files' }));
    const denial = await denied;
    assert.equal(denial.code, 'UNAUTHENTICATED');

    const client = await connect(server);
    sockets.push(client);
    const reply = waitForMessage(client, (message) => message.type === 'shared_file_list');
    client.send(JSON.stringify({ type: 'list_shared_files' }));
    const listing = await reply;

    assert.equal(listing.shared.length, 2);
    assert.deepEqual(
      listing.locations.map((location) => location.id),
      ['from-laptop', 'from-phone']
    );
    const receipt = listing.shared.find((file) => file.name === 'Receipt.pdf');
    assert.equal(receipt.location, 'from-laptop');
    assert.equal(receipt.type, 'application/pdf');
    assert.equal(receipt.size, 2048);
    assert.equal(Object.prototype.hasOwnProperty.call(receipt, 'filePath'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(receipt, 'serverPath'), false);
    const serialised = JSON.stringify(listing);
    assert.doesNotMatch(serialised, /fileTransferPath|transfers|incoming|outgoing/);

    // The legacy list still answers and now carries the shared view too.
    const legacy = waitForMessage(client, (message) => message.type === 'file_list');
    client.send(JSON.stringify({ type: 'list_files' }));
    const legacyListing = await legacy;
    assert.ok(Array.isArray(legacyListing.outgoing));
    assert.ok(Array.isArray(legacyListing.incoming));
    assert.ok(Array.isArray(legacyListing.shared));
  } finally {
    files.cleanup();
    await closeServer(server, sockets);
  }
});

test('shared downloads work from both locations and reuse the existing protocol', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  const files = seed(server, [
    { location: 'from-laptop', name: 'Receipt.pdf', contents: 'from the laptop'.repeat(7000) },
    { location: 'from-phone', name: 'Project.zip', contents: 'from the phone'.repeat(300) }
  ]);
  try {
    const client = await connect(server);
    sockets.push(client);

    const laptopStart = waitForMessage(client, (message) => message.type === 'download_started' || message.type === 'download_error');
    client.send(JSON.stringify({ type: 'download_start', filename: 'Receipt.pdf', location: 'from-laptop' }));
    const laptop = await laptopStart;
    assert.equal(laptop.type, 'download_started', laptop.message);
    assert.equal(laptop.mimeType, 'application/pdf');
    assert.equal(laptop.location, 'from-laptop');
    assert.equal(laptop.preview, false);
    const laptopBytes = await downloadAll(client, laptop, laptop.fileSize);
    assert.equal(laptopBytes.toString('utf8'), 'from the laptop'.repeat(7000));

    const phoneStart = waitForMessage(client, (message) => message.type === 'download_started' || message.type === 'download_error');
    client.send(JSON.stringify({ type: 'download_start', filename: 'Project.zip', location: 'from-phone' }));
    const phone = await phoneStart;
    assert.equal(phone.type, 'download_started', phone.message);
    assert.equal(phone.mimeType, 'application/zip');
    assert.equal(phone.location, 'from-phone');
    const phoneBytes = await downloadAll(client, phone, phone.fileSize);
    assert.equal(phoneBytes.toString('utf8'), 'from the phone'.repeat(300));
  } finally {
    files.cleanup();
    await closeServer(server, sockets);
  }
});

test('a legacy download_start with no location still resolves exactly as before', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  const files = seed(server, [
    { location: 'from-laptop', name: 'Both.pdf', contents: 'laptop-wins' },
    { location: 'from-phone', name: 'Both.pdf', contents: 'phone-loses' }
  ]);
  try {
    const client = await connect(server);
    sockets.push(client);
    const start = waitForMessage(client, (message) => message.type === 'download_started' || message.type === 'download_error');
    client.send(JSON.stringify({ type: 'download_start', filename: 'Both.pdf' }));
    const started = await start;
    assert.equal(started.type, 'download_started', started.message);
    assert.equal(started.location, 'from-laptop');
    const bytes = await downloadAll(client, started, started.fileSize);
    assert.equal(bytes.toString('utf8'), 'laptop-wins');
  } finally {
    files.cleanup();
    await closeServer(server, sockets);
  }
});

test('a preview read borrows the download protocol without creating a transfer', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  const files = seed(server, [{ location: 'from-laptop', name: 'View.pdf', contents: 'preview me'.repeat(100) }]);
  try {
    const client = await connect(server);
    sockets.push(client);
    const observer = await connect(server);
    sockets.push(observer);

    const broadcasts = [];
    observer.on('message', (raw) => {
      const message = JSON.parse(raw);
      if (['transfer_completed', 'transfer_progress', 'file_deleted'].includes(message.type)) broadcasts.push(message);
    });

    const start = waitForMessage(client, (message) => message.type === 'download_started' || message.type === 'download_error');
    client.send(JSON.stringify({ type: 'download_start', filename: 'View.pdf', location: 'from-laptop', preview: true }));
    const started = await start;
    assert.equal(started.type, 'download_started', started.message);
    assert.equal(started.preview, true);
    assert.equal(started.mimeType, 'application/pdf');
    const bytes = await downloadAll(client, started, started.fileSize);
    assert.equal(bytes.toString('utf8'), 'preview me'.repeat(100));

    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(broadcasts, [], 'a preview read is never announced as a transfer');
    assert.equal(server.fileTransfer.activeTransfers.size, 0, 'the preview transfer is not left behind');
    assert.equal(
      server.fileTransfer.transferHistory.some((entry) => entry.filename === 'View.pdf'),
      false,
      'a preview read does not enter transfer history'
    );
  } finally {
    files.cleanup();
    await closeServer(server, sockets);
  }
});

test('every path-shaped download request is refused', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  const files = seed(server, [{ location: 'from-laptop', name: 'ok.txt', contents: 'ok' }]);
  const attempts = [
    '../ok.txt', '../../ok.txt', '../../../etc/passwd', '..\\..\\ok.txt', '..\\ok.txt',
    'sub/ok.txt', 'sub\\ok.txt', 'C:\\Windows\\win.ini', 'C:/Windows/win.ini', 'c:ok.txt',
    '/etc/passwd', '/ok.txt', '\\\\server\\share\\ok.txt', '~', '~/.bashrc',
    '%2e%2e%2fok.txt', '%252e%252e%252fok.txt', '..%2fok.txt', '....//ok.txt',
    'ok .txt', 'ok.txt ', 'x'.repeat(300), 'nope.txt'
  ];
  try {
    const client = await connect(server);
    sockets.push(client);
    for (const filename of attempts) {
      for (const location of ['from-laptop', 'from-phone', undefined, '/etc', '..']) {
        const request = { type: 'download_start', filename };
        if (location !== undefined) request.location = location;
        const reply = waitForMessage(client, (message) => message.type === 'download_started' || message.type === 'download_error' || message.type === 'error');
        client.send(JSON.stringify(request));
        const result = await reply;
        assert.notEqual(result.type, 'download_started', `${filename} @ ${location} must not start a download`);
        if (result.type === 'error') assert.equal(result.code, 'BAD_ARGS');
      }
    }
    // The legitimate file is still reachable afterwards.
    const good = waitForMessage(client, (message) => message.type === 'download_started' || message.type === 'download_error');
    client.send(JSON.stringify({ type: 'download_start', filename: 'ok.txt', location: 'from-laptop' }));
    const started = await good;
    assert.equal(started.type, 'download_started', started.message);
  } finally {
    files.cleanup();
    await closeServer(server, sockets);
  }
});

test('malformed and non-string download arguments are rejected', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  try {
    const client = await connect(server);
    sockets.push(client);
    for (const filename of [42, null, undefined, {}, [], true, '']) {
      const reply = waitForMessage(client, (message) => message.type === 'download_started' || message.type === 'download_error' || message.type === 'error');
      client.send(JSON.stringify({ type: 'download_start', filename }));
      const result = await reply;
      assert.notEqual(result.type, 'download_started', `filename ${JSON.stringify(filename)} should be refused`);
      if (result.type === 'error') assert.equal(result.code, 'BAD_ARGS');
      else assert.match(result.message, /Invalid filename|File not found/);
    }
    // Bad chunk arguments are refused too.
    const badChunk = waitForMessage(client, (message) => message.type === 'download_chunk' || message.type === 'error' || message.type === 'download_error');
    client.send(JSON.stringify({ type: 'download_chunk_request', transferId: 'made-up', chunkIndex: 0 }));
    assert.notEqual((await badChunk).type, 'download_chunk');
    const badIndex = waitForMessage(client, (message) => message.type === 'download_chunk' || message.type === 'error' || message.type === 'download_error');
    client.send(JSON.stringify({ type: 'download_chunk_request', transferId: 'made-up', chunkIndex: 'zero' }));
    assert.notEqual((await badIndex).type, 'download_chunk');
  } finally {
    await closeServer(server, sockets);
  }
});

test('delete removes a shared file and refuses everything else', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  const files = seed(server, [
    { location: 'from-laptop', name: 'DeleteMe.pdf', contents: 'x' },
    { location: 'from-phone', name: 'KeepMe.pdf', contents: 'y' }
  ]);
  const target = sharedPath(server, 'from-laptop', 'DeleteMe.pdf');
  try {
    const anonymous = await connect(server, { auth: false });
    sockets.push(anonymous);
    let denied = waitForMessage(anonymous, (message) => message.type === 'error');
    anonymous.send(JSON.stringify({ type: 'delete_file', filename: 'DeleteMe.pdf', location: 'from-laptop' }));
    assert.equal((await denied).code, 'UNAUTHENTICATED');
    assert.equal(fs.existsSync(target), true, 'an unauthenticated delete changes nothing');

    const client = await connect(server);
    sockets.push(client);

    for (const filename of ['../DeleteMe.pdf', '..\\DeleteMe.pdf', 'C:\\DeleteMe.pdf', '/etc/passwd', '%2e%2e%2fDeleteMe.pdf', 'missing.pdf']) {
      const reply = waitForMessage(client, (message) => message.type === 'file_deleted' || message.type === 'error');
      client.send(JSON.stringify({ type: 'delete_file', filename, location: 'from-laptop' }));
      const result = await reply;
      assert.equal(result.type, 'error', `${filename} must not be deleted`);
      assert.equal(fs.existsSync(target), true, `${filename} must not remove the real file`);
    }

    const listed = waitForMessage(client, (message) => message.type === 'shared_file_list');
    client.send(JSON.stringify({ type: 'list_shared_files' }));
    const before = await listed;
    assert.ok(before.shared.some((file) => file.name === 'DeleteMe.pdf'));

    const unconfirmed = waitForMessage(client, (message) => message.type === 'file_deleted' || message.type === 'error');
    client.send(JSON.stringify({ type: 'delete_file', filename: 'DeleteMe.pdf', location: 'from-laptop' }));
    const refused = await unconfirmed;
    assert.equal(refused.type, 'error');
    assert.equal(refused.code, 'DELETE_CONFIRM_REQUIRED');
    assert.equal(fs.existsSync(target), true, 'delete without confirmation must not remove the file');

    const deleted = waitForMessage(client, (message) => message.type === 'file_deleted' || message.type === 'error');
    client.send(JSON.stringify({ type: 'delete_file', filename: 'DeleteMe.pdf', location: 'from-laptop', confirm: true }));
    const result = await deleted;
    assert.equal(result.type, 'file_deleted', result.message);
    assert.equal(result.filename, 'DeleteMe.pdf');
    assert.equal(fs.existsSync(target), false);

    const relisted = waitForMessage(client, (message) => message.type === 'shared_file_list');
    client.send(JSON.stringify({ type: 'list_shared_files' }));
    const after = await relisted;
    assert.equal(after.shared.some((file) => file.name === 'DeleteMe.pdf'), false);
    assert.equal(after.shared.some((file) => file.name === 'KeepMe.pdf'), true, 'the other root is untouched');
  } finally {
    files.cleanup();
    if (fs.existsSync(target)) fs.unlinkSync(target);
    await closeServer(server, sockets);
  }
});

test('a large shared file lists correctly and streams in full', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  const size = 300 * 1024;
  const contents = Buffer.alloc(size, 0x61);
  const files = seed(server, [{ location: 'from-laptop', name: 'Large.bin', contents }]);
  try {
    const client = await connect(server);
    sockets.push(client);
    const listed = waitForMessage(client, (message) => message.type === 'shared_file_list');
    client.send(JSON.stringify({ type: 'list_shared_files' }));
    const listing = await listed;
    const entry = listing.shared.find((file) => file.name === 'Large.bin');
    assert.equal(entry.size, size);
    assert.equal(entry.type, 'application/octet-stream', 'an unknown type is never guessed');

    const start = waitForMessage(client, (message) => message.type === 'download_started' || message.type === 'download_error');
    client.send(JSON.stringify({ type: 'download_start', filename: 'Large.bin', location: 'from-laptop' }));
    const started = await start;
    assert.equal(started.type, 'download_started', started.message);
    assert.equal(started.chunkSize, 64 * 1024);
    const bytes = await downloadAll(client, started, started.fileSize);
    assert.equal(bytes.length, size);
    assert.equal(bytes.equals(contents), true);
  } finally {
    files.cleanup();
    await closeServer(server, sockets);
  }
});

test('a file that cannot be addressed by name is omitted from the listing', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  const files = seed(server, [{ location: 'from-laptop', name: 'Visible.txt', contents: 'ok' }]);
  // `a..b.txt` is a legal OS filename on Windows and POSIX, but Dexile refuses
  // to address any name containing `..`. It must exist on disk and still be
  // omitted from the client listing.
  const hidden = path.join(server.fileTransferPath, 'outgoing', 'a..b.txt');
  fs.writeFileSync(hidden, 'x');
  try {
    const client = await connect(server);
    sockets.push(client);
    const listed = waitForMessage(client, (message) => message.type === 'shared_file_list');
    client.send(JSON.stringify({ type: 'list_shared_files' }));
    const listing = await listed;
    const names = listing.shared.map((file) => file.name);
    assert.ok(names.includes('Visible.txt'));
    assert.equal(names.includes('a..b.txt'), false);
  } finally {
    if (fs.existsSync(hidden)) fs.unlinkSync(hidden);
    files.cleanup();
    await closeServer(server, sockets);
  }
});
