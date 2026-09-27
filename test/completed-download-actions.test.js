const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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

const SOURCE = extractFunctions(
  ['esc', 'fmtBytes'],
  ['registerTransfer', 'handleUploadProgress'],
  ['handleTransferCompleted', 'handleTransferCancelled'],
  ['handleTransferCancelled', 'updateTransfer'],
  ['updateTransfer', 'renderTransfers'],
  ['renderTransfers', 'renderTransferRow'],
  ['renderTransferRow', 'formatTransferDuration'],
  ['formatTransferDuration', 'setTransferFilter'],
  ['setTransferFilter', 'clearTransfers'],
  ['clearTransfers', 'cancelTransfer'],
  ['cancelTransfer', 'retryTransfer'],
  ['retryTransfer', 'pruneTransferHistory'],
  ['pruneTransferHistory', 'setTheme'],
  ['requestNextDownloadChunk', 'onDownloadChunk'],
  // finalizeDownload, the bounded completed-blob cache, and its actions.
  // (deleteFile was replaced by the Shared Files confirm-dialog flow; the
  // transfers section now begins with registerTransfer.)
  ['onDownloadChunk', 'registerTransfer']
);

function createHarness({ popupsBlocked = false } = {}) {
  const list = { innerHTML: '' };
  const summary = { innerHTML: '' };
  const toasts = [];
  const sent = [];
  const createdUrls = [];
  const revokedUrls = [];
  const linkClicks = [];
  const openedTabs = [];
  const timers = [];
  let urlSequence = 0;
  let clock = 1700000000000;

  const document = {
    body: { appendChild: (node) => node },
    createElement: () => ({
      href: '', download: '', rel: '',
      click() { linkClicks.push({ href: this.href, download: this.download }); },
      remove() {}
    })
  };

  const sandbox = {
    state: {
      transfers: new Map(), transferFilter: 'all', downloadBuffers: new Map(),
      downloadedBlobs: new Map(),
      uploadQueue: [], pendingDownloadStarts: [], pendingUploadStart: null,
      transferSequence: 0, connected: true
    },
    pendingUploads: new Map(),
    // A controllable clock makes the oversized grace window deterministic.
    Date: { now: () => clock },
    $: (selector) => (selector === 'transferSummary' ? summary : list),
    esc: undefined,
    fmtBytes: (value) => `${value} bytes`,
    fmtTime: (value) => `t${value}`,
    toast: (message) => toasts.push(message),
    send: (message) => sent.push(JSON.parse(JSON.stringify(message))),
    listRefreshes: 0,
    handleListFiles() { sandbox.listRefreshes += 1; },
    pumpUploadQueue() {},
    uploadFileCalls: [],
    downloadFileCalls: [],
    uploadFile(file) { sandbox.uploadFileCalls.push(file); },
    downloadFile(filename) { sandbox.downloadFileCalls.push(filename); },
    atob: (value) => Buffer.from(String(value), 'base64').toString('binary'),
    Blob: globalThis.Blob,
    document,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    URL: {
      createObjectURL(blob) {
        const url = `blob:dexile-test-${++urlSequence}`;
        createdUrls.push({ url, blob });
        return url;
      },
      revokeObjectURL(url) { revokedUrls.push(url); }
    },
    window: {
      open(url, target) {
        if (popupsBlocked) return null;
        openedTabs.push({ url, target });
        return { opener: {} };
      }
    }
  };

  vm.runInNewContext(`${SOURCE}\nObject.assign(this, {
    register: registerTransfer,
    complete: handleTransferCompleted,
    cancel: cancelTransfer,
    fail: handleTransferFailure,
    render: renderTransfers,
    clear: clearTransfers,
    filter: setTransferFilter,
    retry: retryTransfer,
    prune: pruneTransferHistory,
    finalize: finalizeDownload,
    chunk: onDownloadChunk,
    retain: retainDownloadedBlob,
    getBlob: getDownloadedBlob,
    hasBlob: hasDownloadedBlob,
    release: releaseDownloadedBlob,
    releaseAll: releaseAllDownloadedBlobs,
    pruneBlobs: pruneDownloadedBlobs,
    openFile: openDownloadedFile,
    downloadAgain,
    detectMime: detectDownloadMimeType,
    shorten: shortenFilename
  });`, sandbox);

  sandbox.runTimers = () => { const pending = timers.splice(0, timers.length); for (const timer of pending) timer.fn(); };
  sandbox.advanceClock = (ms) => { clock += ms; };
  sandbox.pendingTimers = () => timers.slice();
  return { sandbox, list, toasts, sent, createdUrls, revokedUrls, linkClicks, openedTabs, runTimers: sandbox.runTimers };
}

// Matches the production budgets instead of duplicating them in the test.
const MAX_ENTRIES = Number(/DOWNLOAD_CACHE_MAX_ENTRIES = (\d+)/.exec(clientHtml)[1]);
const MAX_BYTES = Number(/DOWNLOAD_CACHE_MAX_BYTES = (\d+) \* 1024 \* 1024/.exec(clientHtml)[1]) * 1024 * 1024;
const OVERSIZE_TTL_MS = Number(/DOWNLOAD_OVERSIZE_TTL_MS = (\d+) \* 1000/.exec(clientHtml)[1]) * 1000;

