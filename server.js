const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const FileTransferManager = require('./filetransfer');

// ==========================================================================
// Platform-specific / native imports.
// These are optional at the module level: if they fail to load (missing
// native binary, unsupported platform, headless sandbox, etc.) the server
// still starts, but every feature that depends on them reports itself as
// genuinely unavailable instead of pretending to work.
// ==========================================================================
let robot = null;
let screenshot = null;
let robotLoadError = null;
let screenshotLoadError = null;

try {
    robot = require('robotjs');
} catch (error) {
    robotLoadError = error.message;
}

// robotjs talks to X11 directly on Linux. Verified in testing: when no
// display is reachable, its native binding calls a hard process exit —
// not a JS exception — so no try/catch or uncaughtException handler can
// stop it. DISPLAY being unset is a strong signal no X server is reachable;
// refusing to load robotjs in that case trades "control unavailable" for
// "server crashes on the first mouse event," which is the right trade for
// a server meant to stay up for every other connected client.
if (robot && process.platform === 'linux' && !process.env.DISPLAY) {
    robot = null;
    robotLoadError = 'No DISPLAY environment variable detected — robotjs requires a reachable X11 display on Linux. ' +
        'If a display genuinely is available, set DISPLAY (e.g. DISPLAY=:0) before starting the server.';
}

try {
    screenshot = require('screenshot-desktop');
} catch (error) {
    screenshotLoadError = error.message;
}

// screenshot-desktop shells out to platform CLI tools. On Linux it depends on
// xrandr (package x11-xserver-utils) being present; when it's missing, the
// failure surfaces from an internal exec() callback outside any promise we
// can await/catch, which — verified in testing — crashes the whole process
// instead of just failing one capture. Detecting this up front and marking
// the capability unavailable is safer than attempting a capture and hoping.
if (screenshot && process.platform === 'linux') {
    const { execSync } = require('child_process');
    try {
        execSync('which xrandr', { stdio: 'ignore' });
    } catch (error) {
        screenshot = null;
        screenshotLoadError = 'xrandr not found (required by screenshot-desktop on Linux — install the x11-xserver-utils package)';
    }
}

// ==========================================================================
// WebSocket protocol (documented — see README "Protocol" section for the
// client-side contract). Every inbound message is validated by TYPE below
// before any handler runs; unknown fields are ignored, missing/mistyped
// required fields are rejected with a structured error.
// ==========================================================================
const MAX_ACTIVITY_LOG = 200;
const MAX_AUTH_ATTEMPTS = 5;
const AUTH_LOCKOUT_MS = 30 * 1000;
const SCREEN_MIN_FPS = 1;
const SCREEN_MAX_FPS = 15;
const SCREEN_DEFAULT_FPS = 6;
const MAX_WS_MESSAGE_BYTES = 8 * 1024 * 1024; // 8MB per message (chunked transfer keeps real payloads well under this)

class DexileServer {
    constructor(port = 3000) {
        this.port = port;
        this.authCode = this.generateAuthCode();
        this.clients = new Map(); // ws -> client state
        this.authAttemptsByIp = new Map(); // ip -> { count, lockedUntil }
        this.activityLog = [];
        this.startTime = Date.now();

        this.fileTransferPath = path.join(__dirname, 'transfers');
        this.fileTransfer = new FileTransferManager(this.fileTransferPath);
        this.fileTransfer.on('progress', (evt) => this.broadcastTransferProgress(evt));
        this.fileTransfer.on('completed', (evt) => this.broadcastTransferCompleted(evt));
        this.fileTransfer.on('cancelled', (evt) => this.broadcastTransferCancelled(evt));

        this.clientHtmlPath = path.join(__dirname, 'client.html');

        this.screenCaptureTimer = null;
        this.screenFrameSeq = 0;
        this.lastFrameSentAt = 0;

        setInterval(() => this.fileTransfer.cleanup(), 60 * 60 * 1000).unref();

        this.initializeServer();
        this.displayAuthCode();
    }

    // ---------------------------------------------------------------- utils

    generateAuthCode() {
        return crypto.randomBytes(4).toString('hex').toUpperCase();
    }

    log(message) {
        console.log(message);
    }

