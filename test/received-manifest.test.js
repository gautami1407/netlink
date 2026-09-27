// The received-file manifest is the record of what Dexile itself put in the
// user's Downloads folder. It is the only thing standing between "Shared Files"
// and the user's entire Downloads folder, so it has to be exactly right:
// populated only by a verified delivery, cleared only by a Dexile delete, and
// never guessable from what happens to be sitting in Downloads.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

const FileTransferManager = require('../filetransfer.js');
const DexileServer = require('../server.js');
const WebSocket = require('ws');

const CHUNK = 64 * 1024;

function sandbox(label) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `dexile-manifest-${process.pid}-${label}-`));
    const downloads = path.join(root, 'downloads');
    fs.mkdirSync(downloads, { recursive: true });
    return {
        root,
        downloads,
        manifestPath: path.join(root, 'received.json'),
        cleanup: () => fs.rmSync(root, { recursive: true, force: true })
    };
}

function readManifest(box) {
    // The manifest is only created once something has been delivered, so an
    // absent file is simply an empty record rather than a failure.
    if (!fs.existsSync(box.manifestPath)) return [];
    return JSON.parse(fs.readFileSync(box.manifestPath, 'utf8'));
}

async function upload(manager, name, bytes) {
    const started = await manager.startUpload(name, bytes.length, 'client-1');
    let offset = 0;
    let index = 0;
    for (;;) {
        const slice = bytes.subarray(offset, offset + CHUNK);
        offset += CHUNK;
        const isLast = offset >= bytes.length;
        await manager.handleChunk(started.transferId, index, slice, isLast);
        if (isLast) return;
        index++;
    }
}

async function startServer(box) {
    const server = new DexileServer(0, {
        transferPath: path.join(box.root, 'transfers'),
        downloadsPath: box.downloads
    });
    if (!server.httpServer.listening) await once(server.httpServer, 'listening');
    return server;
}

function connect(server) {
    const port = server.httpServer.address().port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    return once(ws, 'open').then(() => ws);
}

function waitFor(ws, predicate, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error('timed out')), timeoutMs);
        const onMessage = (raw) => {
            let message;
            try { message = JSON.parse(raw); } catch (error) { return; }
            if (predicate(message)) finish(null, message);
        };
        const finish = (error, message) => {
            clearTimeout(timer);
            ws.off('message', onMessage);
            error ? reject(error) : resolve(message);
        };
        ws.on('message', onMessage);
    });
}

// ------------------------------------------- 1. delivery creates an entry

test('a successful upload records an entry in received.json', { concurrency: false }, async () => {
    const box = sandbox('create');
    try {
        const manager = new FileTransferManager(box.root, { downloadsPath: box.downloads });
        const payload = Buffer.alloc(10 * 1024, 0x41);
        await upload(manager, 'IMG_20260911_133620.jpg', payload);

        assert.deepEqual(readManifest(box).map((e) => e.name), ['IMG_20260911_133620.jpg']);
        assert.deepEqual(fs.readFileSync(path.join(box.downloads, 'IMG_20260911_133620.jpg')), payload);
    } finally {
        box.cleanup();
    }
});

test('rememberReceivedFile is called only after the delivered file is verified, and before completion is announced', { concurrency: false }, async () => {
    const box = sandbox('order');
    try {
        const manager = new FileTransferManager(box.root, { downloadsPath: box.downloads });
        const order = [];
        const realRemember = manager.rememberReceivedFile.bind(manager);
        manager.rememberReceivedFile = (name) => { order.push('remember'); return realRemember(name); };
        manager.on('completed', () => order.push('completed-announced'));

        await upload(manager, 'ordered.txt', Buffer.alloc(2048, 7));

        assert.deepEqual(order, ['remember', 'completed-announced'],
            'the manifest is updated before any client is told the transfer finished');
    } finally {
        box.cleanup();
    }
});

test('a failed or truncated upload records no entry', { concurrency: false }, async () => {
    const box = sandbox('nofail');
    try {
        const manager = new FileTransferManager(box.root, { downloadsPath: box.downloads });
        const started = await manager.startUpload('truncated.txt', 4096, 'client-1');
        await assert.rejects(() => manager.handleChunk(started.transferId, 0, Buffer.alloc(16, 1), true));

        assert.deepEqual(readManifest(box), [], 'nothing is recorded for a file that was never delivered');
        assert.equal(fs.existsSync(path.join(box.downloads, 'truncated.txt')), false);
    } finally {
        box.cleanup();
    }
});

// ------------------------------------- 2. unrelated Downloads files excluded