function blobOfBytes(size) {
  // The real payload stays tiny; only the reported size drives the budget.
  const blob = new Blob([new Uint8Array(1)]);
  Object.defineProperty(blob, 'size', { value: size });
  return blob;
}

function cachedBytes(sandbox) {
  let total = 0;
  for (const entry of sandbox.state.downloadedBlobs.values()) {
    if (!entry.oversized) total += entry.size;
  }
  return total;
}

function normalCount(sandbox) {
  return [...sandbox.state.downloadedBlobs.values()].filter((entry) => !entry.oversized).length;
}

function base64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function completeDownload(harness, id, filename, contents) {
  harness.sandbox.state.downloadBuffers.set(id, {
    chunks: [base64(contents)], fileSize: contents.length, filename,
    chunkSize: 64 * 1024, nextIndex: 1, lastChunkReceived: true, transferCompleted: true
  });
  harness.sandbox.finalize(id);
}

// ------------------------------------------------------------------- rendering

test('completed downloads offer Open and Download Again', { concurrency: false }, () => {
  const harness = createHarness();
  const { sandbox, list } = harness;
  sandbox.register('dl-1', 'Receipt_20260921103530.pdf', 'download', 5);
  completeDownload(harness, 'dl-1', 'Receipt_20260921103530.pdf', 'hello');
  sandbox.complete({ transferId: 'dl-1', direction: 'download' });

  assert.equal(sandbox.state.transfers.get('dl-1').status, 'Completed');
  assert.match(list.innerHTML, /Open/);
  assert.match(list.innerHTML, /Download Again/);
  assert.match(list.innerHTML, /Dexile\.openDownloadedFile\('dl-1'\)/);
  assert.match(list.innerHTML, /Dexile\.downloadAgain\('dl-1'\)/);
  assert.equal(sandbox.hasBlob('dl-1'), true);
});

test('Open and Download Again are hidden for every non-completed state', { concurrency: false }, () => {
  const harness = createHarness();
  const { sandbox, list } = harness;
  const cases = [
    ['active-queued', 'Queued'],
    ['active-starting', 'Starting'],
    ['active-transferring', 'Transferring'],
    ['active-downloading', 'Downloading'],
    ['active-cancelling', 'Cancelling'],
    ['failed', 'Failed'],
    ['cancelled', 'Cancelled']
  ];
  for (const [id, status] of cases) {
    sandbox.state.transfers.set(id, {
      id, filename: `${id}.pdf`, direction: 'download', size: 10, totalBytes: 10,
      bytesTransferred: 5, progress: 50, speedBps: 10, etaSeconds: null,
      status, queuedAt: Date.now(), startedAt: Date.now(), completedAt: Date.now(), error: null
    });
  }
  // Even if stale bytes survive under a cancelled id, an incomplete transfer
  // must never advertise Open.
  sandbox.retain('cancelled', 'cancelled.pdf', new Blob(['x'], { type: 'application/pdf' }));
  sandbox.render();

  for (const [id] of cases) {
    const row = list.innerHTML.split('<article class="transfer-row">').find((part) => part.includes(id));
    assert.ok(row, `expected a row for ${id}`);
    assert.doesNotMatch(row, />Open</, `${id} must not offer Open`);
    assert.doesNotMatch(row, /Download Again/, `${id} must not offer Download Again`);
  }
  assert.match(list.innerHTML, />Retry</);
});

test('completed uploads do not receive download actions', { concurrency: false }, () => {
  const harness = createHarness();
  const { sandbox, list } = harness;
  sandbox.register('up-1', 'desktop-report.pdf', 'upload', 5);
  sandbox.complete({ transferId: 'up-1', direction: 'upload' });

  assert.equal(sandbox.state.transfers.get('up-1').status, 'Completed');
  assert.doesNotMatch(list.innerHTML, /Open/);
  assert.doesNotMatch(list.innerHTML, /Download Again/);
  assert.doesNotMatch(list.innerHTML, /openDownloadedFile/);
  assert.equal(sandbox.hasBlob('up-1'), false);
});