    recordActivity(type, message) {
        const entry = { type, message, timestamp: new Date().toISOString() };
        this.activityLog.push(entry);
        if (this.activityLog.length > MAX_ACTIVITY_LOG) {
            this.activityLog.shift();
        }
        this.broadcast({ type: 'activity', activity: entry }, true);
        return entry;
    }

    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    getLanAddress() {
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    return iface.address;
                }
            }
        }
        return null;
    }

    getDeviceInfo() {
        return {
            hostname: os.hostname(),
            platform: process.platform,
            arch: process.arch,
            osRelease: os.release(),
            nodeVersion: process.version,
            lanAddress: this.getLanAddress() || 'Unavailable',
            cpuCount: os.cpus() ? os.cpus().length : 'Unavailable',
            totalMemory: this.formatFileSize(os.totalmem()),
            freeMemory: this.formatFileSize(os.freemem()),
            uptimeSeconds: Math.floor(process.uptime())
        };
    }

    getCapabilities() {
        return {
            screen: !!screenshot,
            mouse: !!robot,
            keyboard: !!robot,
            gestures: !!robot,
            screenUnavailableReason: screenshot ? null : (screenshotLoadError || 'screenshot-desktop not installed'),
            controlUnavailableReason: robot ? null : (robotLoadError || 'robotjs not installed')
        };
    }

    // ------------------------------------------------------------- display

    displayAuthCode() {
        const caps = this.getCapabilities();
        console.log('\n' + '='.repeat(60));
        console.log('🚀 DEXILE SERVER STARTED');
        console.log('='.repeat(60));
        console.log(`📡 Port:              ${this.port}`);
        console.log(`🔐 Auth code:         ${this.authCode}`);
        console.log(`🌐 LAN address:       ${this.getLanAddress() || 'Unavailable'}`);
        console.log(`📁 Transfers dir:     ${this.fileTransferPath}`);
        console.log(`🖥️  Screen capture:    ${caps.screen ? 'available' : 'UNAVAILABLE — ' + caps.screenUnavailableReason}`);
        console.log(`🖱️  Mouse/keyboard:    ${caps.mouse ? 'available' : 'UNAVAILABLE — ' + caps.controlUnavailableReason}`);
        console.log('='.repeat(60));
        console.log('💡 Share the auth code with the device you want to connect from.');
        console.log('⚡ Type "help" for server console commands.\n');
    }

    // -------------------------------------------------------------- server

    initializeServer() {
        let clientHtml = null;
        try {
            clientHtml = fs.readFileSync(this.clientHtmlPath, 'utf8');
        } catch (error) {
            console.error(`❌ Could not read client.html at ${this.clientHtmlPath}: ${error.message}`);
        }

        const server = http.createServer((req, res) => {
            if (req.url === '/health') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ok', ...this.getStatus() }));
                return;
            }
            if (clientHtml) {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(clientHtml);
                return;
            }
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('client.html not found on server.');
        });

        this.wss = new WebSocket.Server({
            server,
            maxPayload: MAX_WS_MESSAGE_BYTES
        });

        this.wss.on('connection', (ws, req) => {
            const ip = req.socket.remoteAddress;
            const clientId = crypto.randomBytes(6).toString('hex');

            this.clients.set(ws, {
                id: clientId,
                ip,
                authenticated: false,
                connectedAt: Date.now(),
                subscribedToScreen: false,
                screenFps: SCREEN_DEFAULT_FPS
            });

            console.log(`📱 Connection opened from ${ip} (${clientId})`);

            ws.on('message', (raw) => {
                let data;
                try {
                    data = JSON.parse(raw);
                } catch (error) {
                    this.sendError(ws, 'Invalid message format: not valid JSON', 'BAD_JSON');
                    return;
                }
                if (!data || typeof data.type !== 'string') {
                    this.sendError(ws, 'Message missing a string "type" field', 'BAD_SHAPE');
                    return;
                }
                this.handleMessage(ws, data);
            });

            ws.on('close', () => {
                const client = this.clients.get(ws);
                if (client) {
                    console.log(`📱 Client disconnected (${client.id})`);
                    if (client.authenticated) {
                        this.recordActivity('connection', `Device disconnected (${client.id})`);
                    }
                }
                this.clients.delete(ws);
                this.updateScreenCaptureLoop();
            });

            ws.on('error', (error) => {
                console.error(`❌ WebSocket error (${clientId}):`, error.message);
            });
        });

        server.listen(this.port, () => {
            console.log(`Server listening on port ${this.port}`);
        });

        this.httpServer = server;
    }

    // ------------------------------------------------------------ dispatch

    handleMessage(ws, data) {
        const client = this.clients.get(ws);
        if (!client) return;

        if (data.type === 'auth') {
            this.handleAuthentication(ws, data);
            return;
        }

        if (!client.authenticated) {
            this.sendError(ws, 'Not authenticated', 'UNAUTHENTICATED');
            return;
        }

        switch (data.type) {
            case 'ping':
                this.handlePing(ws, data);
                break;
            case 'get_status':
                this.sendStatusSnapshot(ws);
                break;
            case 'mouse_move':
                this.handleMouseMove(ws, data);
                break;
            case 'mouse_button':
                this.handleMouseButton(ws, data);
                break;
            case 'gesture':
                this.handleGesture(ws, data);
                break;
            case 'keyboard':
                this.handleKeyboard(ws, data);
                break;
            case 'screen_subscribe':
                this.handleScreenSubscribe(ws, data);
                break;
            case 'screen_unsubscribe':
                this.handleScreenUnsubscribe(ws);
                break;
            case 'upload_start':
                this.handleUploadStart(ws, data);
                break;
            case 'upload_chunk':
                this.handleUploadChunk(ws, data);
                break;
            case 'upload_cancel':
                this.handleTransferCancel(ws, data);
                break;
            case 'list_files':
                this.handleListFiles(ws);
                break;
            case 'download_start':
                this.handleDownloadStart(ws, data);
                break;
            case 'download_chunk_request':
                this.handleDownloadChunkRequest(ws, data);
                break;
            case 'download_cancel':
                this.handleTransferCancel(ws, data);
                break;
            case 'delete_file':
                this.handleDeleteFile(ws, data);
                break;
            default:
                this.sendError(ws, `Unknown message type: ${data.type}`, 'UNKNOWN_TYPE');
        }
    }

    send(ws, payload) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(payload));
        }
    }

    sendError(ws, message, code = 'ERROR') {
        this.send(ws, { type: 'error', message, code });
    }

    broadcast(payload, authenticatedOnly = false) {
        const message = JSON.stringify(payload);
        for (const [ws, client] of this.clients) {
            if (authenticatedOnly && !client.authenticated) continue;
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(message);
            }
        }
    }

    // --------------------------------------------------------------- auth

    handleAuthentication(ws, data) {
        const client = this.clients.get(ws);
        const ip = client ? client.ip : 'unknown';
        const now = Date.now();
        const attempt = this.authAttemptsByIp.get(ip) || { count: 0, lockedUntil: 0 };

        if (attempt.lockedUntil && now < attempt.lockedUntil) {
            const waitSec = Math.ceil((attempt.lockedUntil - now) / 1000);
            this.send(ws, { type: 'auth_failed', reason: 'locked', message: `Too many attempts. Try again in ${waitSec}s.` });
            return;
        }

        if (typeof data.code === 'string' && data.code === this.authCode) {
            client.authenticated = true;
            this.authAttemptsByIp.delete(ip);
            this.send(ws, {
                type: 'auth_success',
                clientId: client.id,
                capabilities: this.getCapabilities(),
                device: this.getDeviceInfo()
            });
            console.log(`✅ Client authenticated (${client.id} @ ${ip})`);
            this.recordActivity('connection', `Device connected and authenticated (${client.id})`);
        } else {
            attempt.count += 1;
            if (attempt.count >= MAX_AUTH_ATTEMPTS) {
                attempt.lockedUntil = now + AUTH_LOCKOUT_MS;
                attempt.count = 0;
            }
            this.authAttemptsByIp.set(ip, attempt);
            this.send(ws, { type: 'auth_failed', reason: 'invalid_code', message: 'Invalid authentication code.' });
            console.log(`❌ Authentication failed from ${ip}`);
        }
    }

    // ------------------------------------------------------------ latency

    handlePing(ws, data) {
        this.send(ws, { type: 'pong', clientTime: data.t, serverTime: Date.now() });
    }

    // ------------------------------------------------------------- status

    getStatus() {
        return {
            port: this.port,
            connectedClients: Array.from(this.clients.values()).filter((c) => c.authenticated).length,
            uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
            capabilities: this.getCapabilities(),
            device: this.getDeviceInfo(),
            transferStats: this.fileTransfer.getStats()
        };
    }

    sendStatusSnapshot(ws) {
        this.send(ws, {
            type: 'status',
            ...this.getStatus(),
            activeTransfers: this.fileTransfer.getActiveTransfers(),
            recentActivity: this.activityLog.slice(-30)
        });
    }

    // --------------------------------------------------------------- mouse

    handleMouseMove(ws, data) {
        if (!robot) {
            this.sendError(ws, 'Mouse control unavailable on this server', 'ROBOT_UNAVAILABLE');
            return;
        }
        const deltaX = Number(data.deltaX);
        const deltaY = Number(data.deltaY);
        if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
            this.sendError(ws, 'mouse_move requires numeric deltaX/deltaY', 'BAD_ARGS');
            return;
        }
        try {
            const currentPos = robot.getMousePos();
            const newX = Math.max(0, currentPos.x + deltaX);
            const newY = Math.max(0, currentPos.y + deltaY);
            robot.moveMouse(newX, newY);
        } catch (error) {
            console.error('❌ Error moving mouse:', error.message);
            this.sendError(ws, 'Failed to move mouse', 'ROBOT_ERROR');
        }
    }

    handleMouseButton(ws, data) {
        if (!robot) {
            this.sendError(ws, 'Mouse control unavailable on this server', 'ROBOT_UNAVAILABLE');
            return;
        }
        const button = ['left', 'right', 'middle'].includes(data.button) ? data.button : null;
        const action = ['down', 'up'].includes(data.action) ? data.action : null;
        if (!button || !action) {
            this.sendError(ws, 'mouse_button requires a valid button/action', 'BAD_ARGS');
            return;
        }
        try {
            robot.mouseToggle(action, button);
        } catch (error) {
            console.error('❌ Error toggling mouse button:', error.message);
            this.sendError(ws, 'Failed to send mouse button event', 'ROBOT_ERROR');
        }
    }

    handleGesture(ws, data) {
        if (!robot) {
            this.sendError(ws, 'Gesture control unavailable on this server', 'ROBOT_UNAVAILABLE');
            return;
        }
        try {
            switch (data.gesture) {
                case 'leftClick':
                    robot.mouseClick();
                    break;
                case 'rightClick':
                    robot.mouseClick('right');
                    break;
                case 'doubleClick':
                    robot.mouseClick();
                    setTimeout(() => robot.mouseClick(), 50);
                    break;
                case 'scrollUp':
                    robot.scrollMouse(1, 'up');
                    break;
                case 'scrollDown':
                    robot.scrollMouse(1, 'down');
                    break;
                case 'twoFingerSwipeLeft':
                    this.executeSwipeGesture(ws, 'left');
                    return;
                case 'twoFingerSwipeRight':
                    this.executeSwipeGesture(ws, 'right');
                    return;
                case 'threeFingerSwipeUp':
                    this.executeThreeFingerGesture(ws);
                    return;
                default:
                    this.sendError(ws, `Unknown gesture: ${data.gesture}`, 'UNKNOWN_GESTURE');
                    return;
            }
            this.recordActivity('gesture', `Gesture: ${data.gesture}`);
        } catch (error) {
            console.error('❌ Error executing gesture:', error.message);
            this.sendError(ws, 'Failed to execute gesture', 'ROBOT_ERROR');
        }
    }

    // App switching / task view is genuinely OS-specific. Rather than silently
    // no-op on platforms we don't support (the original Linux gap), we tell
    // the client the truth.
    executeSwipeGesture(ws, direction) {
        try {
            if (process.platform === 'win32') {
                robot.keyTap('tab', direction === 'left' ? ['alt', 'shift'] : ['alt']);
            } else if (process.platform === 'darwin') {
                robot.keyTap('tab', direction === 'left' ? ['cmd', 'shift'] : ['cmd']);
            } else if (process.platform === 'linux') {
                robot.keyTap('tab', direction === 'left' ? ['alt', 'shift'] : ['alt']);
            } else {
                this.sendError(ws, `App-switch gesture not supported on ${process.platform}`, 'UNSUPPORTED_PLATFORM');
                return;
            }
            this.recordActivity('gesture', `App switch (${direction})`);
        } catch (error) {
            this.sendError(ws, 'Failed to execute gesture', 'ROBOT_ERROR');
        }
    }

    executeThreeFingerGesture(ws) {
        try {
            if (process.platform === 'win32') {
                robot.keyTap('tab', ['cmd']);
            } else if (process.platform === 'darwin') {
                robot.keyTap('f3', ['ctrl']);
            } else {
                // There is no single standard "show all windows" shortcut across
                // Linux desktop environments, so this is honestly unsupported
                // rather than silently doing nothing.
                this.sendError(ws, 'Task view gesture is not supported on Linux (no standard shortcut across desktop environments)', 'UNSUPPORTED_PLATFORM');
                return;
            }
            this.recordActivity('gesture', 'Task view / Mission Control');
        } catch (error) {
            this.sendError(ws, 'Failed to execute gesture', 'ROBOT_ERROR');
        }
    }

    // ------------------------------------------------------------ keyboard

    handleKeyboard(ws, data) {
        if (!robot) {
            this.sendError(ws, 'Keyboard control unavailable on this server', 'ROBOT_UNAVAILABLE');
            return;
        }
        if (typeof data.key !== 'string' || data.key.length === 0) {
            this.sendError(ws, 'keyboard requires a "key" string', 'BAD_ARGS');
            return;
        }

        try {
            const modifiers = [];
            if (data.ctrlKey) modifiers.push('control');
            if (data.altKey) modifiers.push('alt');
            if (data.shiftKey) modifiers.push('shift');
            if (data.metaKey) modifiers.push(process.platform === 'darwin' ? 'command' : 'control');

            const specialKeys = {
                Enter: 'enter', Backspace: 'backspace', Tab: 'tab', Escape: 'escape',
                ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
                Delete: 'delete', Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown',
                F1: 'f1', F2: 'f2', F3: 'f3', F4: 'f4', F5: 'f5', F6: 'f6',
                F7: 'f7', F8: 'f8', F9: 'f9', F10: 'f10', F11: 'f11', F12: 'f12',
                ' ': 'space'
            };

            // Pure modifier presses (Shift alone, etc.) aren't independently
            // meaningful to robotjs's keyTap model — ignore them rather than
            // sending a bogus keystroke.
            const isBareModifier = ['Control', 'Alt', 'Shift', 'Meta'].includes(data.key);
            if (isBareModifier) {
                return;
            }

            if (specialKeys[data.key]) {
                robot.keyTap(specialKeys[data.key], modifiers);
            } else if (data.key.length === 1) {
                robot.keyTap(data.key.toLowerCase(), modifiers);
            } else {
                // Unrecognized multi-char key name (e.g. an obscure browser key) —
                // report it rather than silently dropping it.
                this.sendError(ws, `Unsupported key: ${data.key}`, 'UNSUPPORTED_KEY');
                return;
            }
        } catch (error) {
            console.error('❌ Error handling keyboard input:', error.message);
            this.sendError(ws, 'Failed to send key', 'ROBOT_ERROR');
        }
    }

    // --------------------------------------------------------------- screen

    handleScreenSubscribe(ws, data) {
        if (!screenshot) {
            this.sendError(ws, 'Screen capture unavailable on this server', 'SCREENSHOT_UNAVAILABLE');
            return;
        }
        const client = this.clients.get(ws);
        if (!client) return;
        let fps = Number(data.fps) || SCREEN_DEFAULT_FPS;
        fps = Math.min(SCREEN_MAX_FPS, Math.max(SCREEN_MIN_FPS, fps));
        client.subscribedToScreen = true;
        client.screenFps = fps;
        this.updateScreenCaptureLoop();
    }

    handleScreenUnsubscribe(ws) {
        const client = this.clients.get(ws);
        if (!client) return;
        client.subscribedToScreen = false;
        this.updateScreenCaptureLoop();
    }

    // A single shared capture loop serves every subscribed client at the
    // fastest FPS any of them requested; this avoids one screenshot-desktop
    // call per subscriber. The loop is fully torn down when nobody is
    // subscribed so an idle server does zero capture work.
    updateScreenCaptureLoop() {
        const subscribers = Array.from(this.clients.values()).filter((c) => c.authenticated && c.subscribedToScreen);

        if (subscribers.length === 0) {
            if (this.screenCaptureTimer) {
                clearInterval(this.screenCaptureTimer);
                this.screenCaptureTimer = null;
            }
            return;
        }

        const targetFps = Math.max(...subscribers.map((c) => c.screenFps));
        const intervalMs = Math.round(1000 / targetFps);

        if (this.screenCaptureTimer) {
            clearInterval(this.screenCaptureTimer);
        }

        let capturing = false;
        this.screenCaptureTimer = setInterval(async () => {
            if (capturing) return; // don't overlap captures if one is slow
            capturing = true;
            const captureStart = Date.now();
            try {
                const buffer = await screenshot({ format: 'jpg' });
                const now = Date.now();
                const measuredIntervalMs = this.lastFrameSentAt ? now - this.lastFrameSentAt : intervalMs;
                this.lastFrameSentAt = now;
                this.screenFrameSeq += 1;

                const frame = {
                    type: 'screen_frame',
                    seq: this.screenFrameSeq,
                    format: 'jpeg',
                    data: buffer.toString('base64'),
                    capturedAt: now,
                    captureMs: now - captureStart,
                    fps: Math.round((1000 / measuredIntervalMs) * 10) / 10
                };
                const message = JSON.stringify(frame);
                for (const [cws, c] of this.clients) {
                    if (c.authenticated && c.subscribedToScreen && cws.readyState === WebSocket.OPEN) {
                        cws.send(message);
                    }
                }
            } catch (error) {
                this.broadcast({ type: 'screen_error', message: error.message }, true);
            } finally {
                capturing = false;
            }
        }, intervalMs);
    }

    // --------------------------------------------------------- file upload

    async handleUploadStart(ws, data) {
        const client = this.clients.get(ws);
        try {
            if (typeof data.filename !== 'string' || !Number.isFinite(Number(data.fileSize))) {
                this.sendError(ws, 'upload_start requires filename and fileSize', 'BAD_ARGS');
                return;
            }
            const result = await this.fileTransfer.startUpload(data.filename, Number(data.fileSize), client.id);
            client.activeUploadIds = client.activeUploadIds || new Set();
            client.activeUploadIds.add(result.transferId);
            this.send(ws, { type: 'upload_started', transferId: result.transferId, chunkSize: result.chunkSize });
        } catch (error) {
            this.send(ws, { type: 'upload_error', message: error.message, filename: data.filename });
        }
    }

    async handleUploadChunk(ws, data) {
        try {
            if (typeof data.transferId !== 'string' || !Number.isInteger(data.chunkIndex)) {
                this.sendError(ws, 'upload_chunk requires transferId and integer chunkIndex', 'BAD_ARGS');
                return;
            }
            const result = await this.fileTransfer.handleChunk(data.transferId, data.chunkIndex, data.data, !!data.isLastChunk);
            this.send(ws, { type: 'upload_progress', transferId: data.transferId, progress: result.progress });
        } catch (error) {
            this.send(ws, { type: 'upload_error', message: error.message, transferId: data.transferId });
        }
    }

    handleTransferCancel(ws, data) {
        try {
            this.fileTransfer.cancelTransfer(data.transferId);
        } catch (error) {
            this.sendError(ws, error.message, 'TRANSFER_ERROR');
        }
    }

    broadcastTransferProgress(evt) {
        this.broadcast({ type: 'transfer_progress', ...evt }, true);
    }

    broadcastTransferCompleted(evt) {
        this.broadcast({ type: 'transfer_completed', ...evt }, true);
        this.recordActivity('file', `${evt.direction === 'download' ? 'Download' : 'Upload'} completed: ${evt.filename}`);
    }

    broadcastTransferCancelled(evt) {
        this.broadcast({ type: 'transfer_cancelled', ...evt }, true);
        this.recordActivity('file', `Transfer cancelled: ${evt.filename}`);
    }

    // ------------------------------------------------------- file download

    handleListFiles(ws) {
        this.send(ws, {
            type: 'file_list',
            outgoing: this.fileTransfer.listAvailableFiles(),
            incoming: this.fileTransfer.listUploadedFiles()
        });
    }

    async handleDownloadStart(ws, data) {
        const client = this.clients.get(ws);
        try {
            if (typeof data.filename !== 'string') {
                this.sendError(ws, 'download_start requires filename', 'BAD_ARGS');
                return;
            }
            const result = await this.fileTransfer.startDownload(data.filename, client.id);
            this.send(ws, {
                type: 'download_started',
                transferId: result.transferId,
                fileSize: result.fileSize,
                chunkSize: result.chunkSize,
                filename: data.filename
            });
        } catch (error) {
            this.send(ws, { type: 'download_error', message: error.message, filename: data.filename });
        }
    }

    async handleDownloadChunkRequest(ws, data) {
        try {
            if (typeof data.transferId !== 'string' || !Number.isInteger(data.chunkIndex)) {
                this.sendError(ws, 'download_chunk_request requires transferId and integer chunkIndex', 'BAD_ARGS');
                return;
            }
            const chunk = await this.fileTransfer.getChunk(data.transferId, data.chunkIndex);
            this.send(ws, {
                type: 'download_chunk',
                transferId: data.transferId,
                chunkIndex: data.chunkIndex,
                data: chunk.data,
                isLastChunk: chunk.isLastChunk,
                progress: chunk.progress
            });
        } catch (error) {
            this.send(ws, { type: 'download_error', message: error.message, transferId: data.transferId });
        }
    }

    handleDeleteFile(ws, data) {
        try {
            if (typeof data.filename !== 'string') {
                this.sendError(ws, 'delete_file requires filename', 'BAD_ARGS');
                return;
            }
            const direction = data.direction === 'outgoing' ? 'outgoing' : 'incoming';
            this.fileTransfer.deleteFile(data.filename, direction);
            this.send(ws, { type: 'file_deleted', filename: data.filename, direction });
            this.recordActivity('file', `Deleted ${direction} file: ${data.filename}`);
        } catch (error) {
            this.sendError(ws, error.message, 'DELETE_ERROR');
        }
    }

    // ------------------------------------------------------------ lifecycle

    regenerateAuthCode() {
        this.authCode = this.generateAuthCode();
        console.log(`🔐 New authentication code: ${this.authCode}`);
        return this.authCode;
    }

    shutdown() {
        console.log('🛑 Shutting down Dexile server...');
        if (this.screenCaptureTimer) clearInterval(this.screenCaptureTimer);
        this.wss.close();
        this.httpServer.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 1000).unref();
    }
}

