const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { once } = require('node:events');
const WebSocket = require('ws');
const robot = require('robotjs');
const DexileServer = require('../server.js');
const FileTransferManager = require('../filetransfer.js');

const clientHtml = fs.readFileSync(path.join(__dirname, '..', 'client.html'), 'utf8');

function extractFunctions(...namesAndNextMarkers) {
  return namesAndNextMarkers.map(([name, nextName]) => {
    const start = clientHtml.indexOf(`function ${name}(`);
    const regularEnd = clientHtml.indexOf(`\nfunction ${nextName}(`, start);
    const asyncEnd = clientHtml.indexOf(`\nasync function ${nextName}(`, start);
    const end = regularEnd < 0 ? asyncEnd : asyncEnd < 0 ? regularEnd : Math.min(regularEnd, asyncEnd);
    assert.notEqual(start, -1, `missing production function: ${name}`);
    assert.notEqual(end, -1, `missing end marker for production function: ${name}`);
    return clientHtml.slice(start, end);
  }).join('\n');
}

function createKeyboardHarness() {
  const listeners = new Map();
  const input = {
    value: '',
    addEventListener(type, listener) {
      listeners.set(type, listener);
    }
  };
  const sent = [];
  const toasts = [];
  const sandbox = {
    state: { capabilities: { keyboard: true }, modifiers: { ctrlKey: false, altKey: false, shiftKey: false } },
    $: () => input,
    send: (message) => sent.push(JSON.parse(JSON.stringify(message))),
    toast: (message) => toasts.push(message)
  };
  const initializeKeyboard = extractFunctions(['initKeyboardInput', 'sendSpecialKey']);
  vm.runInNewContext(`${initializeKeyboard}\nthis.initialize = initKeyboardInput;`, sandbox);
  sandbox.initialize();

  function event(overrides = {}) {
    return {
      key: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
      isComposing: false, inputType: 'insertText', data: null,
      preventDefault() { this.defaultPrevented = true; },
      getModifierState(name) { return name === 'AltGraph' && !!this.altGraph; },
      ...overrides
    };
  }

  return { input, listeners, sent, toasts, event };
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

async function connect(server) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.httpServer.address().port}`);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const auth = waitForMessage(ws, (message) => message.type === 'auth_success');
  ws.send(JSON.stringify({ type: 'auth', code: server.authCode }));
  return { ws, auth: await auth };
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

test('textarea uses inserted text once and ignores unidentified keydown values', { concurrency: false }, () => {
  const harness = createKeyboardHarness();
  const unidentified = harness.event({ key: 'Unidentified' });
  harness.listeners.get('keydown')(unidentified);
  assert.equal(unidentified.defaultPrevented, undefined);
  assert.deepEqual(harness.sent, []);

  harness.input.value = 'Hello Dexile 123! lower UPPER';
  harness.listeners.get('input')(harness.event({ data: 'Hello Dexile 123! lower UPPER' }));
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].type, 'keyboard');
  assert.equal(harness.sent[0].text, 'Hello Dexile 123! lower UPPER');
  assert.equal(harness.toasts.some(message => message.includes('Unsupported key: Unidentified')), false);

  const desktopKeydown = harness.event({ key: 'x' });
  harness.listeners.get('keydown')(desktopKeydown);
  assert.equal(desktopKeydown.defaultPrevented, undefined);
  harness.input.value += 'x';
  harness.listeners.get('input')(harness.event({ data: 'x' }));
  assert.equal(harness.sent.length, 2);
  assert.equal(harness.sent[1].text, 'x');
});

test('IME text is sent only at composition commit and special keys retain keydown handling', { concurrency: false }, () => {
  const harness = createKeyboardHarness();
  harness.listeners.get('compositionstart')();
  harness.input.value = 'ni';
  harness.listeners.get('input')(harness.event({ isComposing: true, inputType: 'insertCompositionText', data: 'ni' }));
  harness.input.value = 'ni hao';
  harness.listeners.get('input')(harness.event({ isComposing: true, inputType: 'insertCompositionText', data: 'ni hao' }));
  assert.deepEqual(harness.sent, []);

  harness.listeners.get('compositionend')(harness.event({ data: 'ni hao' }));
  harness.listeners.get('input')(harness.event({ inputType: 'insertFromComposition', data: 'ni hao' }));
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].text, 'ni hao');

  for (const key of ['Backspace', 'Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'F5']) {
    const keyEvent = harness.event({ key });
    harness.listeners.get('keydown')(keyEvent);
    assert.equal(keyEvent.defaultPrevented, true, `${key} should remain a handled keydown`);
    assert.equal(harness.sent.at(-1).key, key);
  }

  const shortcut = harness.event({ key: 'c', ctrlKey: true });
  harness.listeners.get('keydown')(shortcut);
  assert.equal(shortcut.defaultPrevented, true);
  assert.equal(harness.sent.at(-1).key, 'c');
  assert.equal(harness.sent.at(-1).ctrlKey, true);
});

test('existing keyboard message accepts committed text while preserving special-key dispatch', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  const originalTypeString = robot.typeString;
  const originalKeyTap = robot.keyTap;
  const typed = [];
  const tapped = [];
  try {
    robot.typeString = (text) => typed.push(text);
    robot.keyTap = (...args) => tapped.push(args);
    const { ws } = await connect(server);
    sockets.push(ws);

    const status = waitForMessage(ws, (message) => message.type === 'status');
    ws.send(JSON.stringify({ type: 'keyboard', text: 'Hello Dexile 123! lower UPPER' }));
    ws.send(JSON.stringify({ type: 'keyboard', key: 'Enter' }));
    ws.send(JSON.stringify({ type: 'get_status' }));
    await status;

    assert.deepEqual(typed, ['Hello Dexile 123! lower UPPER']);
    assert.deepEqual(tapped, [['enter', []]]);
  } finally {
    robot.typeString = originalTypeString;
    robot.keyTap = originalKeyTap;
    await closeServer(server, sockets);
  }
});

test('upload completion remains completed after the final progress acknowledgement', { concurrency: false }, () => {
  const functions = extractFunctions(
    ['registerTransfer', 'handleUploadProgress'],
    ['handleUploadProgress', 'handleTransferCompleted'],
    ['handleTransferCompleted', 'handleTransferCancelled'],
    ['handleTransferCancelled', 'updateTransfer'],
    ['transferMetricPatch', 'updateTransfer'],
    ['updateTransfer', 'renderTransfers'],
    ['renderTransfers', 'renderTransferRow'],
    ['renderTransferRow', 'formatTransferDuration'],
    ['formatTransferDuration', 'setTransferFilter'],
    ['onDownloadChunk', 'finalizeDownload'],
    ['setTransferFilter', 'clearTransfers'],
    ['clearTransfers', 'cancelTransfer'],
    ['cancelTransfer', 'retryTransfer'],
    ['retryTransfer', 'pruneTransferHistory'],
    ['pruneTransferHistory', 'setTheme'],
    ['uploadFile', 'onUploadStarted'],
    ['pumpUploadQueue', 'sendNextUploadChunk'],
    ['shortenFilename', 'fmtBytes'],
    ['pruneDownloadedBlobs', 'registerTransfer']
  );
  const list = { innerHTML: '' };
  const summary = { innerHTML: '' };
  const sandbox = {
    state: {
      transfers: new Map(), transferFilter: 'all', downloadBuffers: new Map(),
      downloadedBlobs: new Map(),
      uploadQueue: [], pendingDownloadStarts: [], pendingUploadStart: null,
      transferSequence: 0, connected: true
    },
    pendingUploads: new Map(),
    $: selector => selector === 'transferSummary' ? summary : list,
    esc: value => String(value),
    fmtBytes: value => `${value} bytes`,
    fmtTime: value => String(value),
    sendNextUploadChunk() {},
    requestNextDownloadChunk() {},
    send(message) { sandbox.messages.push(message); },
    messages: [],
    uploadFileCalls: [],
    downloadFileCalls: [],
    uploadFile(file) { sandbox.uploadFileCalls.push(file); },
    downloadFile(filename) { sandbox.downloadFileCalls.push(filename); },
    finalizeDownload(id) { sandbox.finalizedDownload = id; },
    handleListFiles() { sandbox.listRefreshes = (sandbox.listRefreshes || 0) + 1; }
  };
  vm.runInNewContext(`${functions}\nthis.register = registerTransfer; this.progress = handleUploadProgress; this.complete = handleTransferCompleted; this.cancel = handleTransferCancelled; this.fail = handleTransferFailure; this.chunk = onDownloadChunk; this.filter = setTransferFilter; this.clear = clearTransfers; this.retry = retryTransfer; this.queueUpload = uploadFile; this.pump = pumpUploadQueue;`, sandbox);
  sandbox.uploadFile = file => sandbox.uploadFileCalls.push(file);
  sandbox.downloadFile = filename => sandbox.downloadFileCalls.push(filename);

  sandbox.register('upload-1', 'phone.txt', 'upload', 70 * 1024);
  sandbox.progress({ transferId: 'upload-1', progress: 42 });
  assert.match(list.innerHTML, /Transferring/);
  sandbox.complete({ transferId: 'upload-1', direction: 'upload' });
  sandbox.progress({ transferId: 'upload-1', progress: 100 });
  assert.equal(sandbox.state.transfers.get('upload-1').status, 'Completed');
  assert.equal(sandbox.state.transfers.get('upload-1').progress, 100);
  assert.match(list.innerHTML, /Completed/);
  assert.doesNotMatch(list.innerHTML, /Transferring/);

  sandbox.register('upload-2', 'cancel.txt', 'upload', 1024);
  sandbox.cancel({ transferId: 'upload-2' });
  assert.equal(sandbox.state.transfers.get('upload-2').status, 'Cancelled');

  sandbox.register('download-1', 'desktop.txt', 'download', 8);
  sandbox.state.downloadBuffers.set('download-1', { lastChunkReceived: true, transferCompleted: false });
  sandbox.complete({ transferId: 'download-1', direction: 'download' });
  assert.equal(sandbox.state.transfers.get('download-1').status, 'Completed');
  assert.equal(sandbox.finalizedDownload, 'download-1');
  assert.equal(sandbox.listRefreshes, 2);

  sandbox.register('download-2', 'final-chunk.txt', 'download', 3);
  sandbox.state.downloadBuffers.set('download-2', { chunks: [], lastChunkReceived: false, transferCompleted: false });
  sandbox.complete({ transferId: 'download-2', direction: 'download' });
  assert.equal(sandbox.finalizedDownload, 'download-1');
  sandbox.chunk({ transferId: 'download-2', chunkIndex: 0, data: 'YWJj', isLastChunk: true, progress: 100, bytesTransferred: 3, totalBytes: 3 });
  assert.equal(sandbox.state.downloadBuffers.get('download-2').chunks[0], 'YWJj');
  assert.equal(sandbox.finalizedDownload, 'download-2');

  sandbox.register('failed-upload', 'retry.txt', 'upload', 3);
  const retryFile = { name: 'retry.txt', size: 3 };
  sandbox.state.transfers.get('failed-upload').file = retryFile;
  sandbox.fail('upload', { transferId: 'failed-upload', message: 'Write failed.' });
  assert.equal(sandbox.state.transfers.get('failed-upload').status, 'Failed');
  sandbox.filter('failed');
  assert.match(list.innerHTML, /retry.txt/);
  assert.doesNotMatch(list.innerHTML, /desktop.txt/);
  sandbox.retry('failed-upload');
  assert.deepEqual(sandbox.uploadFileCalls, [retryFile]);
  sandbox.clear('Failed');
  assert.equal(sandbox.state.transfers.has('failed-upload'), false);

  sandbox.filter('all');
  sandbox.state.transfers.clear();
  sandbox.messages.length = 0;
  sandbox.queueUpload({ name: 'first.txt', size: 1 });
  sandbox.queueUpload({ name: 'second.txt', size: 2 });
  assert.deepEqual(sandbox.messages.map(message => message.filename), ['first.txt']);
  assert.equal(sandbox.state.transfers.get('queued-upload-2').status, 'Queued');
  sandbox.state.pendingUploadStart = null;
  sandbox.pump();
  assert.deepEqual(sandbox.messages.map(message => message.filename), ['first.txt', 'second.txt']);
});

test('real upload finalizes the file and never reports progress after completion', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  const filename = `mobile-upload-${process.pid}-${Date.now()}.txt`;
  const incomingPath = path.join(server.fileTransferPath, 'incoming', filename);
  const outgoingPath = path.join(server.fileTransferPath, 'outgoing', filename);
  const contents = Buffer.alloc(70 * 1024, 65);
  try {
    fs.writeFileSync(outgoingPath, Buffer.from('download remains available'));
    const { ws } = await connect(server);
    sockets.push(ws);
    const startedReply = waitForMessage(ws, message => message.type === 'upload_started');
    ws.send(JSON.stringify({ type: 'upload_start', filename, fileSize: contents.length }));
    const started = await startedReply;

    const firstAck = waitForMessage(ws, message => message.type === 'upload_progress' && message.transferId === started.transferId);
    ws.send(JSON.stringify({
      type: 'upload_chunk', transferId: started.transferId, chunkIndex: 0,
      data: contents.subarray(0, started.chunkSize).toString('base64'), isLastChunk: false
    }));
    const firstProgress = await firstAck;
    assert.equal(firstProgress.bytesTransferred, started.chunkSize);
    assert.equal(firstProgress.totalBytes, contents.length);
    assert.equal(firstProgress.progress, started.chunkSize / contents.length * 100);
    assert.equal(typeof firstProgress.speedBps, 'number');
    assert.equal(typeof firstProgress.startedAt, 'string');

    const messages = [];
    ws.on('message', raw => messages.push(JSON.parse(raw)));
    const completionReply = waitForMessage(ws, message => message.type === 'transfer_completed' && message.transferId === started.transferId);
    ws.send(JSON.stringify({
      type: 'upload_chunk', transferId: started.transferId, chunkIndex: 1,
      data: contents.subarray(started.chunkSize).toString('base64'), isLastChunk: true
    }));
    const completion = await completionReply;
    // Give any stray late acknowledgement a chance to arrive before asserting
    // that none does.
    await new Promise(resolve => setTimeout(resolve, 150));
    const completionIndex = messages.findIndex(message => message.type === 'transfer_completed' && message.transferId === started.transferId);
    // Progress is broadcast by the manager, which emits the final 100% before it
    // emits completion. A finished transfer is never sent further progress: a
    // late update would make the Transfer Manager appear to move backwards.
    const lateProgress = messages.slice(completionIndex + 1).filter(message =>
      message.type === 'upload_progress' && message.transferId === started.transferId);
    assert.deepEqual(lateProgress, [], 'no progress is reported after completion');
    assert.equal(server.fileTransfer.getTransferStatus(started.transferId).status, 'completed');
    assert.equal(completion.bytesTransferred, contents.length);
    assert.equal(completion.totalBytes, contents.length);
    assert.equal(typeof completion.completedAt, 'string');
    // A completed phone upload is delivered to the Windows Downloads folder,
    // not left behind in the Dexile staging directory.
    const deliveredPath = path.join(TEST_DOWNLOADS, filename);
    assert.equal(fs.existsSync(deliveredPath), true, 'the file must exist in Downloads');
    assert.deepEqual(fs.readFileSync(deliveredPath), contents);
    assert.equal(fs.existsSync(incomingPath), false, 'nothing is left in the staging directory');

    const downloadStarted = waitForMessage(ws, message => message.type === 'download_started');
    ws.send(JSON.stringify({ type: 'download_start', filename }));
    const download = await downloadStarted;
    const downloadChunk = waitForMessage(ws, message => message.type === 'download_chunk');
    ws.send(JSON.stringify({ type: 'download_chunk_request', transferId: download.transferId, chunkIndex: 0 }));
    assert.equal(Buffer.from((await downloadChunk).data, 'base64').toString(), 'download remains available');

    const cancelStartedReply = waitForMessage(ws, message => message.type === 'upload_started');
    const cancelName = `${filename}.cancel.txt`;
    ws.send(JSON.stringify({ type: 'upload_start', filename: cancelName, fileSize: 1024 }));
    const cancelStarted = await cancelStartedReply;
    const cancelled = waitForMessage(ws, message => message.type === 'transfer_cancelled' && message.transferId === cancelStarted.transferId);
    ws.send(JSON.stringify({ type: 'upload_cancel', transferId: cancelStarted.transferId }));
    await cancelled;
    assert.equal(server.fileTransfer.getTransferStatus(cancelStarted.transferId), null);
  } finally {
    for (const file of [incomingPath, outgoingPath, path.join(TEST_DOWNLOADS, filename)]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    await closeServer(server, sockets);
  }
});

test('manager bounds metadata history and removes failed transfers from active state', { concurrency: false }, async () => {
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'dexile-transfer-manager-'));
  const manager = new FileTransferManager(basePath);
  manager.maxTransferHistory = 2;
  try {
    for (let index = 0; index < 3; index++) {
      const filename = `history-${index}.txt`;
      const content = Buffer.from(`file-${index}`);
      const upload = await manager.startUpload(filename, content.length, 'owner-a');
      await manager.handleChunk(upload.transferId, 0, content, true);
    }
    assert.equal(manager.transferHistory.length, 2);
    for (const transfer of manager.transferHistory) {
      assert.equal(Object.hasOwn(transfer, 'chunks'), false);
      assert.equal(Object.hasOwn(transfer, 'filePath'), false);
    }

    const failedSource = path.join(basePath, 'outgoing', 'failure.txt');
    fs.writeFileSync(failedSource, 'cannot read');
    const download = await manager.startDownload('failure.txt', 'owner-a');
    fs.unlinkSync(failedSource);
    let failureEvent;
    manager.once('failed', event => { failureEvent = event; });
    await assert.rejects(manager.getChunk(download.transferId, 0));
    assert.equal(manager.activeTransfers.has(download.transferId), false);
    assert.equal(manager.getTransferStatus(download.transferId).status, 'failed');
    assert.equal(failureEvent.transferId, download.transferId);
    assert.equal(failureEvent.direction, 'download');
    assert.equal(Object.hasOwn(failureEvent, 'filePath'), false);
  } finally {
    fs.rmSync(basePath, { recursive: true, force: true });
  }
});

test('simultaneous transfers remain session-owned and are cleaned up on disconnect', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  try {
    const owner = await connect(server);
    sockets.push(owner.ws);
    const observer = await connect(server);
    sockets.push(observer.ws);

    const ownerStart = waitForMessage(owner.ws, message => message.type === 'upload_started' && message.filename === 'owner-a.txt');
    owner.ws.send(JSON.stringify({ type: 'upload_start', filename: 'owner-a.txt', fileSize: 100 }));
    const ownerTransfer = await ownerStart;

    const observerStart = waitForMessage(observer.ws, message => message.type === 'upload_started' && message.filename === 'observer.txt');
    observer.ws.send(JSON.stringify({ type: 'upload_start', filename: 'observer.txt', fileSize: 100 }));
    const observerTransfer = await observerStart;

    const ownerSecondStart = waitForMessage(owner.ws, message => message.type === 'upload_started' && message.filename === 'owner-b.txt');
    owner.ws.send(JSON.stringify({ type: 'upload_start', filename: 'owner-b.txt', fileSize: 100 }));
    const ownerSecondTransfer = await ownerSecondStart;
    assert.equal(server.fileTransfer.activeTransfers.size, 3);

    const denied = waitForMessage(observer.ws, message => message.type === 'error' && message.code === 'TRANSFER_NOT_FOUND');
    observer.ws.send(JSON.stringify({ type: 'upload_cancel', transferId: ownerTransfer.transferId }));
    assert.equal((await denied).code, 'TRANSFER_NOT_FOUND');
    assert.equal(server.fileTransfer.activeTransfers.has(ownerTransfer.transferId), true);

    const ownerCancelled = waitForMessage(owner.ws, message => message.type === 'transfer_cancelled' && message.transferId === ownerTransfer.transferId);
    owner.ws.send(JSON.stringify({ type: 'upload_cancel', transferId: ownerTransfer.transferId }));
    await ownerCancelled;
    assert.equal(server.fileTransfer.activeTransfers.has(ownerTransfer.transferId), false);

    const ownerCloseCleanup = waitForMessage(observer.ws, message =>
      message.type === 'transfer_cancelled' && message.transferId === ownerSecondTransfer.transferId);
    owner.ws.close();
    await once(owner.ws, 'close');
    await ownerCloseCleanup;
    assert.equal(server.fileTransfer.activeTransfers.has(ownerSecondTransfer.transferId), false);
    assert.equal(server.fileTransfer.activeTransfers.has(observerTransfer.transferId), true);

    const observerCancelled = waitForMessage(observer.ws, message => message.type === 'transfer_cancelled' && message.transferId === observerTransfer.transferId);
    observer.ws.send(JSON.stringify({ type: 'upload_cancel', transferId: observerTransfer.transferId }));
    await observerCancelled;
    assert.equal(server.fileTransfer.activeTransfers.size, 0);
  } finally {
    await closeServer(server, sockets);
  }
});

test('upload write failure emits a safe failure event and releases active resources', { concurrency: false }, async () => {
  const server = await createServer();
  const sockets = [];
  const filename = `write-failure-${process.pid}-${Date.now()}.txt`;
  const incomingPath = path.join(server.fileTransferPath, 'incoming', filename);
  const originalWriteFileSync = fs.writeFileSync;
  try {
    const { ws } = await connect(server);
    sockets.push(ws);
    const startedReply = waitForMessage(ws, message => message.type === 'upload_started');
    ws.send(JSON.stringify({ type: 'upload_start', filename, fileSize: 3 }));
    const started = await startedReply;

    fs.writeFileSync = function(filePath, ...args) {
      if (path.resolve(String(filePath)) === path.resolve(incomingPath)) {
        originalWriteFileSync.call(this, filePath, Buffer.from('partial'));
        throw new Error('simulated disk failure');
      }
      return originalWriteFileSync.call(this, filePath, ...args);
    };

    const failureReply = waitForMessage(ws, message => message.type === 'transfer_failed' && message.transferId === started.transferId);
    const uploadError = waitForMessage(ws, message => message.type === 'upload_error' && message.transferId === started.transferId);
    ws.send(JSON.stringify({
      type: 'upload_chunk', transferId: started.transferId,
      chunkIndex: 0, data: Buffer.from('abc').toString('base64'), isLastChunk: true
    }));
    const failure = await failureReply;
    await uploadError;
    assert.equal(failure.direction, 'upload');
    assert.equal(Object.hasOwn(failure, 'filePath'), false);
    assert.equal(server.fileTransfer.activeTransfers.has(started.transferId), false);
    assert.equal(server.fileTransfer.getTransferStatus(started.transferId).status, 'failed');
    assert.equal(fs.existsSync(incomingPath), false);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    if (fs.existsSync(incomingPath)) fs.unlinkSync(incomingPath);
    await closeServer(server, sockets);
  }
});