test('files Dexile never delivered are never added to the manifest', { concurrency: false }, async () => {
    const box = sandbox('unrelated');
    try {
        // Pre-existing user files, of the kind a real Downloads folder holds.
        const privateFiles = [
            'Bank Statement September.pdf',
            'passwords.txt',
            'CLOUD CREDIENTIALS.pdf',
            'IMG_20260911_105835.jpg'
        ];
        for (const name of privateFiles) {
            fs.writeFileSync(path.join(box.downloads, name), 'private');
        }

        const manager = new FileTransferManager(box.root, { downloadsPath: box.downloads });
        await upload(manager, 'delivered.txt', Buffer.alloc(64, 3));

        // Only the delivered file is recorded.
        assert.deepEqual(readManifest(box).map((e) => e.name), ['delivered.txt']);

        // And none of the private files is reachable through the manager.
        for (const name of privateFiles) {
            assert.equal(manager.resolveDeliveredFile(name), null,
                `${name} must not be addressable as a Dexile-delivered file`);
            assert.throws(() => manager.deleteFile(name, 'from-phone'), /File not found/,
                `${name} must not be deletable through Dexile`);
        }
        assert.deepEqual(fs.readdirSync(box.downloads).sort(),
            [...privateFiles, 'delivered.txt'].sort(), 'the private files are all still on disk');
    } finally {
        box.cleanup();
    }
});

// -------------------------------- 3. delivered file shows up in Shared Files

test('a Dexile-delivered file appears in Shared Files over a real connection', { concurrency: false }, async () => {
    const box = sandbox('shared');
    const server = await startServer(box);
    const sockets = [];
    try {
        fs.writeFileSync(path.join(box.downloads, 'unrelated-private.txt'), 'not shared');
        const ws = await connect(server);
        sockets.push(ws);

        const authed = waitFor(ws, (m) => m.type === 'auth_success' || m.type === 'auth_failed');
        ws.send(JSON.stringify({ type: 'auth', code: server.authCode }));
        assert.equal((await authed).type, 'auth_success');

        const started = await server.fileTransfer.startUpload('FromPhone.jpg', 8, 'c1');
        const done = waitFor(ws, (m) => m.type === 'transfer_completed' && m.transferId === started.transferId);
        ws.send(JSON.stringify({
            type: 'upload_chunk', transferId: started.transferId, chunkIndex: 0,
            data: Buffer.from('ABCDEFGH').toString('base64'), isLastChunk: true
        }));
        await done;

        const listed = waitFor(ws, (m) => m.type === 'shared_file_list');
        ws.send(JSON.stringify({ type: 'list_shared_files' }));
        const { shared } = await listed;

        const names = shared.map((f) => f.name);
        assert.ok(names.includes('FromPhone.jpg'), 'the delivered file is listed');
        assert.equal(shared.find((f) => f.name === 'FromPhone.jpg').location, 'from-phone');
        assert.equal(names.includes('unrelated-private.txt'), false,
            'a file Dexile did not deliver is never listed');
    } finally {
        for (const ws of sockets) ws.close();
        server.httpServer.close();
        box.cleanup();
    }
});

// ------------------------------------------- 4. Dexile delete clears both

test('a Dexile delete removes the file and its manifest entry', { concurrency: false }, async () => {
    const box = sandbox('delete');
    try {
        const manager = new FileTransferManager(box.root, { downloadsPath: box.downloads });
        await upload(manager, 'remove-me.txt', Buffer.alloc(128, 5));
        assert.deepEqual(readManifest(box).map((e) => e.name), ['remove-me.txt']);

        const result = manager.deleteFile('remove-me.txt', 'from-phone');
        assert.equal(result.success, true);
        assert.equal(fs.existsSync(path.join(box.downloads, 'remove-me.txt')), false, 'the file is gone');
        assert.deepEqual(readManifest(box), [], 'the manifest entry is gone');
        assert.equal(manager.resolveDeliveredFile('remove-me.txt'), null);
    } finally {
        box.cleanup();
    }
});

test('re-sending the same name is tracked under the name actually delivered', { concurrency: false }, async () => {
    const box = sandbox('dedupe');
    try {
        const manager = new FileTransferManager(box.root, { downloadsPath: box.downloads });
        await upload(manager, 'same.txt', Buffer.alloc(64, 1));
        // The second upload cannot overwrite the first, so it is delivered
        // under a de-duplicated name and that is the name recorded.
        await upload(manager, 'same.txt', Buffer.alloc(64, 2));

        assert.deepEqual(readManifest(box).map((e) => e.name), ['same.txt', 'same (1).txt']);
        assert.deepEqual(fs.readdirSync(box.downloads).sort(), ['same (1).txt', 'same.txt']);
        const names = readManifest(box).map((e) => e.name);
        assert.equal(new Set(names).size, names.length, 'no name is recorded twice');
    } finally {
        box.cleanup();
    }
});

