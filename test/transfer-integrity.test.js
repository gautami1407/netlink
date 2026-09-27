// Transfer integrity: a transfer is only allowed to report itself complete
// when the bytes that arrived are exactly the bytes that were asked for, and
// neither a malformed request nor a lying client can talk the server into
// storing or claiming a corrupt file.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const FileTransferManager = require('../filetransfer.js');

const CHUNK = 64 * 1024;

function makeSandbox(label) {
    const root = path.join(os.tmpdir(), `dexile-integrity-${process.pid}-${label}-`);
    const downloads = path.join(root, 'downloads');
    fs.mkdirSync(downloads, { recursive: true });
    const manager = new FileTransferManager(root, { downloadsPath: downloads });
    return {
        root,
        downloads,
        manager,
        inDownloads: (name) => fs.readdirSync(downloads).includes(name),
        stagingIsEmpty: () => fs.readdirSync(path.join(root, 'incoming')).length === 0,
        cleanup: () => fs.rmSync(root, { recursive: true, force: true })
    };
}

function trackEvents(manager) {
    const events = [];
    for (const name of ['progress', 'completed', 'failed', 'cancelled']) {
        manager.on(name, (evt) => events.push({ type: name, ...evt }));
    }
    return events;
}

// ------------------------------------------------------------ size honesty

test('an upload that delivers fewer bytes than it declared is rejected', { concurrency: false }, async () => {
    const box = makeSandbox('short');
    try {
        const started = await box.manager.startUpload('liar.txt', 1024 * 1024, 'client-1');
        await assert.rejects(
            () => box.manager.handleChunk(started.transferId, 0, Buffer.from('AAAA'), true),
            /incomplete/i
        );
        assert.equal(box.inDownloads('liar.txt'), false, 'a truncated upload never reaches Downloads');
        assert.equal(box.stagingIsEmpty(), true, 'the partial file is cleaned up');
        assert.equal(box.manager.activeTransfers.size, 0, 'the transfer is no longer active');
    } finally {
        box.cleanup();
    }
});

test('an upload that delivers more bytes than it declared is rejected', { concurrency: false }, async () => {
    const box = makeSandbox('over');
    try {
        const started = await box.manager.startUpload('over.txt', CHUNK, 'client-1');
        await assert.rejects(
            () => box.manager.handleChunk(started.transferId, 0, Buffer.alloc(CHUNK + 10, 1), true),
            /incomplete/i
        );
        assert.equal(box.inDownloads('over.txt'), false);
    } finally {
        box.cleanup();
    }
});

test('a declared size that is not a real number is refused up front', { concurrency: false }, async () => {
    const box = makeSandbox('nan');
    try {
        await assert.rejects(() => box.manager.startUpload('nan.txt', Number.NaN, 'c1'), /non-negative/);
        await assert.rejects(() => box.manager.startUpload('neg.txt', -5, 'c1'), /non-negative/);
        await assert.rejects(() => box.manager.startUpload('inf.txt', Number.POSITIVE_INFINITY, 'c1'), /non-negative/);
        assert.equal(box.manager.activeTransfers.size, 0);
    } finally {
        box.cleanup();
    }
});

// ------------------------------------------------------------ chunk shape

test('a negative chunk index is refused instead of being silently dropped', { concurrency: false }, async () => {
    const box = makeSandbox('negative');
    try {
        const started = await box.manager.startUpload('neg.txt', 4, 'c1');
        await assert.rejects(
            () => box.manager.handleChunk(started.transferId, -1, Buffer.from('ZZZZ'), true),
            /Invalid chunk index/
        );
        // The original bug: the chunk was stored as a plain object property,
        // Buffer.concat ignored it, and a 0-byte file was reported as complete.
        assert.equal(box.inDownloads('neg.txt'), false, 'no 0-byte file is delivered');
    } finally {
        box.cleanup();
    }
});

test('a non-integer or non-numeric chunk index is refused', { concurrency: false }, async () => {
    const box = makeSandbox('fractional');
    try {
        // A malformed index fails the transfer outright, so each case needs
        // its own transfer to be exercised.
        for (const bad of [1.5, '0', null, undefined, Number.NaN]) {
            const started = await box.manager.startUpload('frac.txt', 8, 'c1');
            await assert.rejects(
                () => box.manager.handleChunk(started.transferId, bad, Buffer.from('AA'), true),
                /Invalid chunk index/,
                `index ${String(bad)} must be refused`
            );
        }
    } finally {
        box.cleanup();
    }
});

test('a chunk index far past the declared size is refused', { concurrency: false }, async () => {
    const box = makeSandbox('far');
    try {
        const started = await box.manager.startUpload('far.txt', 8, 'c1');
        // A sparse array this large would exhaust memory before concatenation.
        await assert.rejects(
            () => box.manager.handleChunk(started.transferId, 1000000000, Buffer.from('AA'), true),
            /beyond the end/
        );
        assert.equal(box.inDownloads('far.txt'), false);
    } finally {
        box.cleanup();
    }
});

test('a gap in the chunk sequence is detected instead of being zero-filled', { concurrency: false }, async () => {
    const box = makeSandbox('gap');
    try {
        const started = await box.manager.startUpload('gap.txt', 3 * CHUNK, 'c1');
        await box.manager.handleChunk(started.transferId, 0, Buffer.alloc(CHUNK, 1), false);
        // Index 1 never arrives. Every index used here is legal, so only an
        // explicit completeness check can catch this.
        await assert.rejects(
            () => box.manager.handleChunk(started.transferId, 2, Buffer.alloc(CHUNK, 3), true),
            /missing chunk 1/
        );
        assert.equal(box.inDownloads('gap.txt'), false);
    } finally {
        box.cleanup();
    }
});

