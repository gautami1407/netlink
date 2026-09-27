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
const SCREEN_MAX_FPS = 30;
const SCREEN_DEFAULT_FPS = 6;
const SCREEN_DEFAULT_QUALITY = 'BALANCED';
const SCREEN_PROFILE_DEFAULT_FPS = Object.freeze({ LOW: 3, BALANCED: 6, HIGH: 15 });
const SCREEN_CONFIG_FPS = new Set([3, 6, 10, 15, 20, 30]);
const MAX_WS_MESSAGE_BYTES = 8 * 1024 * 1024; // 8MB per message (chunked transfer keeps real payloads well under this)

class DexileServer {
    constructor(port = 3000, options = {}) {
        this.port = port;
        this.authCode = this.generateAuthCode();
        this.clients = new Map(); // ws -> client state
        this.authAttemptsByIp = new Map(); // ip -> { count, lockedUntil }
        this.activityLog = [];
        this.startTime = Date.now();
        this.sessionSequence = 0;
        this.hostClientId = null;
        this.recordings = new Map(); // clientId -> { frames: [], startTime, intervalId }
        this.audioClients = new Set(); // clientIds that have audio enabled
        this.isCliServer = false;

        this.fileTransferPath = options.transferPath
            ? path.resolve(options.transferPath)
            : path.join(__dirname, 'transfers');
        // Where a completed phone upload is delivered. Resolved from Windows
        // unless an operator overrides it. This is server-side configuration
        // only — a client can never choose where its file is stored.
        this.downloadsPath = options.downloadsPath || process.env.DEXILE_DOWNLOADS_DIR || null;
        this.fileTransfer = new FileTransferManager(this.fileTransferPath, { downloadsPath: this.downloadsPath });
        this.fileTransfer.on('progress', (evt) => this.broadcastTransferProgress(evt));
        this.fileTransfer.on('completed', (evt) => this.broadcastTransferCompleted(evt));
        this.fileTransfer.on('failed', (evt) => this.broadcastTransferFailed(evt));
        this.fileTransfer.on('cancelled', (evt) => this.broadcastTransferCancelled(evt));

        this.clientHtmlPath = path.join(__dirname, 'client.html');

        this.screenCaptureTimer = null;
        this.screenCaptureGeneration = 0;
        this.screenCaptureInProgress = false;
        this.screenFrameSeq = 0;
        this.lastFrameSentAt = 0;

        this.cleanupTimer = setInterval(() => this.fileTransfer.cleanup(), 60 * 60 * 1000);
        this.cleanupTimer.unref();

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

    cancelClientTransfers(clientId) {
        for (const [transferId, transfer] of this.fileTransfer.activeTransfers) {
            if (transfer.clientId === clientId) {
                try {
                    this.fileTransfer.cancelTransfer(transferId);
                } catch (error) {
                    console.error(`❌ Failed to cancel transfer ${transferId}:`, error.message);
                }
            }
        }
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
            audio: false, // Audio capture requires native modules (not implemented)
            media: false, // Media control requires Windows Media Control API (not implemented)
            screenUnavailableReason: screenshot ? null : (screenshotLoadError || 'screenshot-desktop not installed'),
            controlUnavailableReason: robot ? null : (robotLoadError || 'robotjs not installed'),
            audioUnavailableReason: 'Audio capture requires native audio modules (not yet implemented)',
            mediaUnavailableReason: 'Media control requires Windows Media Control API (not yet implemented)'
        };
    }

    // ------------------------------------------------------------- display