test('Open is disabled when no local copy survives but Download Again still works', { concurrency: false }, () => {
  const harness = createHarness();
  const { sandbox, list } = harness;
  sandbox.register('dl-evicted', 'evicted.pdf', 'download', 5);
  completeDownload(harness, 'dl-evicted', 'evicted.pdf', 'hello');
  sandbox.complete({ transferId: 'dl-evicted', direction: 'download' });
  assert.doesNotMatch(list.innerHTML, /openDownloadedFile\('dl-evicted'\)" disabled/, 'sanity: Open starts enabled');

  sandbox.release('dl-evicted');
  sandbox.render();
  assert.match(list.innerHTML, /openDownloadedFile\('dl-evicted'\)" disabled/);
  assert.match(list.innerHTML, /Dexile\.downloadAgain\('dl-evicted'\)/);

  assert.equal(sandbox.openFile('dl-evicted'), false);
  assert.match(harness.toasts.at(-1), /no longer held by the browser/);
});

// ----------------------------------------------------------------- open action

test('Open reuses the completed local blob instead of re-requesting the file', { concurrency: false }, () => {
  const harness = createHarness();
  const { sandbox, openedTabs, createdUrls, sent } = harness;
  sandbox.register('dl-open', 'Receipt.pdf', 'download', 5);
  completeDownload(harness, 'dl-open', 'Receipt.pdf', 'hello');
  const cached = sandbox.getBlob('dl-open');
  const createdBefore = createdUrls.length;

  assert.equal(sandbox.openFile('dl-open'), true);
  assert.equal(openedTabs.length, 1);
  assert.deepEqual(sent.filter((message) => message.type.startsWith('download_')), []);
  assert.deepEqual(sandbox.downloadFileCalls, []);
  // The viewer is handed the very blob the download already assembled: one new
  // object URL over the same bytes, and no second trip to the server.
  assert.equal(createdUrls.length, createdBefore + 1);
  assert.equal(createdUrls.at(-1).blob, cached);
  assert.equal(harness.openedTabs[0].url, createdUrls.at(-1).url);

  // Reopening reuses the same object URL instead of allocating a new one.
  sandbox.openFile('dl-open');
  assert.equal(openedTabs.length, 2);
  assert.equal(openedTabs[0].url, openedTabs[1].url);
  assert.equal(createdUrls.length, createdBefore + 1);
  assert.equal(harness.revokedUrls.includes(openedTabs[0].url), false);
});

test('Open falls back to a browser save when the viewer is blocked', { concurrency: false }, () => {
  const harness = createHarness({ popupsBlocked: true });
  const { sandbox, linkClicks, revokedUrls } = harness;
  sandbox.register('dl-blocked', 'Blocked.pdf', 'download', 7);
  completeDownload(harness, 'dl-blocked', 'Blocked.pdf', 'blocked');

  assert.equal(sandbox.openFile('dl-blocked'), true);
  assert.equal(linkClicks.length, 2, 'one save on completion plus one fallback save');
  assert.equal(linkClicks.at(-1).download, 'Blocked.pdf');
  assert.match(harness.toasts.at(-1), /viewer was blocked/);
  harness.runTimers();
  assert.equal(revokedUrls.length, 2, 'both short-lived save URLs are revoked');
  assert.equal(revokedUrls.includes(sandbox.state.downloadedBlobs.get('dl-blocked').url), false, 'the cached viewer URL survives');
});

test('Open does nothing for an unknown transfer', { concurrency: false }, () => {
  const harness = createHarness();
  assert.equal(harness.sandbox.openFile('missing'), false);
  assert.equal(harness.openedTabs.length, 0);
  assert.match(harness.toasts.at(-1), /no longer held by the browser/);
});

// -------------------------------------------------------- download again action

test('Download Again re-saves the cached bytes without a new transfer record', { concurrency: false }, () => {
  const harness = createHarness();
  const { sandbox, linkClicks, sent } = harness;
  sandbox.register('dl-again', 'Again.pdf', 'download', 5);
  completeDownload(harness, 'dl-again', 'Again.pdf', 'again');
  sandbox.complete({ transferId: 'dl-again', direction: 'download' });
  const recordsAfterCompletion = sandbox.state.transfers.size;
  const clicksAfterCompletion = linkClicks.length;

  assert.equal(sandbox.downloadAgain('dl-again'), true);
  assert.equal(linkClicks.length, clicksAfterCompletion + 1);
  assert.equal(linkClicks.at(-1).download, 'Again.pdf');
  assert.equal(sandbox.state.transfers.size, recordsAfterCompletion);
  assert.deepEqual(sandbox.downloadFileCalls, []);
  assert.deepEqual(sent.filter((message) => message.type === 'download_start'), []);
});

test('Download Again falls back to the existing server download flow when bytes are gone', { concurrency: false }, () => {
  const harness = createHarness();
  const { sandbox } = harness;
  sandbox.register('dl-gone', 'Gone.pdf', 'download', 5);
  completeDownload(harness, 'dl-gone', 'Gone.pdf', 'gone');
  sandbox.complete({ transferId: 'dl-gone', direction: 'download' });
  sandbox.release('dl-gone');

  assert.equal(sandbox.downloadAgain('dl-gone'), true);
  assert.deepEqual(sandbox.downloadFileCalls, ['Gone.pdf']);
  assert.equal(sandbox.state.transfers.get('dl-gone').status, 'Completed', 'the completed record is left intact');
});

test('Download Again is refused for uploads and for unfinished transfers', { concurrency: false }, () => {
  const harness = createHarness();
  const { sandbox } = harness;
  sandbox.register('up-1', 'upload.pdf', 'upload', 5);
  sandbox.complete({ transferId: 'up-1', direction: 'upload' });
  assert.equal(sandbox.downloadAgain('up-1'), false);

  sandbox.register('dl-live', 'live.pdf', 'download', 5);
  sandbox.state.transfers.get('dl-live').status = 'Downloading';
  assert.equal(sandbox.downloadAgain('dl-live'), false);

  assert.equal(sandbox.downloadAgain('nope'), false);
  assert.deepEqual(sandbox.downloadFileCalls, []);
});

// -------------------------------------------------------------- memory hygiene

test('clearing completed releases the cached data and its object URL', { concurrency: false }, () => {
  const harness = createHarness();
  const { sandbox, list, revokedUrls } = harness;
  sandbox.register('dl-1', 'One.pdf', 'download', 3);
  sandbox.register('dl-2', 'Two.pdf', 'download', 3);
  completeDownload(harness, 'dl-1', 'One.pdf', 'one');
  completeDownload(harness, 'dl-2', 'Two.pdf', 'two');
  sandbox.complete({ transferId: 'dl-1', direction: 'download' });
  sandbox.complete({ transferId: 'dl-2', direction: 'download' });
  sandbox.openFile('dl-1');
  assert.equal(sandbox.state.downloadedBlobs.size, 2);
  assert.equal(harness.createdUrls.length, 3, 'two saves plus one viewer URL');

  sandbox.clear('Completed');
  assert.equal(sandbox.state.transfers.size, 0);
  assert.equal(sandbox.state.downloadedBlobs.size, 0);
  assert.equal(list.innerHTML, '<div class="transfer-empty">No transfers in this view.</div>');
  assert.ok(revokedUrls.includes(harness.createdUrls[2].url), 'the viewer object URL is revoked');
  assert.equal(sandbox.getBlob('dl-1'), null);
});

test('cancelling or failing a transfer drops any partial local copy', { concurrency: false }, () => {
  const harness = createHarness();
  const { sandbox, revokedUrls } = harness;
  sandbox.register('dl-cancel', 'Cancel.pdf', 'download', 3);
  sandbox.retain('dl-cancel', 'Cancel.pdf', new Blob(['x']));
  sandbox.openFile('dl-cancel');
  sandbox.cancel('dl-cancel');
  assert.equal(sandbox.hasBlob('dl-cancel'), false);
  assert.equal(revokedUrls.includes(harness.createdUrls.at(-1).url), true);

  sandbox.register('dl-fail', 'Fail.pdf', 'download', 3);
  sandbox.retain('dl-fail', 'Fail.pdf', new Blob(['x']));
  sandbox.fail('download', { transferId: 'dl-fail', message: 'Chunk download error.' });
  assert.equal(sandbox.state.transfers.get('dl-fail').status, 'Failed');
  assert.equal(sandbox.hasBlob('dl-fail'), false);
});

test('the completed-blob cache is bounded by entry count and evicts oldest first', { concurrency: false }, () => {
  const harness = createHarness();
  const { sandbox, revokedUrls } = harness;
  const ids = Array.from({ length: 9 }, (_, index) => `dl-${index}`);
  for (const id of ids) sandbox.retain(id, `${id}.pdf`, new Blob([id]));

  assert.equal(normalCount(sandbox), MAX_ENTRIES);
  assert.equal(sandbox.hasBlob('dl-0'), false, 'oldest entry is evicted');
  assert.equal(sandbox.hasBlob('dl-1'), false);
  assert.equal(sandbox.hasBlob('dl-8'), true, 'newest entry survives');
  assert.equal(revokedUrls.length, 0, 'evicted entries had no live object URL');

  // Evicting an entry that owns a viewer URL must revoke that URL.
  sandbox.openFile('dl-5');
  const viewerUrl = harness.createdUrls.at(-1).url;
  sandbox.retain('dl-9', 'dl-9.pdf', new Blob(['dl-9']));
  sandbox.retain('dl-10', 'dl-10.pdf', new Blob(['dl-10']));
  sandbox.retain('dl-11', 'dl-11.pdf', new Blob(['dl-11']));
  assert.equal(sandbox.hasBlob('dl-5'), false);
  assert.ok(revokedUrls.includes(viewerUrl));
});

test('the cache also respects its total byte budget, not just the entry count', { concurrency: false }, () => {
  const harness = createHarness();
  const { sandbox } = harness;
  // Five files of a third of the budget each: far fewer than the six-entry cap,
  // so the byte budget is what has to do the work.
  const slice = Math.floor(MAX_BYTES / 3);
  const ids = Array.from({ length: 5 }, (_, index) => `chunk-${index}`);
  for (const id of ids) sandbox.retain(id, `${id}.bin`, blobOfBytes(slice));

  assert.equal(cachedBytes(sandbox) <= MAX_BYTES, true, `cached ${cachedBytes(sandbox)} exceeds ${MAX_BYTES}`);
  assert.equal(normalCount(sandbox), 3, 'the byte budget is the binding constraint here');
  assert.equal(sandbox.hasBlob('chunk-0'), false, 'the oldest entries are dropped to stay under budget');
  assert.equal(sandbox.hasBlob('chunk-1'), false);
  assert.equal(sandbox.hasBlob('chunk-2'), true);
  assert.equal(sandbox.hasBlob('chunk-4'), true, 'the newest file always stays');

  // One file that exactly fills the budget is cached, and the rest are dropped.
  sandbox.retain('exact', 'exact.bin', blobOfBytes(MAX_BYTES));
  assert.equal(sandbox.hasBlob('exact'), true, 'a file exactly at the budget is not oversized');
  assert.equal(cachedBytes(sandbox), MAX_BYTES);
  assert.equal(normalCount(sandbox), 1);
  assert.equal(sandbox.hasBlob('chunk-2'), false);

  // Just past the budget it is not cached at all — it gets the grace slot, and
  // the normal cache is untouched rather than being emptied for it.
  sandbox.retain('over', 'over.bin', blobOfBytes(MAX_BYTES + 1));
  const over = sandbox.state.downloadedBlobs.get('over');
  assert.equal(over.oversized, true);
  assert.equal(cachedBytes(sandbox), MAX_BYTES, 'the normal cache keeps its own budget');
  assert.equal(sandbox.hasBlob('exact'), true);
});

test('a single file past the byte budget is never retained for the session', { concurrency: false }, () => {
  const harness = createHarness();
  const { sandbox, createdUrls, revokedUrls, linkClicks, openedTabs } = harness;
  const huge = blobOfBytes(MAX_BYTES + 1);

  sandbox.register('dl-huge', 'Huge.iso', 'download', 1);
  completeDownload(harness, 'dl-huge', 'Huge.iso', 'x');
  sandbox.complete({ transferId: 'dl-huge', direction: 'download' });
  sandbox.retain('dl-huge', 'Huge.iso', huge);
  const entry = sandbox.state.downloadedBlobs.get('dl-huge');
  assert.equal(entry.oversized, true);
  assert.equal(entry.expiresAt - sandbox.Date.now(), OVERSIZE_TTL_MS);

  // It works immediately: the user can open or re-save it right away.
  assert.equal(sandbox.hasBlob('dl-huge'), true);
  assert.equal(sandbox.openFile('dl-huge'), true);
  assert.equal(sandbox.downloadAgain('dl-huge'), true);
  assert.equal(openedTabs.length, 1);
  assert.ok(linkClicks.some((click) => click.download === 'Huge.iso'));

  // But it is not kept: the grace timer releases the bytes.
  const viewerUrl = harness.createdUrls.at(-1).url;
  harness.runTimers();
  assert.equal(sandbox.hasBlob('dl-huge'), false, 'an oversized blob must not survive its grace window');
  assert.equal(sandbox.state.downloadedBlobs.size, 0);
  assert.ok(revokedUrls.includes(viewerUrl), 'the oversized entry revokes its object URL on release');
});

test('an expired oversized blob is treated as gone even if the timer never ran', { concurrency: false }, () => {
  const harness = createHarness();
  const { sandbox } = harness;
  const huge = blobOfBytes(MAX_BYTES + 1);
  sandbox.retain('dl-huge', 'Huge.iso', huge);
  assert.equal(sandbox.hasBlob('dl-huge'), true);

  // A throttled background tab never runs the timer, so the readers re-check.
  sandbox.advanceClock(OVERSIZE_TTL_MS + 1);
  assert.equal(sandbox.hasBlob('dl-huge'), false);
  assert.equal(sandbox.getBlob('dl-huge'), null);
  assert.equal(sandbox.openFile('dl-huge'), false);
  assert.equal(sandbox.state.downloadedBlobs.size, 0);

  // Download Again still works, via the existing server download flow.
  sandbox.state.transfers.set('dl-huge', {
    id: 'dl-huge', filename: 'Huge.iso', direction: 'download', size: 1, totalBytes: 1,
    bytesTransferred: 1, progress: 100, speedBps: null, etaSeconds: null,
    status: 'Completed', queuedAt: 0, startedAt: 0, completedAt: 1, error: null
  });
  assert.equal(sandbox.downloadAgain('dl-huge'), true);
  assert.deepEqual(sandbox.downloadFileCalls, ['Huge.iso']);
});

test('a newer oversized download replaces the previous one instead of stacking', { concurrency: false }, () => {
  const harness = createHarness();
  const { sandbox, revokedUrls } = harness;
  const huge = () => blobOfBytes(MAX_BYTES * 2);
  sandbox.retain('dl-first', 'First.iso', huge());
  sandbox.openFile('dl-first');
  const firstUrl = harness.createdUrls.at(-1).url;
  sandbox.advanceClock(1);
  sandbox.retain('dl-second', 'Second.iso', huge());

  assert.equal(sandbox.hasBlob('dl-first'), false);
  assert.equal(sandbox.hasBlob('dl-second'), true);
  assert.equal(sandbox.state.downloadedBlobs.size, 1, 'the grace slot holds one large file');
  assert.ok(revokedUrls.includes(firstUrl));
});

test('an oversized entry never displaces the normal cache budget', { concurrency: false }, () => {
  const harness = createHarness();
  const { sandbox } = harness;
  const slice = Math.floor(MAX_BYTES / 10);
  for (let index = 0; index < 6; index += 1) sandbox.retain(`small-${index}`, `small-${index}.bin`, blobOfBytes(slice));
  assert.equal(cachedBytes(sandbox), slice * 6);

  sandbox.retain('dl-huge', 'Huge.iso', blobOfBytes(MAX_BYTES + 1));

  assert.equal(normalCount(sandbox), 6, 'the normal entries are untouched by the grace slot');
  assert.equal(cachedBytes(sandbox), slice * 6);
  assert.equal(cachedBytes(sandbox) <= MAX_BYTES, true);
  assert.equal(sandbox.hasBlob('dl-huge'), true);

  harness.runTimers();
  assert.equal(normalCount(sandbox), 6, 'releasing the oversized entry keeps the normal cache');
  assert.equal(sandbox.hasBlob('dl-huge'), false);
});

test('releasing everything revokes every outstanding object URL', { concurrency: false }, () => {
  const harness = createHarness();
  const { sandbox, revokedUrls } = harness;
  sandbox.retain('a', 'a.pdf', new Blob(['a']));
  sandbox.retain('b', 'b.pdf', new Blob(['b']));
  sandbox.openFile('a');
  sandbox.openFile('b');
  const viewerUrls = harness.createdUrls.filter((entry) => entry.url.startsWith('blob:dexile-test-')).slice(-2).map((entry) => entry.url);
  sandbox.releaseAll();
  assert.equal(sandbox.state.downloadedBlobs.size, 0);
  for (const url of viewerUrls) assert.ok(revokedUrls.includes(url), `${url} should be revoked`);
  assert.equal(sandbox.release('a'), false);
});

test('history pruning releases the blob of the record it drops', { concurrency: false }, () => {
  const harness = createHarness();
  const { sandbox } = harness;
  sandbox.state.transfers.set('old', {
    id: 'old', filename: 'old.pdf', direction: 'download', size: 1, totalBytes: 1,
    bytesTransferred: 1, progress: 100, speedBps: null, etaSeconds: null,
    status: 'Completed', queuedAt: Date.now(), startedAt: Date.now(), completedAt: Date.now(), error: null
  });
  sandbox.retain('old', 'old.pdf', new Blob(['x']));
  for (let index = 0; index < 199; index += 1) {
    sandbox.state.transfers.set(`filler-${index}`, {
      id: `filler-${index}`, filename: 'f.pdf', direction: 'download', size: 1, totalBytes: 1,
      bytesTransferred: 0, progress: 0, speedBps: null, etaSeconds: null,
      status: 'Downloading', queuedAt: Date.now(), startedAt: Date.now(), completedAt: null, error: null
    });
  }
  assert.equal(sandbox.prune(), true);
  assert.equal(sandbox.state.transfers.has('old'), false);
  assert.equal(sandbox.hasBlob('old'), false);
});

// ---------------------------------------------------------------- independence

test('multiple completed downloads stay independent', { concurrency: false }, () => {
  const harness = createHarness();
  const { sandbox, openedTabs, linkClicks } = harness;
  const files = [['dl-a', 'Alpha.pdf', 'alpha'], ['dl-b', 'Beta.pdf', 'beta'], ['dl-c', 'Gamma.pdf', 'gamma']];
  for (const [id, filename, contents] of files) {
    sandbox.register(id, filename, 'download', contents.length);
    completeDownload(harness, id, filename, contents);
    sandbox.complete({ transferId: id, direction: 'download' });
  }
  assert.equal(sandbox.state.downloadedBlobs.size, 3);

  for (const [, filename, contents] of files) {
    const entry = [...sandbox.state.downloadedBlobs.values()].find((cached) => cached.filename === filename);
    assert.equal(entry.blob.size, contents.length);
  }

  sandbox.release('dl-b');
  assert.equal(sandbox.hasBlob('dl-a'), true);
  assert.equal(sandbox.hasBlob('dl-c'), true);
  assert.equal(sandbox.hasBlob('dl-b'), false);

  sandbox.openFile('dl-a');
  sandbox.openFile('dl-c');
  assert.equal(openedTabs.length, 2);
  assert.notEqual(openedTabs[0].url, openedTabs[1].url);
  const aUrl = [...sandbox.state.downloadedBlobs.values()].find((cached) => cached.filename === 'Alpha.pdf').url;
  assert.equal(openedTabs[0].url, aUrl);

  sandbox.clear('Completed');
  assert.equal(sandbox.state.downloadedBlobs.size, 0);
  assert.equal(linkClicks.length, 3, 'each completed download still saved once');
});

// -------------------------------------------------------- filenames and safety

test('long filenames ellipsize while keeping the extension readable', { concurrency: false }, () => {
  const harness = createHarness();
  const { sandbox, list } = harness;
  const filename = 'Receipt_20260921103530_monthly_statement_final_v2.pdf';
  sandbox.register('dl-long', filename, 'download', 5);
  completeDownload(harness, 'dl-long', filename, 'long');
  sandbox.complete({ transferId: 'dl-long', direction: 'download' });

  const displayed = sandbox.shorten(filename);
  assert.ok(displayed.length < filename.length, 'displayed name is shorter');
  assert.ok(displayed.endsWith('.pdf'), 'extension stays readable');
  assert.ok(displayed.includes('…'));
  assert.ok(filename.startsWith(displayed.replace('…', '').replace('.pdf', '')));
  assert.equal(sandbox.shorten('short.pdf'), 'short.pdf');
  assert.equal(sandbox.shorten('noextension'), 'noextension');
  assert.equal(sandbox.shorten(''), '');

  assert.ok(list.innerHTML.includes(displayed), 'row shows the shortened name');
  assert.ok(list.innerHTML.includes(`title="${sandbox.esc(filename)}"`), 'full name stays available in the title');
  assert.ok(list.innerHTML.includes('Open'), 'buttons still render for a long name');
});

test('a malicious filename cannot inject HTML or script', { concurrency: false }, () => {
  const harness = createHarness();
  const { sandbox, list, linkClicks, openedTabs } = harness;
  const filename = '<img src=x onerror="window.__pwned=1">"><script>alert(1)</script>.pdf';
  sandbox.register('dl-evil', filename, 'download', 5);
  completeDownload(harness, 'dl-evil', filename, 'evil');
  sandbox.complete({ transferId: 'dl-evil', direction: 'download' });

  const rendered = list.innerHTML;
  assert.doesNotMatch(rendered, /<img/, 'no raw img tag is emitted');
  assert.doesNotMatch(rendered, /<script/, 'no raw script tag is emitted');
  assert.equal(rendered.includes(filename), false, 'the raw filename never reaches the markup');
  assert.match(rendered, /title="&lt;img src=x onerror=&quot;window\.__pwned=1&quot;&gt;&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;\.pdf"/);
  assert.doesNotMatch(rendered, /title="[^"]*"[^>]*on/, 'the title attribute stays closed');
  // The only live handler on the page is Dexile's own fixed onclick wiring, and
  // it only ever carries the server-issued transfer id.
  const handlers = [...rendered.matchAll(/on[a-z]+="([^"]*)"/g)].map((match) => match[1]);
  assert.ok(handlers.length >= 2);
  for (const handler of handlers) assert.match(handler, /^Dexile\.[a-zA-Z]+\('[A-Za-z0-9-]+'\)$/);

  // The download attribute is the real filename, not the injected markup.
  assert.equal(linkClicks.at(-1).download, filename);
  assert.equal(openedTabs.length, 0);
});

// ------------------------------------------------------------------ mime types

test('mime detection covers common formats and falls back safely', { concurrency: false }, () => {
  const harness = createHarness();
  const { sandbox } = harness;
  const expected = {
    'a.pdf': 'application/pdf',
    'a.PNG': 'image/png',
    'a.jpeg': 'image/jpeg',
    'a.gif': 'image/gif',
    'a.txt': 'text/plain',
    'a.csv': 'text/csv',
    'a.json': 'application/json',
    'a.mp4': 'video/mp4',
    'a.mp3': 'audio/mpeg',
    'a.zip': 'application/zip',
    'a.7z': 'application/x-7z-compressed',
    'a.doc': 'application/msword',
    'a.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'a.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'a.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'noextension': 'application/octet-stream',
    'weird.unknownext': 'application/octet-stream',
    'trailing.': 'application/octet-stream',
    'constructor.pdf': 'application/pdf'
  };
  for (const [filename, mime] of Object.entries(expected)) {
    assert.equal(sandbox.detectMime(filename), mime, filename);
  }
  assert.equal(sandbox.detectMime('evil.pdf'), 'application/pdf');
  assert.equal(sandbox.detectMime(null), 'application/octet-stream');
});

test('a completed download keeps the detected mime type on the cached blob', { concurrency: false }, () => {
  const harness = createHarness();
  const { sandbox } = harness;
  sandbox.register('dl-pdf', 'Receipt.pdf', 'download', 4);
  completeDownload(harness, 'dl-pdf', 'Receipt.pdf', 'pdf!');
  const entry = sandbox.state.downloadedBlobs.get('dl-pdf');
  assert.equal(entry.mimeType, 'application/pdf');
  assert.equal(entry.filename, 'Receipt.pdf');
  assert.equal(entry.size, 4);
  assert.equal(entry.blob.type, 'application/pdf');
});

// ------------------------------------------------------- existing behaviour kept

test('finalizing a download still saves the file through the browser', { concurrency: false }, () => {
  const harness = createHarness();
  const { sandbox, linkClicks, sent } = harness;
  sandbox.register('dl-flow', 'Report.pdf', 'download', 11);
  sandbox.state.downloadBuffers.set('dl-flow', {
    chunks: [base64('hello '), base64('world')], fileSize: 11, filename: 'Report.pdf',
    chunkSize: 5, nextIndex: 2, lastChunkReceived: true, transferCompleted: true
  });
  sandbox.finalize('dl-flow');

  assert.equal(sandbox.state.downloadBuffers.has('dl-flow'), false, 'chunk buffer is still released');
  assert.equal(linkClicks.length, 1, 'the browser save still happens on completion');
  assert.equal(linkClicks[0].download, 'Report.pdf');
  assert.ok(linkClicks[0].href.startsWith('blob:'));
  harness.runTimers();
  assert.ok(harness.revokedUrls.includes(linkClicks[0].href), 'the save URL is revoked after use');
  assert.deepEqual(sent, [], 'finalize sends nothing new');
  assert.equal(sandbox.hasBlob('dl-flow'), true, 'a local copy is kept for Open');
});

test('chunked download flow still advances and completes', { concurrency: false }, () => {
  const harness = createHarness();
  const { sandbox, sent } = harness;
  sandbox.state.downloadBuffers.set('dl-chunks', {
    chunks: [], fileSize: 6, filename: 'chunks.txt', chunkSize: 3, nextIndex: 0,
    lastChunkReceived: false, transferCompleted: false
  });
  sandbox.chunk({ transferId: 'dl-chunks', chunkIndex: 0, data: base64('abc'), isLastChunk: false, progress: 50, bytesTransferred: 3, totalBytes: 6 });
  assert.deepEqual(sent, [{ type: 'download_chunk_request', transferId: 'dl-chunks', chunkIndex: 1 }]);
  sandbox.chunk({ transferId: 'dl-chunks', chunkIndex: 1, data: base64('def'), isLastChunk: true, progress: 100, bytesTransferred: 6, totalBytes: 6 });
  assert.equal(sandbox.state.downloadBuffers.get('dl-chunks').lastChunkReceived, true);
  assert.equal(sandbox.hasBlob('dl-chunks'), false, 'no copy before the transfer is marked complete');
  sandbox.complete({ transferId: 'dl-chunks', direction: 'download' });
  assert.equal(sandbox.hasBlob('dl-chunks'), true);
});

test('upload completion still clears the queued file and stays retryable while active', { concurrency: false }, () => {
  const harness = createHarness();
  const { sandbox, list } = harness;
  const file = { name: 'phone.txt', size: 8 };
  sandbox.state.transfers.set('up-live', {
    id: 'up-live', filename: 'phone.txt', direction: 'upload', size: 8, totalBytes: 8,
    bytesTransferred: 4, progress: 50, speedBps: 10, etaSeconds: null, status: 'Transferring',
    queuedAt: Date.now(), startedAt: Date.now(), completedAt: null, error: null, file
  });
  sandbox.render();
  assert.match(list.innerHTML, /Cancel/);
  assert.doesNotMatch(list.innerHTML, />Open</);

  sandbox.state.transfers.get('up-live').file = null;
  sandbox.complete({ transferId: 'up-live', direction: 'upload' });
  assert.equal(sandbox.state.transfers.get('up-live').status, 'Completed');
  assert.doesNotMatch(list.innerHTML, />Open</);
  assert.doesNotMatch(list.innerHTML, /Download Again/);
});

test('cancel and retry still route through the existing server messages', { concurrency: false }, () => {
  const harness = createHarness();
  const { sandbox, sent } = harness;
  sandbox.register('dl-cancel', 'cancel.pdf', 'download', 4);
  sandbox.state.downloadBuffers.set('dl-cancel', { chunks: [], fileSize: 4, filename: 'cancel.pdf' });
  sandbox.state.transfers.get('dl-cancel').status = 'Downloading';
  sandbox.cancel('dl-cancel');
  assert.deepEqual(sent, [{ type: 'download_cancel', transferId: 'dl-cancel' }]);
  assert.equal(sandbox.state.downloadBuffers.has('dl-cancel'), false);

  sandbox.register('dl-retry', 'retry.pdf', 'download', 4);
  sandbox.fail('download', { transferId: 'dl-retry', message: 'Chunk download error.' });
  assert.equal(sandbox.state.transfers.get('dl-retry').status, 'Failed');
  sandbox.retry('dl-retry');
  assert.deepEqual(sandbox.downloadFileCalls, ['retry.pdf']);

  const upload = { name: 'retry-upload.txt', size: 4 };
  sandbox.register('up-retry', 'retry-upload.txt', 'upload', 4);
  sandbox.state.transfers.get('up-retry').file = upload;
  sandbox.fail('upload', { transferId: 'up-retry', message: 'Write failed.' });
  sandbox.retry('up-retry');
  assert.deepEqual(sandbox.uploadFileCalls, [upload]);
});

test('filtering and clearing keep working with the new actions present', { concurrency: false }, () => {
  const harness = createHarness();
  const { sandbox, list } = harness;
  sandbox.register('dl-done', 'done.pdf', 'download', 3);
  completeDownload(harness, 'dl-done', 'done.pdf', 'done');
  sandbox.complete({ transferId: 'dl-done', direction: 'download' });
  sandbox.register('dl-bad', 'bad.pdf', 'download', 3);
  sandbox.fail('download', { transferId: 'dl-bad', message: 'boom' });

  sandbox.filter('completed');
  assert.match(list.innerHTML, /done\.pdf/);
  assert.doesNotMatch(list.innerHTML, /bad\.pdf/);
  sandbox.filter('all');
  assert.match(list.innerHTML, /done\.pdf/);
  assert.match(list.innerHTML, /bad\.pdf/);

  sandbox.clear('Failed');
  assert.match(list.innerHTML, /done\.pdf/);
  assert.doesNotMatch(list.innerHTML, /bad\.pdf/);
  assert.equal(sandbox.hasBlob('dl-done'), true, 'clearing failures leaves completed data alone');

  sandbox.clear('Completed');
  assert.match(list.innerHTML, /No transfers in this view\./);
  assert.equal(sandbox.hasBlob('dl-done'), false);
});
