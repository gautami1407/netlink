const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const WebSocket = require('ws');
const DexileServer = require('../server.js');
const FileTransferManager = require('../filetransfer.js');

const repoRoot = path.join(__dirname, '..');
let suiteCounter = 0;

// A private Downloads folder per harness so the real user's Downloads is
// never written to by a test run.
function makeDownloadsDir(label) {
  suiteCounter += 1;
  const dir = path.join(os.tmpdir(), `dexile-dl-test-${process.pid}-${suiteCounter}-${label}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

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

async function createServer(options = {}) {
  const server = new DexileServer(0, options);
  if (!server.httpServer.listening) await once(server.httpServer, 'listening');
  return server;
}

async function connect(server) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.httpServer.address().port}`);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const reply = waitForMessage(ws, (m) => m.type === 'auth_success' || m.type === 'auth_failed');
  ws.send(JSON.stringify({ type: 'auth', code: server.authCode }));
  const auth = await reply;
  assert.equal(auth.type, 'auth_success', auth.message || 'authentication failed');
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
}

function cleanDir(dir) {
  if (!dir) return;
  fs.rmSync(dir, { recursive: true, force: true });
}

function transferRoot(label) {
  const root = path.join(os.tmpdir(), `dexile-dl-root-${process.pid}-${suiteCounter}-${label}`);
  fs.mkdirSync(path.join(root, 'incoming'), { recursive: true });
  fs.mkdirSync(path.join(root, 'outgoing'), { recursive: true });
  fs.mkdirSync(path.join(root, 'temp'), { recursive: true });
  return root;
}

// Sends a whole file in 64KB chunks and resolves with the completion message.
async function uploadFile(ws, filename, contents) {
  const startedReply = waitForMessage(ws, (m) => m.type === 'upload_started' || m.type === 'upload_error');
  ws.send(JSON.stringify({ type: 'upload_start', filename, fileSize: contents.length }));
  const started = await startedReply;
  if (started.type === 'upload_error') return { started, completion: null, failed: true };
  const chunkSize = started.chunkSize;
  const completionReply = waitForMessage(ws, (m) => m.type === 'transfer_completed' || m.type === 'upload_error');
  for (let index = 0; index * chunkSize < contents.length || index === 0; index += 1) {
    const slice = contents.subarray(index * chunkSize, (index + 1) * chunkSize);
    if (slice.length === 0) break;
    ws.send(JSON.stringify({
      type: 'upload_chunk', transferId: started.transferId, chunkIndex: index,
      data: slice.toString('base64'), isLastChunk: (index + 1) * chunkSize >= contents.length
    }));
  }
  const completion = await completionReply;
  return { started, completion, failed: completion.type === 'upload_error' };
}

// --------------------------------------------------------- destination logic