    displayAuthCode() {
        const caps = this.getCapabilities();
        const lanAddress = this.getLanAddress();

        console.log('\n' + '='.repeat(60));
        console.log('🚀 DEXILE SERVER STARTED');
        console.log('='.repeat(60));
        console.log(`📡 Port:              ${this.port}`);
        console.log(`🔐 Auth code:         ${this.authCode}`);
        console.log(`🌐 LAN address:       ${lanAddress || 'Unavailable'}`);
        console.log(`📁 Transfers dir:     ${this.fileTransferPath}`);
        console.log(`🖥️  Screen capture:    ${caps.screen ? 'available' : 'UNAVAILABLE — ' + caps.screenUnavailableReason}`);
        console.log(`🖱️  Mouse/keyboard:    ${caps.mouse ? 'available' : 'UNAVAILABLE — ' + caps.controlUnavailableReason}`);
        console.log('='.repeat(60));
        console.log('💡 Share the auth code with the device you want to connect from.');
        // Connecting a device is always: server address + auth code. The code
        // and the LAN address are printed above and nowhere else — there is no
        // QR code, no pairing payload, and no second way in.
        console.log('📱 On the phone, enter the LAN address above and this auth code.');
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

        this.wss.on('error', (error) => {
            console.error(`❌ WebSocket server failed: ${error.message}`);
            if (error.code === 'EADDRINUSE') {
                console.error(`Port ${this.port} is already in use. Stop the other Dexile instance or choose a different port.`);
            }
            process.exitCode = 1;
            this.recordActivity('connection', `WebSocket server failed on port ${this.port}: ${error.message}`);
        });

        this.wss.on('connection', (ws, req) => {
            const ip = req.socket.remoteAddress;
            const clientId = crypto.randomBytes(6).toString('hex');

            this.clients.set(ws, {
                id: clientId,
                ip,
                authenticated: false,
                connectedAt: Date.now(),
                lastActivity: Date.now(),
                lastHeartbeat: Date.now(),
                lastRtt: null,
                subscribedToScreen: false,
                screenFps: SCREEN_DEFAULT_FPS,
                screenQuality: SCREEN_DEFAULT_QUALITY,
                sessionState: 'connecting'
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
                    this.cancelClientTransfers(client.id);
                    
                    // Clean up any active recording
                    const recording = this.recordings.get(client.id);
                    if (recording) {
                        if (recording.intervalId) {
                            clearInterval(recording.intervalId);
                        }
                        this.recordings.delete(client.id);
                    }
                    
                    // Clean up audio streaming
                    this.audioClients.delete(client.id);
                    
                    if (client.authenticated) {
                        this.recordActivity('connection', `Device disconnected (${client.id})`);
                    }
                    if (client.id === this.hostClientId) {
                        const nextHost = Array.from(this.clients.entries())
                            .filter(([candidateWs, candidate]) => candidateWs !== ws && candidate.authenticated)
                            .sort((a, b) => a[1].connectedAt - b[1].connectedAt)[0];
                        this.hostClientId = nextHost ? nextHost[1].id : null;
                    }
                }
                this.clients.delete(ws);
                this.updateScreenCaptureLoop();
                this.broadcastSessionState();
            });

            ws.on('error', (error) => {
                console.error(`❌ WebSocket error (${clientId}):`, error.message);
            });
        });