// ============================================================== CLI runner

const args = process.argv.slice(2);
const port = args[0] ? parseInt(args[0], 10) : 3000;

const server = new DexileServer(port);

// Defense in depth: a single bad screen-capture or robotjs call should not
// take down mouse/keyboard/file-transfer for every other connected client.
// Verified in testing that some native-module failures surface as process-
// level events rather than catchable exceptions in the call site's try/catch.
// We log loudly and, if the failure looks screen-capture related, disable
// that one subsystem rather than silently retrying into the same crash.
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught exception (server staying up):', error.message);
    if (/screenshot|xrandr|display/i.test(error.message || '')) {
        screenshot = null;
        screenshotLoadError = `Disabled after runtime failure: ${error.message}`;
        if (server.screenCaptureTimer) {
            clearInterval(server.screenCaptureTimer);
            server.screenCaptureTimer = null;
        }
        server.broadcast({ type: 'screen_error', message: 'Screen capture failed and has been disabled: ' + error.message }, true);
    }
    server.recordActivity('system', `Recovered from an internal error: ${error.message}`);
});
process.on('unhandledRejection', (reason) => {
    const message = reason && reason.message ? reason.message : String(reason);
    console.error('❌ Unhandled promise rejection (server staying up):', message);
    server.recordActivity('system', `Recovered from an internal error: ${message}`);
});

process.on('SIGINT', () => server.shutdown());
process.on('SIGTERM', () => server.shutdown());

process.stdin.on('data', (data) => {
    const command = data.toString().trim();
    switch (command) {
        case 'status':
            console.log('📊 Server Status:', JSON.stringify(server.getStatus(), null, 2));
            break;
        case 'newcode':
            server.regenerateAuthCode();
            break;
        case 'help':
            console.log(`
Available commands:
- status: Show server status
- newcode: Generate new authentication code
- help: Show this help message
- exit: Shutdown server
            `);
            break;
        case 'exit':
            server.shutdown();
            break;
        default:
            if (command) {
                console.log('❓ Unknown command. Type "help" for available commands.');
            }
    }
});

module.exports = DexileServer;
