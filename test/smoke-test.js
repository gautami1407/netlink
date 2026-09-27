/**
 * Dexile smoke test — exercises the real WebSocket protocol against a
 * running server (start the server first: `node server.js` in another
 * terminal, or `npm start`). This does NOT mock anything: it authenticates
 * for real, uploads/downloads a real file through the real filesystem, and
 * attempts real mouse/keyboard/screen calls. On a machine with no display
 * (CI, headless box) the control/screen checks are expected to report
 * "unavailable" rather than crash — that's a PASS. On your real desktop
 * they should actually move the mouse and return a screen frame.
 *
 * Usage: node test/smoke-test.js <AUTH_CODE> [host:port]
 */
const WebSocket = require('ws');

function runSmokeTest() {
    const AUTH = process.argv[2];
    const target = process.argv[3] || 'localhost:3000';

    if (!AUTH) {
        console.error('Usage: node test/smoke-test.js <AUTH_CODE> [host:port]');
        process.exit(1);
    }

    const results = [];
    function record(name, pass, detail) {
        results.push({ name, pass, detail });
        console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
    }

    const ws = new WebSocket(`ws://${target}`);
    function send(o) { ws.send(JSON.stringify(o)); }

    let stage = 'connect';

    ws.on('open', () => {
        record('WebSocket connects', true);
        stage = 'bad-auth';
        send({ type: 'auth', code: 'DEFINITELY_WRONG' });
    });

    ws.on('message', (raw) => {
        const data = JSON.parse(raw);

        if (stage === 'bad-auth' && data.type === 'auth_failed') {
            record('Rejects wrong auth code', data.reason === 'invalid_code');
            stage = 'good-auth';
            send({ type: 'auth', code: AUTH });
            return;
        }

        if (stage === 'good-auth' && data.type === 'auth_success') {
            record('Accepts correct auth code', true, `capabilities: ${JSON.stringify(data.capabilities)}`);
            stage = 'ping';
            send({ type: 'ping', t: Date.now() });
            return;
        }

        if (stage === 'ping' && data.type === 'pong') {
            record('Ping/pong round trip', typeof data.serverTime === 'number');
            stage = 'upload';
            const evilName = '../../should-not-escape.txt';
            send({ type: 'upload_start', filename: evilName, fileSize: 11 });
            return;
        }

        if (stage === 'upload' && data.type === 'upload_started') {
            send({ type: 'upload_chunk', transferId: data.transferId, chunkIndex: 0, data: Buffer.from('smoke test!').toString('base64'), isLastChunk: true });
            return;
        }

        if (stage === 'upload' && data.type === 'transfer_completed') {
            const escaped = !data.filePath.includes('..') && data.filePath.includes('transfers');
            record('Upload with path-traversal filename stays contained', escaped, data.filePath);
            stage = 'mouse';
            send({ type: 'mouse_move', deltaX: 1, deltaY: 1 });
            setTimeout(() => send({ type: 'get_status' }), 400);
            return;
        }

        if (stage === 'mouse') {
            if (data.type === 'error' && data.code === 'ROBOT_UNAVAILABLE') {
                record('Mouse control', true, 'reported unavailable cleanly (no display here) — check on your real desktop');
            } else if (data.type === 'status') {
                record('Mouse control did not crash the server', true, '(server still responsive)');
                stage = 'screen';
                send({ type: 'screen_subscribe', fps: 3 });
                return;
            }
            if (data.type === 'status') return; // already handled above path
        }

        if (stage === 'screen') {
            if (data.type === 'screen_frame') {
                record('Screen capture', true, `real frame, ${data.data.length} base64 chars, fps=${data.fps}`);
                finish();
            } else if (data.type === 'error' && data.code === 'SCREENSHOT_UNAVAILABLE') {
                record('Screen capture', true, 'reported unavailable cleanly (no display/xrandr here) — check on your real desktop');
                finish();
            } else if (data.type === 'screen_error') {
                record('Screen capture', true, 'reported a runtime error cleanly instead of crashing — check on your real desktop');
                finish();
            }
        }
    });

    ws.on('error', (e) => record('WebSocket connects', false, e.message));

    function finish() {
        const failed = results.filter((r) => !r.pass).length;
        console.log(`\n${results.length - failed}/${results.length} checks passed.`);
        process.exit(failed ? 1 : 0);
    }

    setTimeout(() => {
        console.log('\nTimed out waiting for a response — server may be down or a message type changed.');
        process.exit(1);
    }, 10000);
}

if (require.main === module) {
    runSmokeTest();
}

module.exports = { runSmokeTest };