        server.on('error', (error) => {
            console.error(`❌ HTTP server failed on port ${this.port}: ${error.message}`);
            if (error.code === 'EADDRINUSE') {
                console.error(`Port ${this.port} is already in use. Stop the other Dexile instance or choose a different port.`);
            }
            process.exitCode = 1;
            this.recordActivity('connection', `Server start failed on port ${this.port}: ${error.message}`);
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
        client.lastActivity = Date.now();

        switch (data.type) {
            case 'get_status':
                this.sendStatusSnapshot(ws);
                break;
            case 'session_list':
                this.handleSessionList(ws);
                break;
            case 'session_manage':
                this.handleSessionManage(ws, data);
                break;
            case 'emergency_stop':
                this.handleEmergencyStop(ws, data);
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
            case 'screen_config':
                this.handleScreenConfig(ws, data);
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
            case 'list_shared_files':
                this.handleListSharedFiles(ws);
                break;
            case 'clipboard_push':
                this.handleClipboardPush(ws, data);
                break;
            case 'screenshot_capture':
                this.handleScreenshotCapture(ws);
                break;
            case 'recording_start':
                this.handleRecordingStart(ws);
                break;
            case 'recording_stop':
                this.handleRecordingStop(ws);
                break;
            case 'audio_enable':
                this.handleAudioEnable(ws);
                break;
            case 'audio_disable':
                this.handleAudioDisable(ws);
                break;
            case 'media_control':
                this.handleMediaControl(ws, data.action);
                break;
            case 'ping':
                // Handle ping - works with or without authentication for health checks
                const client = this.clients.get(ws);
                const now = Date.now();
                
                if (client) {
                    // Authenticated client - update tracking and echo back timing data
                    client.lastActivity = now;
                    client.lastHeartbeat = now;
                    client.lastRtt = Number.isFinite(data.rttMs) && data.rttMs >= 0 && data.rttMs <= 120000
                        ? data.rttMs
                        : null;
                    this.send(ws, {
                        type: 'pong',
                        clientTime: Number.isFinite(data.t) ? data.t : null,
                        serverTime: now
                    });
                } else {
                    // Unauthenticated - simple health check response
                    this.send(ws, { type: 'pong' });
                }
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
            if (!this.hostClientId) this.hostClientId = client.id;
            client.lastActivity = now;
            client.lastHeartbeat = now;
            client.sessionState = 'authenticated';
            this.authAttemptsByIp.delete(ip);
            this.send(ws, {
                type: 'auth_success',
                clientId: client.id,
                capabilities: this.getCapabilities(),
                device: this.getDeviceInfo(),
                session: {
                    id: client.id,
                    authenticated: true,
                    connectedAt: client.connectedAt,
                    role: client.id === this.hostClientId ? 'host' : 'client',
                    screenQuality: client.screenQuality,
                    targetFps: client.screenFps
                }
            });
            console.log(`✅ Client authenticated (${client.id} @ ${ip})`);
            this.recordActivity('connection', `Device connected and authenticated (${client.id})`);
            this.broadcastSessionState();
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

    // ------------------------------------------------------------- status

    getSessionList() {
        const now = Date.now();
        return Array.from(this.clients.values())
            .filter((client) => client.authenticated)
            .sort((a, b) => a.connectedAt - b.connectedAt)
            .map((client) => ({
                id: client.id,
                authenticated: !!client.authenticated,
                role: client.id === this.hostClientId ? 'host' : 'client',
                connectedAt: client.connectedAt,
                lastActivity: client.lastActivity || client.connectedAt,
                lastHeartbeat: client.lastHeartbeat || null,
                lastRtt: client.lastRtt == null ? null : client.lastRtt,
                screenSubscribed: !!client.subscribedToScreen,
                screenQuality: client.screenQuality,
                targetFps: client.screenFps,
                connectionState: !client.authenticated
                    ? 'unauthenticated'
                    : (client.lastHeartbeat && now - client.lastHeartbeat < 15000 ? 'connected' : 'stale'),
                isActive: !!client.authenticated
            }));
    }

    getConnectionQuality() {
        const activeClients = Array.from(this.clients.values()).filter((c) => c.authenticated);
        if (activeClients.length === 0) {
            return {
                connectionState: 'disconnected',
                streamHealth: 'idle',
                latencyMs: null,
                lastHeartbeat: null,
                activeSessionCount: 0
            };
        }

        const now = Date.now();
        const heartbeats = activeClients.map((c) => c.lastHeartbeat || c.connectedAt).filter(Boolean);
        const latencySamples = activeClients.map((c) => c.lastRtt).filter(Number.isFinite);
        const maxLatency = latencySamples.length ? Math.max(...latencySamples) : null;
        const anyStream = activeClients.some((c) => c.subscribedToScreen);
        const stale = activeClients.some((c) => c.lastHeartbeat && now - c.lastHeartbeat > 15000);

        return {
            connectionState: stale ? 'stale' : 'connected',
            streamHealth: anyStream ? 'streaming' : 'idle',
            latencyMs: maxLatency,
            lastHeartbeat: heartbeats.length ? Math.max(...heartbeats) : null,
            activeSessionCount: activeClients.length
        };
    }

    getStatus() {
        return {
            port: this.port,
            connectedClients: Array.from(this.clients.values()).filter((c) => c.authenticated).length,
            uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
            capabilities: this.getCapabilities(),
            device: this.getDeviceInfo(),
            transferStats: this.fileTransfer.getStats(),
            sessions: this.getSessionList(),
            connectionQuality: this.getConnectionQuality()
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

    broadcastSessionState() {
        const payload = {
            type: 'session_update',
            sessions: this.getSessionList(),
            connectionQuality: this.getConnectionQuality()
        };
        this.broadcast(payload, true);
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
        if (!data || typeof data.gesture !== 'string') {
            this.sendError(ws, 'gesture requires a string gesture name', 'BAD_ARGS');
            return;
        }
        const gesture = data.gesture.trim();
        try {
            switch (gesture) {
                case 'leftClick':
                    robot.mouseClick('left', false);
                    break;
                case 'rightClick':
                    robot.mouseClick('right', false);
                    break;
                case 'doubleClick':
                    robot.mouseClick('left', true);
                    break;
                case 'scrollUp':
                    robot.scrollMouse(0, -1);
                    break;
                case 'scrollDown':
                    robot.scrollMouse(0, 1);
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
                    this.sendError(ws, `Unknown gesture: ${gesture}`, 'UNKNOWN_GESTURE');
                    return;
            }
            this.recordActivity('gesture', `Gesture: ${gesture}`);
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
        if (typeof data.text === 'string') {
            if (data.text.length === 0) return;
            if (data.text.length > 4096) {
                this.sendError(ws, 'keyboard text exceeds the 4096-character limit', 'BAD_ARGS');
                return;
            }
            try {
                robot.typeString(data.text);
            } catch (error) {
                console.error('❌ Error handling keyboard text:', error.message);
                this.sendError(ws, 'Failed to send text', 'ROBOT_ERROR');
            }
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
        const client = this.clients.get(ws);
        if (!client) return;
        const fps = data.fps === undefined ? client.screenFps : data.fps;
        if (typeof fps !== 'number' || !Number.isInteger(fps) || fps < SCREEN_MIN_FPS || fps > SCREEN_MAX_FPS) {
            this.sendError(ws, `fps must be an integer between ${SCREEN_MIN_FPS} and ${SCREEN_MAX_FPS}`, 'BAD_ARGS');
            return;
        }
        if (!screenshot) {
            this.sendError(ws, 'Screen capture unavailable on this server', 'SCREENSHOT_UNAVAILABLE');
            return;
        }
        client.subscribedToScreen = true;
        client.screenFps = fps;
        this.updateScreenCaptureLoop();
    }

    handleScreenConfig(ws, data) {
        const client = this.clients.get(ws);
        if (!client || !client.authenticated) {
            this.sendError(ws, 'Not authenticated', 'UNAUTHENTICATED');
            return;
        }
        if (!data || typeof data.quality !== 'string' ||
            !Object.prototype.hasOwnProperty.call(SCREEN_PROFILE_DEFAULT_FPS, data.quality)) {
            this.sendError(ws, 'quality must be LOW, BALANCED, or HIGH', 'BAD_ARGS');
            return;
        }
        if (typeof data.fps !== 'number' || !Number.isInteger(data.fps) || !SCREEN_CONFIG_FPS.has(data.fps)) {
            this.sendError(ws, 'fps must be one of 3, 6, 10, 15, 20, or 30', 'BAD_ARGS');
            return;
        }

        client.screenQuality = data.quality;
        client.screenFps = data.fps;
        if (client.subscribedToScreen) this.updateScreenCaptureLoop();
        this.send(ws, {
            type: 'screen_configured',
            quality: client.screenQuality,
            targetFps: client.screenFps,
            streamActive: client.subscribedToScreen
        });
        this.broadcastSessionState();
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
        const generation = ++this.screenCaptureGeneration;
        const subscribers = Array.from(this.clients.values()).filter((c) => c.authenticated && c.subscribedToScreen);

        if (subscribers.length === 0) {
            if (this.screenCaptureTimer) {
                clearInterval(this.screenCaptureTimer);
                this.screenCaptureTimer = null;
            }
            this.lastFrameSentAt = 0;
            return;
        }

        const targetFps = Math.max(...subscribers.map((c) => c.screenFps));
        const intervalMs = Math.round(1000 / targetFps);

        if (this.screenCaptureTimer) {
            clearInterval(this.screenCaptureTimer);
        }
        this.lastFrameSentAt = 0;

        this.screenCaptureTimer = setInterval(async () => {
            if (generation !== this.screenCaptureGeneration || this.screenCaptureInProgress) return;
            this.screenCaptureInProgress = true;
            const captureStart = Date.now();
            try {
                const buffer = await screenshot({ format: 'jpg' });
                if (generation !== this.screenCaptureGeneration) return;
                const now = Date.now();
                this.screenFrameSeq += 1;

                const frame = {
                    type: 'screen_frame',
                    seq: this.screenFrameSeq,
                    format: 'jpeg',
                    data: buffer.toString('base64'),
                    capturedAt: now,
                    captureMs: now - captureStart,
                    fps: this.lastFrameSentAt
                        ? Math.round((1000 / (now - this.lastFrameSentAt)) * 10) / 10
                        : null
                };
                const message = JSON.stringify(frame);
                if (generation !== this.screenCaptureGeneration) return;
                for (const [cws, c] of this.clients) {
                    if (c.authenticated && c.subscribedToScreen && cws.readyState === WebSocket.OPEN) {
                        cws.send(message);
                    }
                }
                this.lastFrameSentAt = Date.now();
            } catch (error) {
                if (generation === this.screenCaptureGeneration) {
                    this.broadcast({ type: 'screen_error', message: error.message }, true);
                }
            } finally {
                this.screenCaptureInProgress = false;
            }
        }, intervalMs);
    }
    // ----------------------------------------------------------- sessions

    handleSessionList(ws) {
        if (!this.clients.has(ws)) return;
        const client = this.clients.get(ws);
        if (!client.authenticated) {
            this.sendError(ws, 'Not authenticated', 'UNAUTHENTICATED');
            return;
        }
        this.send(ws, {
            type: 'session_list',
            sessions: this.getSessionList(),
            connectionQuality: this.getConnectionQuality()
        });
    }

    handleSessionManage(ws, data) {
        const client = this.clients.get(ws);
        if (!client || !client.authenticated) {
            this.sendError(ws, 'Not authenticated', 'UNAUTHENTICATED');
            return;
        }
        if (client.id !== this.hostClientId) {
            this.sendError(ws, 'Only the host session can manage sessions', 'HOST_ONLY');
            return;
        }
        if (!data || typeof data.sessionId !== 'string') {
            this.sendError(ws, 'session_manage requires a sessionId', 'BAD_ARGS');
            return;
        }
        if (!['disconnect', 'revoke'].includes(data.action)) {
            this.sendError(ws, 'session_manage action must be disconnect or revoke', 'BAD_ARGS');
            return;
        }

        let target = null;
        for (const [candidateWs, candidate] of this.clients) {
            if (candidate.id === data.sessionId) {
                target = candidateWs;
                break;
            }
        }

        if (!target) {
            this.sendError(ws, `Session not found: ${data.sessionId}`, 'SESSION_NOT_FOUND');
            return;
        }

        const action = data.action;
        const targetClient = this.clients.get(target);
        if (!targetClient) {
            this.sendError(ws, `Session not found: ${data.sessionId}`, 'SESSION_NOT_FOUND');
            return;
        }

        if (targetClient.id === client.id && action === 'disconnect') {
            this.sendError(ws, 'You cannot disconnect your own current session from this action.', 'SELF_DISCONNECT_FORBIDDEN');
            return;
        }

        this.send(target, {
            type: 'session_terminated',
            action,
            message: action === 'revoke' ? 'Your session was revoked by the host.' : 'Your session was disconnected by the host.'
        });
        targetClient.authenticated = false;
        targetClient.subscribedToScreen = false;
        this.cancelClientTransfers(targetClient.id);
        this.updateScreenCaptureLoop();
        target.close();
        this.recordActivity('connection', `Session ${action}d: ${targetClient.id} (${targetClient.ip})`);
    }

    handleEmergencyStop(ws, data) {
        const client = this.clients.get(ws);
        if (!client || !client.authenticated) {
            this.sendError(ws, 'Not authenticated', 'UNAUTHENTICATED');
            return;
        }
        if (client.id !== this.hostClientId) {
            this.sendError(ws, 'Only the host session can trigger emergency stop', 'HOST_ONLY');
            return;
        }
        if (!data || data.confirm !== true) {
            this.sendError(ws, 'Emergency stop requires explicit confirmation', 'EMERGENCY_STOP_REQUIRED');
            return;
        }

        this.recordActivity('system', `Emergency stop triggered by ${client.id}`);

        for (const [candidateWs, candidate] of this.clients) {
            this.cancelClientTransfers(candidate.id);
            candidate.authenticated = false;
            candidate.subscribedToScreen = false;
            candidate.screenFps = SCREEN_DEFAULT_FPS;
            candidate.sessionState = 'stopped';
            if (candidateWs.readyState === WebSocket.OPEN) {
                candidateWs.send(JSON.stringify({
                    type: 'emergency_stop',
                    message: 'Emergency stop triggered. Remote control has been stopped.'
                }));
            }
        }
        this.hostClientId = null;
        this.updateScreenCaptureLoop();

        this.send(ws, { type: 'emergency_stop_ack', message: 'Emergency stop complete. Server remains running.' });
        const sessionIds = Array.from(this.clients.keys());
        for (const candidateWs of sessionIds) {
            if (candidateWs.readyState === WebSocket.OPEN) {
                candidateWs.close();
            }
        }

        this.broadcastSessionState();
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
            this.send(ws, {
                type: 'upload_started',
                transferId: result.transferId,
                filename: result.filename,
                totalBytes: result.totalBytes,
                startedAt: result.startedAt,
                chunkSize: result.chunkSize
            });
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
            // The manager broadcasts progress (including the final 100%) itself,
            // before the completion event. Re-sending the reply here would put a
            // stale progress update after `transfer_completed` on the wire, so a
            // finished transfer would appear to move backwards. Only transfers
            // that are still running get the extra acknowledgement.
            if (this.fileTransfer.activeTransfers.has(data.transferId)) {
                this.send(ws, { type: 'upload_progress', transferId: data.transferId, ...result });
            }
        } catch (error) {
            this.send(ws, { type: 'upload_error', message: error.message, transferId: data.transferId });
        }
    }

    handleTransferCancel(ws, data) {
        const client = this.clients.get(ws);
        const transfer = data && typeof data.transferId === 'string'
            ? this.fileTransfer.activeTransfers.get(data.transferId)
            : null;
        if (!client || !transfer || transfer.clientId !== client.id) {
            this.sendError(ws, 'Transfer not found or not owned by this session', 'TRANSFER_NOT_FOUND');
            return;
        }
        try {
            this.fileTransfer.cancelTransfer(data.transferId, client.id);
        } catch (error) {
            this.sendError(ws, error.message, 'TRANSFER_ERROR');
        }
    }

    // Transfer events are public to authenticated clients. Never include
    // filesystem paths, chunk buffers, or other internal fields.
    publicTransferEvent(evt) {
        if (!evt || typeof evt !== 'object') return {};
        const {
            filePath, chunks, dir, originalFilename, ...safe
        } = evt;
        return safe;
    }

    broadcastTransferProgress(evt) {
        this.broadcast({ type: 'transfer_progress', ...this.publicTransferEvent(evt) }, true);
    }

    broadcastTransferCompleted(evt) {
        this.broadcast({ type: 'transfer_completed', ...this.publicTransferEvent(evt) }, true);
        this.recordActivity('file', `${evt.direction === 'download' ? 'Download' : 'Upload'} completed: ${evt.filename}`);
    }

    broadcastTransferFailed(evt) {
        this.broadcast({ type: 'transfer_failed', ...this.publicTransferEvent(evt) }, true);
        this.recordActivity('file', `Transfer failed: ${evt.filename}`);
    }

    broadcastTransferCancelled(evt) {
        this.broadcast({ type: 'transfer_cancelled', ...this.publicTransferEvent(evt) }, true);
        this.recordActivity('file', `Transfer cancelled: ${evt.filename}`);
    }

    // ------------------------------------------------------- file download

    handleListFiles(ws) {
        this.send(ws, {
            type: 'file_list',
            outgoing: this.fileTransfer.listAvailableFiles(),
            incoming: this.fileTransfer.listUploadedFiles(),
            shared: this.fileTransfer.listSharedFiles()
        });
    }

    // Metadata only. No absolute path, server path, or directory layout is ever
    // included: a client learns a bare name, a logical location, and a size.
    handleListSharedFiles(ws) {
        this.send(ws, {
            type: 'shared_file_list',
            shared: this.fileTransfer.listSharedFiles(),
            locations: this.fileTransfer.getSharedLocations()
                .map((location) => ({ id: location.id, label: location.label }))
        });
    }

    async handleDownloadStart(ws, data) {
        const client = this.clients.get(ws);
        try {
            if (typeof data.filename !== 'string') {
                this.sendError(ws, 'download_start requires filename', 'BAD_ARGS');
                return;
            }
            const result = await this.fileTransfer.startDownload(data.filename, client.id, {
                location: data.location,
                preview: data.preview === true
            });
            this.send(ws, {
                type: 'download_started',
                transferId: result.transferId,
                fileSize: result.fileSize,
                totalBytes: result.totalBytes,
                startedAt: result.startedAt,
                chunkSize: result.chunkSize,
                filename: result.filename,
                mimeType: result.mimeType,
                location: result.location,
                preview: result.preview
            });
        } catch (error) {
            this.send(ws, { type: 'download_error', message: error.message, filename: data.filename, preview: data.preview === true });
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
                progress: chunk.progress,
                bytesTransferred: chunk.bytesTransferred,
                totalBytes: chunk.totalBytes,
                speedBps: chunk.speedBps,
                etaSeconds: chunk.etaSeconds,
                startedAt: chunk.startedAt
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
            if (data.confirm !== true) {
                this.sendError(ws, 'Delete requires confirmation', 'DELETE_CONFIRM_REQUIRED');
                return;
            }
            // `location` is the shared-files identifier; `direction` is the
            // legacy field and is still accepted.
            const location = typeof data.location === 'string'
                ? data.location
                : (data.direction === 'outgoing' ? 'from-laptop' : 'from-phone');
            const result = this.fileTransfer.deleteFile(data.filename, location);
            this.send(ws, { type: 'file_deleted', filename: result.name, location, direction: result.location });
            this.recordActivity('file', `Deleted shared file: ${result.name}`);
        } catch (error) {
            this.sendError(ws, error.message, 'DELETE_ERROR');
        }
    }

    // ------------------------------------------------------------ clipboard

    handleClipboardPush(ws, data) {
        const MAX_CLIPBOARD_SIZE = 50000; // 50KB limit
        
        // Validate input
        if (typeof data.text !== 'string') {
            this.sendError(ws, 'clipboard_push requires text string', 'BAD_ARGS');
            return;
        }
        
        if (data.text.length > MAX_CLIPBOARD_SIZE) {
            this.sendError(ws, `Clipboard text too large (max ${MAX_CLIPBOARD_SIZE} chars)`, 'CLIPBOARD_TOO_LARGE');
            return;
        }
        
        // Broadcast to all other authenticated clients (excluding sender)
        for (const [clientWs, client] of this.clients.entries()) {
            if (clientWs !== ws && client.authenticated) {
                this.send(clientWs, { type: 'clipboard_pull', text: data.text });
            }
        }
        
        this.recordActivity('clipboard', `Clipboard synced (${data.text.length} chars)`);
    }

    // ------------------------------------------------------------ screenshot

    async handleScreenshotCapture(ws) {
        if (!screenshot) {
            this.sendError(ws, 'Screenshot capture unavailable on this server', 'SCREENSHOT_UNAVAILABLE');
            return;
        }
        
        try {
            // Capture screenshot
            const buffer = await screenshot({ format: 'png' });
            
            // Generate filename with timestamp
            const timestamp = Date.now();
            const filename = `screenshot-${timestamp}.png`;
            const filepath = path.join(this.fileTransferPath, 'incoming', filename);
            
            // Save screenshot
            fs.writeFileSync(filepath, buffer);
            
            // Notify client
            this.send(ws, {
                type: 'screenshot_saved',
                filename,
                size: buffer.length,
                timestamp
            });
            
            this.recordActivity('screenshot', `Screenshot captured: ${filename} (${this.formatFileSize(buffer.length)})`);
            
            console.log(`📸 Screenshot saved: ${filename}`);
        } catch (error) {
            console.error('Screenshot capture failed:', error.message);
            this.sendError(ws, `Screenshot capture failed: ${error.message}`, 'SCREENSHOT_ERROR');
        }
    }

    // ------------------------------------------------------------ recording

    handleRecordingStart(ws) {
        const client = this.clients.get(ws);
        if (!client) return;
        
        if (!screenshot) {
            this.sendError(ws, 'Recording unavailable - screenshot capability not available', 'RECORDING_UNAVAILABLE');
            return;
        }
        
        // Check if already recording
        if (this.recordings.has(client.id)) {
            this.sendError(ws, 'Recording already in progress', 'RECORDING_ACTIVE');
            return;
        }
        
        const MAX_FRAMES = 60; // Max 60 frames (1 frame/sec for 60 seconds)
        const FRAME_INTERVAL = 1000; // 1 second between frames
        
        const recording = {
            frames: [],
            startTime: Date.now(),
            intervalId: null,
            frameCount: 0
        };
        
        this.recordings.set(client.id, recording);
        
        // Capture frames at interval
        recording.intervalId = setInterval(async () => {
            try {
                if (!this.recordings.has(client.id)) {
                    clearInterval(recording.intervalId);
                    return;
                }
                
                const buffer = await screenshot({ format: 'png' });
                recording.frames.push(buffer);
                recording.frameCount++;
                
                // Auto-stop at max frames
                if (recording.frameCount >= MAX_FRAMES) {
                    this.handleRecordingStop(ws);
                }
            } catch (error) {
                console.error('Recording frame capture failed:', error.message);
                this.handleRecordingStop(ws);
                this.sendError(ws, 'Recording failed', 'RECORDING_ERROR');
            }
        }, FRAME_INTERVAL);
        
        this.recordActivity('recording', `Screen recording started by ${client.id}`);
        console.log(`🎥 Recording started for client ${client.id}`);
    }

    async handleRecordingStop(ws) {
        const client = this.clients.get(ws);
        if (!client) return;
        
        const recording = this.recordings.get(client.id);
        if (!recording) {
            this.sendError(ws, 'No active recording', 'NO_RECORDING');
            return;
        }
        
        // Stop capturing
        if (recording.intervalId) {
            clearInterval(recording.intervalId);
        }
        
        this.recordings.delete(client.id);
        
        if (recording.frames.length === 0) {
            this.sendError(ws, 'Recording has no frames', 'RECORDING_EMPTY');
            return;
        }
        
        try {
            // Save frames as individual images in a timestamped directory
            const timestamp = Date.now();
            const dirname = `recording-${timestamp}`;
            const dirpath = path.join(this.fileTransferPath, 'incoming', dirname);
            
            fs.mkdirSync(dirpath, { recursive: true });
            
            // Save each frame
            for (let i = 0; i < recording.frames.length; i++) {
                const framePath = path.join(dirpath, `frame-${i.toString().padStart(3, '0')}.png`);
                fs.writeFileSync(framePath, recording.frames[i]);
            }
            
            // Create a simple metadata file
            const metadata = {
                frameCount: recording.frames.length,
                duration: Date.now() - recording.startTime,
                fps: 1,
                timestamp
            };
            
            fs.writeFileSync(
                path.join(dirpath, 'metadata.json'),
                JSON.stringify(metadata, null, 2)
            );
            
            const totalSize = recording.frames.reduce((sum, frame) => sum + frame.length, 0);
            
            // Notify client
            this.send(ws, {
                type: 'recording_saved',
                filename: dirname,
                frameCount: recording.frames.length,
                size: totalSize,
                duration: metadata.duration
            });
            
            this.recordActivity('recording', `Recording saved: ${dirname} (${recording.frames.length} frames, ${this.formatFileSize(totalSize)})`);
            
            console.log(`🎥 Recording saved: ${dirname} (${recording.frames.length} frames)`);
        } catch (error) {
            console.error('Recording save failed:', error.message);
            this.sendError(ws, `Recording save failed: ${error.message}`, 'RECORDING_SAVE_ERROR');
        }
    }

    // ------------------------------------------------------------ audio

    handleAudioEnable(ws) {
        const client = this.clients.get(ws);
        if (!client) return;
        
        // Check if audio capability is available
        const capabilities = this.getCapabilities();
        if (!capabilities.audio) {
            this.sendError(ws, 'Audio streaming not available on this server', 'AUDIO_UNAVAILABLE');
            return;
        }
        
        this.audioClients.add(client.id);
        this.recordActivity('audio', `Audio streaming enabled for ${client.id}`);
        console.log(`🔊 Audio streaming enabled for client ${client.id}`);
        
        // In a real implementation, this would start capturing system audio
        // For now, we just acknowledge the capability
        this.send(ws, {
            type: 'audio_status',
            enabled: true,
            format: 'pcm',
            sampleRate: 44100,
            channels: 2
        });
    }

    handleAudioDisable(ws) {
        const client = this.clients.get(ws);
        if (!client) return;
        
        this.audioClients.delete(client.id);
        this.recordActivity('audio', `Audio streaming disabled for ${client.id}`);
        console.log(`🔇 Audio streaming disabled for client ${client.id}`);
    }

    // ---------------------------------------------------------- media control

    handleMediaControl(ws, action) {
        const client = this.clients.get(ws);
        if (!client) return;
        
        // Check if media control capability is available
        const capabilities = this.getCapabilities();
        if (!capabilities.media) {
            this.sendError(ws, 'Media control not available on this server', 'MEDIA_UNAVAILABLE');
            return;
        }
        
        // Validate action
        const validActions = ['play', 'pause', 'playpause', 'stop', 'next', 'previous'];
        if (!validActions.includes(action)) {
            this.sendError(ws, `Invalid media action: ${action}`, 'INVALID_ACTION');
            return;
        }
        
        this.recordActivity('media', `Media control: ${action} by ${client.id}`);
        console.log(`🎵 Media control: ${action} by client ${client.id}`);
        
        // In a real implementation, this would control Windows media
        // using Windows Media Control API or similar
        // For now, acknowledge the command
        this.send(ws, {
            type: 'media_info',
            action: action,
            success: true
        });
    }

    // ------------------------------------------------------------ lifecycle

    regenerateAuthCode() {
        this.authCode = this.generateAuthCode();
        console.log(`🔐 New authentication code: ${this.authCode}`);
        return this.authCode;
    }

    shutdown() {
        console.log('🛑 Shutting down Dexile server...');
        this.screenCaptureGeneration += 1;
        if (this.screenCaptureTimer) {
            clearInterval(this.screenCaptureTimer);
            this.screenCaptureTimer = null;
        }
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
        this.wss.close();
        this.httpServer.close(() => {
            if (this.isCliServer) process.exit(0);
        });
        if (this.isCliServer) setTimeout(() => process.exit(0), 1000).unref();
    }
}

// ============================================================== CLI runner

if (require.main === module) {
    const args = process.argv.slice(2);
    const port = args[0] ? parseInt(args[0], 10) : 3000;

    const server = new DexileServer(port);
    server.isCliServer = true;

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
}

module.exports = DexileServer;