test('the Downloads folder is resolved from the OS, with no hard-coded username', { concurrency: false }, () => {
  const source = fs.readFileSync(path.join(repoRoot, 'filetransfer.js'), 'utf8');
  // No path may be assembled by concatenating a user name.
  assert.doesNotMatch(source, /C:\\\\Users\\\\['"`]\s*\+/);
  assert.doesNotMatch(source, /Users[\\\/]['"`]\s*\+/);
  assert.doesNotMatch(source, /['"]C:\\\\Users/);
  // It must be built from the OS-provided home directory instead.
  assert.match(source, /os\.homedir\(\)/);
  assert.match(source, /path\.join\([^\n]*'Downloads'\)/);

  // On this machine it resolves to the real, existing Downloads folder.
  const manager = new FileTransferManager(transferRoot('resolve'));
  const resolved = manager.getDownloadsPath();
  assert.equal(typeof resolved, 'string');
  assert.ok(path.isAbsolute(resolved), 'the Downloads path is absolute');
  assert.equal(path.basename(resolved).toLowerCase(), 'downloads');
  const home = os.homedir();
  assert.ok(resolved.startsWith(home) || process.platform !== 'win32', 'it resolves under the current user profile');
  // Crucially it does not depend on where the transfer root happens to live.
  const elsewhere = new FileTransferManager(transferRoot('resolve2'));
  assert.equal(elsewhere.getDownloadsPath(), resolved, 'the Downloads folder is independent of the transfer root');
  cleanDir(elsewhere.basePath);

  cleanDir(manager.basePath);
});

test('an operator-supplied Downloads path is honoured (dependency injection)', { concurrency: false }, () => {
  const root = transferRoot('inject');
  const custom = makeDownloadsDir('custom');
  const manager = new FileTransferManager(root, { downloadsPath: custom });
  assert.equal(manager.getDownloadsPath(), custom);
  cleanDir(root);
  cleanDir(custom);
});

// ------------------------------------------------------------ happy uploads

test('a phone upload lands in the Windows Downloads folder with its bytes intact', { concurrency: false }, async () => {
  const downloads = makeDownloadsDir('basic');
  const root = transferRoot('basic');
  const server = await createServer({ transferPath: root, downloadsPath: downloads });
  const sockets = [];
  try {
    const ws = await connect(server);
    sockets.push(ws);
    const contents = Buffer.from('Dexile upload payload '.repeat(200));
    const { started, completion } = await uploadFile(ws, 'document.pdf', contents);

    assert.equal(started.type, 'upload_started');
    assert.equal(completion.type, 'transfer_completed', JSON.stringify(completion));
    assert.equal(completion.direction, 'upload');

    // The file physically exists in Downloads.
    const delivered = path.join(downloads, 'document.pdf');
    assert.equal(fs.existsSync(delivered), true, 'the file must exist in Downloads');
    assert.deepEqual(fs.readFileSync(delivered), contents, 'the bytes are unchanged');

    // Nothing is left in the Dexile staging directory.
    assert.deepEqual(fs.readdirSync(path.join(root, 'incoming')), [], 'staging is empty after delivery');

    // Transfer metadata is correct and no absolute path is disclosed.
    assert.equal(completion.filename, 'document.pdf');
    assert.equal(completion.totalBytes, contents.length);
    assert.equal(completion.bytesTransferred, contents.length);
    assert.equal(typeof completion.speedBps, 'number');
    assert.equal(typeof completion.completedAt, 'string');
    const serialised = JSON.stringify(completion);
    assert.doesNotMatch(serialised, /[A-Za-z]:\\/);
    assert.equal(serialised.includes(downloads), false);
  } finally {
    cleanDir(downloads);
    cleanDir(root);
    await closeServer(server, sockets);
  }
});

test('images, PDFs and archives all upload unchanged', { concurrency: false }, async () => {
  const downloads = makeDownloadsDir('types');
  const root = transferRoot('types');
  const server = await createServer({ transferPath: root, downloadsPath: downloads });
  const sockets = [];
  try {
    const ws = await connect(server);
    sockets.push(ws);
    const cases = [
      ['photo.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]), 'image/jpeg'],
      ['image.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png'],
      ['animation.gif', Buffer.from('GIF89a'.repeat(500)), 'image/gif'],
      ['screenshot.png', Buffer.from('screenshot-bytes'.repeat(1000)), 'image/png'],
      ['report.pdf', Buffer.from('%PDF-1.7\n'.padEnd(5000, 'x')), 'application/pdf'],
      ['example.zip', Buffer.from('PK'.repeat(2000)), 'application/zip']
    ];
    for (const [filename, contents, expectedType] of cases) {
      const { completion } = await uploadFile(ws, filename, contents);
      assert.equal(completion.type, 'transfer_completed', `${filename}: ${JSON.stringify(completion)}`);
      const delivered = path.join(downloads, filename);
      assert.equal(fs.existsSync(delivered), true, `${filename} must exist in Downloads`);
      assert.deepEqual(fs.readFileSync(delivered), contents, `${filename} bytes must be unchanged`);
      // The server decides the type; the client never supplies one.
      assert.equal(server.fileTransfer.getMimeType(filename), expectedType);
    }
  } finally {
    cleanDir(downloads);
    cleanDir(root);
    await closeServer(server, sockets);
  }
});

test('duplicate filenames are de-duplicated instead of overwriting', { concurrency: false }, async () => {
  const downloads = makeDownloadsDir('dupes');
  const root = transferRoot('dupes');
  const server = await createServer({ transferPath: root, downloadsPath: downloads });
  const sockets = [];
  try {
    const ws = await connect(server);
    sockets.push(ws);
    const first = Buffer.from('the original file');
    const second = Buffer.from('a different file with the same name');
    const third = Buffer.from('and a third one');

    // A file already in Downloads from earlier must survive.
    fs.writeFileSync(path.join(downloads, 'photo.jpg'), Buffer.from('pre-existing user file'));

    const results = [];
    for (const contents of [first, second, third]) {
      const { completion } = await uploadFile(ws, 'photo.jpg', contents);
      assert.equal(completion.type, 'transfer_completed', JSON.stringify(completion));
      results.push(completion.filename);
    }

    // The pre-existing file was never touched.
    assert.equal(fs.readFileSync(path.join(downloads, 'photo.jpg'), 'utf8'), 'pre-existing user file');
    // Each upload got its own name, and each holds the right bytes.
    assert.deepEqual(fs.readFileSync(path.join(downloads, 'photo (1).jpg')), first);
    assert.deepEqual(fs.readFileSync(path.join(downloads, 'photo (2).jpg')), second);
    assert.deepEqual(fs.readFileSync(path.join(downloads, 'photo (3).jpg')), third);
    assert.equal(new Set(results).size, 3, 'names are unique');
    assert.equal(results[0], 'photo (1).jpg');
  } finally {
    cleanDir(downloads);
    cleanDir(root);
    await closeServer(server, sockets);
  }
});

// ------------------------------------------------------------------ security

test('path traversal and absolute paths are neutralised', { concurrency: false }, async () => {
  const downloads = makeDownloadsDir('traversal');
  const root = transferRoot('traversal');
  const server = await createServer({ transferPath: root, downloadsPath: downloads });
  const sockets = [];
  try {
    const ws = await connect(server);
    sockets.push(ws);
    const contents = Buffer.from('traversal payload');
    const attempts = [
      '../../malicious.exe', '../../../Windows/System32/evil.dll',
      '..\\..\\malicious.exe', '..\\..\\Windows\\evil.dll',
      'C:\\Windows\\System32\\evil.dll', 'C:/Windows/evil.dll',
      'D:\\data\\secret.txt', '\\\\server\\share\\file.txt',
      '/etc/passwd', 'sub/dir/photo.jpg', 'sub\\dir\\photo.jpg',
      '%2e%2e%2fmalicious.exe', '....//....//evil.exe', '..%2fevil.exe',
      `nul${String.fromCharCode(0)}byte.png`, '.', '..'
    ];
    const homeBefore = fs.readdirSync(os.homedir());
    for (const filename of attempts) {
      const { started, completion } = await uploadFile(ws, filename, contents);
      if (started.type === 'upload_error') continue;
      assert.equal(completion.type, 'transfer_completed', `${filename}: ${JSON.stringify(completion)}`);
      const deliveredName = completion.filename;
      // Whatever the client sent, the result is a bare file directly in Downloads.
      assert.equal(path.dirname(path.join(downloads, deliveredName)), downloads, `${filename} stayed in Downloads`);
      assert.equal(path.basename(deliveredName), deliveredName);
      assert.equal(deliveredName.includes('/'), false);
      assert.equal(deliveredName.includes('\\'), false);
      assert.equal(deliveredName.includes('..'), false);
      assert.equal(fs.existsSync(path.join(downloads, deliveredName)), true);
    }
    // Nothing escaped into the user profile.
    assert.deepEqual(fs.readdirSync(os.homedir()), homeBefore, 'no file was written outside Downloads');
    // Every delivered file is a direct child of the Downloads folder.
    for (const name of fs.readdirSync(downloads)) {
      assert.equal(path.dirname(path.join(downloads, name)), downloads);
    }
  } finally {
    cleanDir(downloads);
    cleanDir(root);
    await closeServer(server, sockets);
  }
});

test('a client cannot choose the destination', { concurrency: false }, async () => {
  const downloads = makeDownloadsDir('nodest');
  const root = transferRoot('nodest');
  const server = await createServer({ transferPath: root, downloadsPath: downloads });
  const sockets = [];
  try {
    const ws = await connect(server);
    sockets.push(ws);
    const elsewhere = path.join(os.tmpdir(), `dexile-should-not-exist-${process.pid}`);
    for (const extra of [
      { destinationPath: elsewhere }, { savePath: elsewhere },
      { folderPath: elsewhere }, { path: elsewhere }, { directory: elsewhere },
      { downloadsPath: elsewhere }, { target: elsewhere }
    ]) {
      const startedReply = waitForMessage(ws, (m) => m.type === 'upload_started' || m.type === 'upload_error' || m.type === 'error');
      ws.send(JSON.stringify({ type: 'upload_start', filename: 'forced.txt', fileSize: 4, ...extra }));
      const started = await startedReply;
      assert.notEqual(started.type, 'error', 'an unknown field is simply ignored, not honoured');
      if (started.type === 'upload_started') {
        const completionReply = waitForMessage(ws, (m) => m.type === 'transfer_completed' || m.type === 'upload_error');
        ws.send(JSON.stringify({
          type: 'upload_chunk', transferId: started.transferId, chunkIndex: 0,
          data: Buffer.from('abcd').toString('base64'), isLastChunk: true
        }));
        await completionReply;
      }
    }
    assert.equal(fs.existsSync(path.join(downloads, 'forced.txt')), true, 'the file went to the real Downloads');
    assert.equal(fs.existsSync(elsewhere), false, 'the client-supplied destination was ignored and never created');
  } finally {
    cleanDir(downloads);
    cleanDir(root);
    await closeServer(server, sockets);
  }
});

// ------------------------------------------------------ failure and staging

test('a failed upload never reaches the Downloads folder', { concurrency: false }, async () => {
  const downloads = makeDownloadsDir('fail');
  const root = transferRoot('fail');
  // Point Downloads at a directory that cannot be written to.
  const blocked = path.join(root, 'no-such-downloads', 'nested');
  const server = await createServer({ transferPath: root, downloadsPath: blocked });
  const sockets = [];
  try {
    const ws = await connect(server);
    sockets.push(ws);
    const { started, completion } = await uploadFile(ws, 'broken.txt', Buffer.alloc(4096, 7));
    assert.equal(started.type, 'upload_started');
    assert.equal(completion.type, 'upload_error', 'the upload reports failure');
    assert.equal(fs.existsSync(blocked), false, 'no Downloads directory was created for a failed upload');
    assert.deepEqual(fs.readdirSync(path.join(root, 'incoming')), [], 'the partial file was cleaned up');
    assert.equal(server.fileTransfer.activeTransfers.size, 0, 'no transfer is left active');
  } finally {
    cleanDir(downloads);
    cleanDir(root);
    await closeServer(server, sockets);
  }
});

test('a partial upload that is cancelled never reaches the Downloads folder', { concurrency: false }, async () => {
  const downloads = makeDownloadsDir('partial');
  const root = transferRoot('partial');
  const server = await createServer({ transferPath: root, downloadsPath: downloads });
  const sockets = [];
  try {
    const ws = await connect(server);
    sockets.push(ws);
    const startedReply = waitForMessage(ws, (m) => m.type === 'upload_started' || m.type === 'upload_error');
    ws.send(JSON.stringify({ type: 'upload_start', filename: 'partial.jpg', fileSize: 400 * 1024 }));
    const started = await startedReply;
    assert.equal(started.type, 'upload_started');

    const ack = waitForMessage(ws, (m) => m.type === 'upload_progress' && m.transferId === started.transferId);
    ws.send(JSON.stringify({
      type: 'upload_chunk', transferId: started.transferId, chunkIndex: 0,
      data: Buffer.alloc(1024, 3).toString('base64'), isLastChunk: false
    }));
    await ack;
    assert.notEqual(server.fileTransfer.getTransferStatus(started.transferId).status, 'completed',
      'an in-flight upload is never reported complete');

    const cancelled = waitForMessage(ws, (m) => m.type === 'transfer_cancelled' || m.type === 'upload_error');
    ws.send(JSON.stringify({ type: 'upload_cancel', transferId: started.transferId }));
    await cancelled;

    assert.equal(server.fileTransfer.activeTransfers.has(started.transferId), false,
      'a cancelled upload is no longer active');
    assert.equal(fs.existsSync(path.join(downloads, 'partial.jpg')), false, 'a partial upload is never delivered');
    assert.deepEqual(fs.readdirSync(downloads), [], 'Downloads stays empty');
  } finally {
    cleanDir(downloads);
    cleanDir(root);
    await closeServer(server, sockets);
  }
});

test('a transfer is only reported completed after the file is verified in Downloads', { concurrency: false }, async () => {
  const downloads = makeDownloadsDir('ordering');
  const root = transferRoot('ordering');
  const server = await createServer({ transferPath: root, downloadsPath: downloads });
  const sockets = [];
  const order = [];
  try {
    const ws = await connect(server);
    sockets.push(ws);
    const originalStatSync = fs.statSync;
    fs.statSync = function patched(target, ...rest) {
      const result = originalStatSync.call(this, target, ...rest);
      if (String(target).startsWith(downloads)) order.push('file-verified-in-downloads');
      return result;
    };
    try {
      const { completion } = await uploadFile(ws, 'ordered.pdf', Buffer.alloc(9000, 1));
      order.push('transfer-reported-completed');
      assert.equal(completion.type, 'transfer_completed');
    } finally {
      fs.statSync = originalStatSync;
    }
    assert.equal(order[0], 'file-verified-in-downloads', 'the file is confirmed first');
    assert.equal(order.at(-1), 'transfer-reported-completed', 'completion is reported last');
  } finally {
    cleanDir(downloads);
    cleanDir(root);
    await closeServer(server, sockets);
  }
});

// ------------------------------------------------------ unchanged behaviour

test('laptop to phone downloads still work exactly as before', { concurrency: false }, async () => {
  const downloads = makeDownloadsDir('download');
  const root = transferRoot('download');
  const server = await createServer({ transferPath: root, downloadsPath: downloads });
  const sockets = [];
  try {
    const ws = await connect(server);
    sockets.push(ws);
    const outgoing = path.join(root, 'outgoing', 'laptop-file.pdf');
    const contents = Buffer.from('a file the laptop is offering'.repeat(300));
    fs.writeFileSync(outgoing, contents);

    const startedReply = waitForMessage(ws, (m) => m.type === 'download_started' || m.type === 'download_error');
    ws.send(JSON.stringify({ type: 'download_start', filename: 'laptop-file.pdf' }));
    const started = await startedReply;
    assert.equal(started.type, 'download_started', started.message);
    assert.equal(started.filename, 'laptop-file.pdf');
    assert.equal(started.fileSize, contents.length);

    const chunks = [];
    let index = 0;
    for (;;) {
      const reply = waitForMessage(ws, (m) => m.type === 'download_chunk' || m.type === 'download_error');
      ws.send(JSON.stringify({ type: 'download_chunk_request', transferId: started.transferId, chunkIndex: index }));
      const chunk = await reply;
      assert.equal(chunk.type, 'download_chunk', JSON.stringify(chunk));
      chunks.push(Buffer.from(chunk.data, 'base64'));
      if (chunk.isLastChunk) break;
      index += 1;
    }
    assert.deepEqual(Buffer.concat(chunks), contents, 'the download is byte-identical');
    // Downloading from the laptop is untouched by the upload destination.
    assert.deepEqual(fs.readdirSync(downloads), [], 'a laptop-to-phone download does not write to Downloads');
  } finally {
    cleanDir(downloads);
    cleanDir(root);
    await closeServer(server, sockets);
  }
});

test('Shared Files still lists both shared roots and the delivered file', { concurrency: false }, async () => {
  const downloads = makeDownloadsDir('shared');
  const root = transferRoot('shared');
  const server = await createServer({ transferPath: root, downloadsPath: downloads });
  const sockets = [];
  try {
    const ws = await connect(server);
    sockets.push(ws);
    fs.writeFileSync(path.join(root, 'outgoing', 'FromLaptop.pdf'), Buffer.from('laptop side'));
    fs.writeFileSync(path.join(root, 'incoming', 'staged.txt'), Buffer.from('legacy staging'));

    const { completion } = await uploadFile(ws, 'FromPhone.jpg', Buffer.alloc(2048, 9));
    assert.equal(completion.type, 'transfer_completed');

    const listed = waitForMessage(ws, (m) => m.type === 'shared_file_list');
    ws.send(JSON.stringify({ type: 'list_shared_files' }));
    const listing = await listed;
    const names = listing.shared.map((file) => `${file.location}:${file.name}`);
    assert.ok(names.includes('from-laptop:FromLaptop.pdf'));
    assert.ok(names.includes('from-phone:staged.txt'), 'legacy staging files are still listed');
    assert.ok(names.includes('from-phone:FromPhone.jpg'), 'the delivered upload is listed');

    const phoneFile = listing.shared.find((file) => file.name === 'FromPhone.jpg');
    assert.equal(phoneFile.size, 2048);
    assert.equal(phoneFile.type, 'image/jpeg');
    assert.equal(Object.prototype.hasOwnProperty.call(phoneFile, 'filePath'), false);
    assert.equal(JSON.stringify(listing).includes(downloads), false, 'no absolute path is disclosed');

    // The rest of the user's Downloads folder stays invisible.
    fs.writeFileSync(path.join(downloads, 'unrelated-private.txt'), 'not shared');
    const relisted = waitForMessage(ws, (m) => m.type === 'shared_file_list');
    ws.send(JSON.stringify({ type: 'list_shared_files' }));
    const after = await relisted;
    assert.equal(after.shared.some((file) => file.name === 'unrelated-private.txt'), false,
      'files Dexile did not deliver are never listed');

    // A delivered file can still be read back and deleted through Shared Files.
    const startReply = waitForMessage(ws, (m) => m.type === 'download_started' || m.type === 'download_error');
    ws.send(JSON.stringify({ type: 'download_start', filename: 'FromPhone.jpg', location: 'from-phone' }));
    assert.equal((await startReply).type, 'download_started');

    const deleted = waitForMessage(ws, (m) => m.type === 'file_deleted' || m.type === 'error');
    ws.send(JSON.stringify({ type: 'delete_file', filename: 'FromPhone.jpg', location: 'from-phone', confirm: true }));
    const deleteResult = await deleted;
    assert.equal(deleteResult.type, 'file_deleted', JSON.stringify(deleteResult));
    assert.equal(fs.existsSync(path.join(downloads, 'FromPhone.jpg')), false);
  } finally {
    cleanDir(downloads);
    cleanDir(root);
    await closeServer(server, sockets);
  }
});

test('the Transfer Manager still reports progress, speed and completion for an upload', { concurrency: false }, async () => {
  const downloads = makeDownloadsDir('manager');
  const root = transferRoot('manager');
  const server = await createServer({ transferPath: root, downloadsPath: downloads });
  const sockets = [];
  try {
    const ws = await connect(server);
    sockets.push(ws);
    const seen = [];
    ws.on('message', (raw) => {
      const message = JSON.parse(raw);
      if (['upload_started', 'transfer_progress', 'transfer_completed'].includes(message.type)) seen.push(message);
    });

    const contents = Buffer.alloc(200 * 1024, 6);
    const { started, completion } = await uploadFile(ws, 'manager-report.pdf', contents);
    assert.equal(started.type, 'upload_started');
    assert.equal(completion.type, 'transfer_completed');

    const progress = seen.filter((m) => m.type === 'transfer_progress');
    assert.ok(progress.length > 0, 'progress is reported');
    assert.ok(progress.every((m) => m.transferId === started.transferId));
    assert.ok(progress.some((m) => m.progress === 100), 'a 100% progress acknowledgement is sent');
    assert.ok(progress.every((m) => typeof m.speedBps === 'number' && typeof m.totalBytes === 'number'));
    assert.deepEqual(progress.map((m) => m.progress), [...progress.map((m) => m.progress)].sort((a, b) => a - b),
      'progress never goes backwards');

    // Completion is the last of the three, and never precedes the file existing.
    assert.equal(seen.at(-1).type, 'transfer_completed');
    assert.equal(completion.totalBytes, contents.length);
    assert.equal(completion.bytesTransferred, contents.length);
    const delivered = path.join(downloads, 'manager-report.pdf');
    assert.equal(fs.existsSync(delivered), true);
    assert.equal(fs.statSync(delivered).size, contents.length, 'the delivered file is the whole payload');

    const status = server.fileTransfer.getTransferStatus(started.transferId);
    assert.equal(status.status, 'completed');
    assert.equal(status.direction, 'upload');
  } finally {
    cleanDir(downloads);
    cleanDir(root);
    await closeServer(server, sockets);
  }
});