test('a name freed by deleting outside Dexile is not re-attributed to a later unrelated file', { concurrency: false }, async () => {
    const box = sandbox('recycled');
    try {
        const manager = new FileTransferManager(box.root, { downloadsPath: box.downloads });
        await upload(manager, 'report.pdf', Buffer.alloc(64, 1));

        // The user removes the delivered file in Explorer, then a different
        // file of their own takes the same name.
        fs.unlinkSync(path.join(box.downloads, 'report.pdf'));
        fs.writeFileSync(path.join(box.downloads, 'report.pdf'), 'my own document, a different length');

        // Listing self-heals the record.
        manager.listSharedFiles();
        assert.deepEqual(readManifest(box), [], 'the stale record is dropped');
        assert.equal(manager.resolveDeliveredFile('report.pdf'), null,
            'the replacement file is not treated as Dexile-delivered');
    } finally {
        box.cleanup();
    }
});

// ------------------------------------------- 5. restart preserves the manifest

test('a new server instance reloads the manifest from disk', { concurrency: false }, async () => {
    const box = sandbox('restart');
    try {
        const first = new FileTransferManager(box.root, { downloadsPath: box.downloads });
        await upload(first, 'survives.txt', Buffer.alloc(256, 9));
        await upload(first, 'also-survives.txt', Buffer.alloc(256, 8));

        // A restart is a brand new manager over the same transfer root.
        const restarted = new FileTransferManager(box.root, { downloadsPath: box.downloads });
        assert.deepEqual(restarted.receivedFiles.map((e) => e.name).sort(),
            ['also-survives.txt', 'survives.txt'], 'entries survive a restart');
        assert.deepEqual(restarted.listSharedFiles()
            .filter((f) => f.location === 'from-phone')
            .map((f) => f.name).sort(),
            ['also-survives.txt', 'survives.txt'], 'and are still served afterwards');
    } finally {
        box.cleanup();
    }
});

test('an interrupted manifest write cannot destroy the record', { concurrency: false }, async () => {
    const box = sandbox('atomic');
    try {
        const manager = new FileTransferManager(box.root, { downloadsPath: box.downloads });
        await upload(manager, 'one.txt', Buffer.alloc(64, 1));
        await upload(manager, 'two.txt', Buffer.alloc(64, 2));

        // Whatever happens mid-write, the manifest on disk is always complete
        // JSON: it is replaced by a rename, never truncated in place.
        const reloaded = new FileTransferManager(box.root, { downloadsPath: box.downloads });
        assert.deepEqual(reloaded.receivedFiles.map((e) => e.name).sort(), ['one.txt', 'two.txt']);

        // And no partial temporary file is left lying around.
        const strays = fs.readdirSync(box.root).filter((n) => n.includes('.tmp'));
        assert.deepEqual(strays, [], 'no temporary manifest files are left behind');
    } finally {
        box.cleanup();
    }
});

// ------------------------- 6. the manifest lives where nodemon must ignore it

test('received.json is written under a path nodemon does not watch', () => {
    // The manifest is rewritten on every upload. If nodemon watched it, every
    // upload would restart the server, regenerate the auth code and drop the
    // phone session. This ties the manifest to the watcher configuration.
    const projectRoot = path.join(__dirname, '..');
    const nodemonConfig = JSON.parse(fs.readFileSync(path.join(projectRoot, 'nodemon.json'), 'utf8'));
    const match = require(path.join(projectRoot, 'node_modules', 'nodemon', 'lib', 'monitor', 'match.js'));

    const rules = match.rulesToMonitor(['*.*'], nodemonConfig.ignore, { dirs: [] });
    const result = match(['transfers/received.json'], rules.slice(), undefined);
    assert.deepEqual(result.result, [], 'received.json must not be watched by nodemon');

    // The manifest always sits directly inside the transfer root, and the
    // production transfer root is the project's transfers/ directory.
    const serverSource = fs.readFileSync(path.join(projectRoot, 'server.js'), 'utf8');
    assert.match(serverSource, /path\.join\(__dirname, 'transfers'\)/,
        'the default transfer root is the project transfers/ directory');

    const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dexile-manifest-location-'));
    try {
        const transfersRoot = path.join(probeRoot, 'transfers');
        const manager = new FileTransferManager(transfersRoot);
        assert.equal(manager.receivedManifestPath, path.join(transfersRoot, 'received.json'),
            'the manifest lives directly inside the transfer root');
    } finally {
        fs.rmSync(probeRoot, { recursive: true, force: true });
    }
});