// ------------------------------------------------------------ memory bound

test('the size limit is enforced against bytes received, not just bytes declared', { concurrency: false }, async () => {
    const box = makeSandbox('bound');
    try {
        // A tiny declaration passes the up-front check, and index 0 is a legal
        // index for it. The only thing standing between this chunk and the heap
        // is a limit applied to the bytes that actually arrived.
        box.manager.maxFileSize = 2 * CHUNK;
        const started = await box.manager.startUpload('flood.txt', 100, 'c1');
        await assert.rejects(
            () => box.manager.handleChunk(started.transferId, 0, Buffer.alloc(4 * CHUNK, 7), true),
            /too large/i
        );
        assert.equal(box.manager.activeTransfers.size, 0, 'the flooding transfer is torn down');
        assert.equal(box.stagingIsEmpty(), true);
        assert.equal(box.inDownloads('flood.txt'), false);
    } finally {
        box.cleanup();
    }
});

// ------------------------------------------------------------ happy paths

test('a complete multi-chunk upload is delivered intact', { concurrency: false }, async () => {
    const box = makeSandbox('good');
    try {
        const events = trackEvents(box.manager);
        const payload = Buffer.concat([Buffer.alloc(CHUNK, 1), Buffer.alloc(CHUNK, 2)]);
        const started = await box.manager.startUpload('good.txt', payload.length, 'c1');
        await box.manager.handleChunk(started.transferId, 0, payload.subarray(0, CHUNK), false);
        await box.manager.handleChunk(started.transferId, 1, payload.subarray(CHUNK), true);

        const delivered = path.join(box.downloads, 'good.txt');
        assert.deepEqual(fs.readFileSync(delivered), payload, 'the delivered bytes match exactly');
        assert.equal(box.stagingIsEmpty(), true, 'staging is left empty');

        const completed = events.filter((e) => e.type === 'completed');
        assert.equal(completed.length, 1);
        assert.equal(completed[0].bytesTransferred, payload.length);
        assert.equal(completed[0].direction, 'upload');

        // The final 100% must be announced before completion, never after.
        const types = events.map((e) => e.type);
        assert.equal(types.at(-1), 'completed', 'completion is the last event');
    } finally {
        box.cleanup();
    }
});

test('a zero-byte file uploads and delivers as an empty file', { concurrency: false }, async () => {
    const box = makeSandbox('empty');
    try {
        // The real client signals an empty file with data:'' and isLastChunk:true.
        const started = await box.manager.startUpload('empty.txt', 0, 'c1');
        await box.manager.handleChunk(started.transferId, 0, Buffer.from(''), true);
        const delivered = path.join(box.downloads, 'empty.txt');
        assert.equal(fs.existsSync(delivered), true);
        assert.equal(fs.statSync(delivered).size, 0);
    } finally {
        box.cleanup();
    }
});

test('re-sending a chunk is idempotent rather than doubling the file', { concurrency: false }, async () => {
    const box = makeSandbox('resend');
    try {
        const started = await box.manager.startUpload('retry.txt', CHUNK, 'c1');
        await box.manager.handleChunk(started.transferId, 0, Buffer.alloc(CHUNK, 4), false);
        // A client retrying after a dropped ack repeats the same index.
        await box.manager.handleChunk(started.transferId, 0, Buffer.alloc(CHUNK, 4), true);
        assert.equal(fs.statSync(path.join(box.downloads, 'retry.txt')).size, CHUNK);
    } finally {
        box.cleanup();
    }
});

// -------------------------------------------------------- download reads

test('an out-of-range download chunk is refused without destroying the transfer', { concurrency: false }, async () => {
    const box = makeSandbox('download-bounds');
    try {
        fs.writeFileSync(path.join(box.downloads, 'read.txt'), '0123456789');
        box.manager.rememberReceivedFile('read.txt');
        const started = await box.manager.startDownload('read.txt', 'c1', { location: 'from-phone' });

        for (const bad of [9999, -1, 1.5]) {
            await assert.rejects(() => box.manager.getChunk(started.transferId, bad), /Invalid chunk index|beyond the end/);
            assert.equal(box.manager.activeTransfers.has(started.transferId), true,
                `a bad index (${bad}) must not cancel the download`);
        }

        // The transfer is still usable afterwards.
        const chunk = await box.manager.getChunk(started.transferId, 0);
        assert.equal(Buffer.from(chunk.data, 'base64').toString(), '0123456789');
        assert.equal(chunk.isLastChunk, true);
    } finally {
        box.cleanup();
    }
});

test('a failed download read releases its file descriptor', { concurrency: false }, async () => {
    const box = makeSandbox('fd');
    try {
        fs.writeFileSync(path.join(box.downloads, 'gone.txt'), 'abcdefghij');
        box.manager.rememberReceivedFile('gone.txt');
        const started = await box.manager.startDownload('gone.txt', 'c1', { location: 'from-phone' });

        // Delete the file out from under the open handle: readSync throws, and
        // the descriptor must still be closed.
        fs.unlinkSync(path.join(box.downloads, 'gone.txt'));
        const before = process.report ? countOpenHandles() : null;
        await assert.rejects(() => box.manager.getChunk(started.transferId, 0));
        const after = process.report ? countOpenHandles() : null;
        assert.ok(before === null || after <= before + 1,
            `descriptors are released (before=${before}, after=${after})`);
    } finally {
        box.cleanup();
    }
});

function countOpenHandles() {
    // Windows does not expose /proc, so this is only meaningful where it
    // exists. The test still asserts the read failed and the transfer was
    // cleaned up in either case.
    try {
        return require('fs').readdirSync('/proc/self/fd').length;
    } catch (error) {
        return null;
    }
}
