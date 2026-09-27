// Guards the development-server watcher configuration.
//
// The failure this prevents: Dexile writes runtime files under transfers/ on
// every upload, delete, screenshot, recording and cleanup. With the default
// nodemon watch rule those writes restarted server.js, which regenerated the
// authentication code and dropped every connected phone.
//
// This test drives nodemon's own matcher (the exact function nodemon uses to
// decide whether a changed file is watched) with the real nodemon.json, so it
// asserts real nodemon behaviour rather than a stand-in for it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const configPath = path.join(projectRoot, 'nodemon.json');
const packageJson = require('../package.json');

// nodemon's internal matcher. Resolved from the installed dependency so the
// rules are interpreted exactly as the running nodemon interprets them.
const match = require(path.join(projectRoot, 'node_modules', 'nodemon', 'lib', 'monitor', 'match.js'));

// nodemon's default watch rule when nodemon.json does not override it.
const defaultWatch = ['*.*'];

function loadIgnore() {
    assert.equal(fs.existsSync(configPath), true, 'nodemon.json must exist');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.ok(Array.isArray(config.ignore), 'nodemon.json must declare an ignore array');
    return config.ignore;
}

// Runs nodemon's matcher over a set of relative paths and returns which ones
// it would treat as watched (and therefore restart on).
function classify(ignore, files) {
    const rules = match.rulesToMonitor(defaultWatch, ignore, { dirs: [] });
    return match(files, rules.slice(), undefined);
}

test('nodemon is configured, and the dev script still uses it', () => {
    assert.match(packageJson.scripts.dev, /nodemon/, 'npm run dev must still run under nodemon');
});

test('the watcher configuration does not narrow what nodemon watches', () => {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    // No `watch` override: nodemon keeps its default `*.*`, so every source
    // file still triggers a restart. Pinning this catches a well-meaning
    // future edit that quietly stops restarting on, say, client.html.
    assert.equal(config.watch, undefined,
        'nodemon.json must not override `watch`; the default *.* rule is what keeps source changes restarting');
});

test('runtime files under transfers/ do not trigger a restart', () => {
    const ignore = loadIgnore();
    const runtimeWrites = [
        // Phone upload and its manifest, both written on every completed upload.
        'transfers/incoming/IMG_20260911_133620.jpg',
        'transfers/received.json',
        // Delete / cleanup removes a staged file.
        'transfers/incoming/photo.jpg',
        // Screenshot capture.
        'transfers/incoming/screenshot-1758000000000.png',
        // A recording writes a whole directory of frames at once.
        'transfers/incoming/recording-1758000000000/frame-000.png',
        'transfers/incoming/recording-1758000000000/metadata.json',
        // Temp files and the outgoing/shared-file directory.
        'transfers/temp/upload-12345.tmp',
        'transfers/outgoing/Visible.txt'
    ];
    const result = classify(ignore, runtimeWrites);
    assert.deepEqual(result.result, [],
        'no runtime file may be watched; nodemon would restart on: ' + result.result.join(', '));
    assert.equal(result.ignored, runtimeWrites.length, 'every runtime write is ignored');
});

test('source changes still trigger a restart', () => {
    const ignore = loadIgnore();
    const sourceFiles = [
        'server.js',
        'filetransfer.js',
        'client.html',
        'package.json',
        'test/transfer-integrity.test.js'
    ];
    const result = classify(ignore, sourceFiles);
    assert.equal(result.result.length, sourceFiles.length,
        'every source file must stay watched; these would be ignored: '
            + sourceFiles.filter((f) => !result.result.some((r) => r.toLowerCase().endsWith(f.toLowerCase()))).join(', '));
});

test('the transfers directory is ignored whether or not it exists yet', () => {
    // A bare "transfers" entry is resolved with fs.statSync at config load. On
    // a fresh clone the directory does not exist, and the rule would otherwise
    // degrade to one that matches the directory but not the files inside it.
    const sandbox = fs.mkdtempSync(path.join(require('os').tmpdir(), 'dexile-nodemon-'));
    try {
        fs.writeFileSync(path.join(sandbox, 'nodemon.json'), fs.readFileSync(configPath, 'utf8'));
        const ignore = JSON.parse(fs.readFileSync(path.join(sandbox, 'nodemon.json'), 'utf8')).ignore;
        const previousCwd = process.cwd();
        process.chdir(sandbox);
        try {
            assert.equal(fs.existsSync('transfers'), false, 'precondition: transfers/ is absent here');
            const rules = match.rulesToMonitor(defaultWatch, ignore, { dirs: [] });
            const result = match(
                ['transfers/incoming/a.jpg', 'transfers/received.json', 'server.js'],
                rules.slice(),
                undefined
            );
            const watched = result.result.map((p) => path.relative(sandbox, p).toLowerCase());
            assert.deepEqual(watched, ['server.js'],
                'runtime paths stay ignored on a fresh clone; watched: ' + watched.join(', '));
        } finally {
            process.chdir(previousCwd);
        }
    } finally {
        fs.rmSync(sandbox, { recursive: true, force: true });
    }
});
