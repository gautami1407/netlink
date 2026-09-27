const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { EventEmitter } = require('events');

// Windows' known-folder GUID for Downloads, read from the registry so a
// Downloads folder that has been moved (for example into OneDrive) is still
// found. Falls back to the conventional location when the registry is absent.
const DOWNLOADS_KNOWN_FOLDER_GUID = '{374DE290-123F-4565-9164-39C4925E467B}';

function resolveDownloadsFolder() {
    if (process.platform === 'win32') {
        try {
            const output = execFileSync(
                'reg.exe',
                ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
                    '/v', DOWNLOADS_KNOWN_FOLDER_GUID],
                { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
            );
            const match = /REG_(?:EXPAND_)?SZ\s+\S+\s+(.+)$/m.exec(output);
            if (match) {
                // REG_EXPAND_SZ values may reference %USERPROFILE% and friends.
                const raw = match[1].trim();
                const expanded = raw.replace(/%([^%]+)%/g, (whole, name) => process.env[name] || whole);
                if (expanded) return expanded;
            }
        } catch (error) {
            // No registry access (sandbox, non-Windows, restricted user).
        }
    }
    // os.homedir() resolves the current user without ever naming one, so this
    // works for any Windows account and for the other platforms too.
    const candidates = [];
    if (process.env.USERPROFILE) candidates.push(path.join(process.env.USERPROFILE, 'Downloads'));
    if (os.homedir()) candidates.push(path.join(os.homedir(), 'Downloads'));
    for (const candidate of candidates) {
        try {
            if (fs.statSync(candidate).isDirectory()) return candidate;
        } catch (error) { /* try the next candidate */ }
    }
    return candidates[0] || null;
}

// The wire chunk size, agreed once and shared by the upload and download
// paths. It was previously repeated as a literal in three places, which made
// it easy for the two directions to drift apart.
const UPLOAD_CHUNK_SIZE = 64 * 1024;

// Determined here on the server from the file extension. The client never
// supplies a content type, and anything unrecognised becomes
// application/octet-stream so the browser downloads it instead of trying to
// render it.
const MIME_TYPES = Object.freeze({
    '.pdf': 'application/pdf',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml', '.avif': 'image/avif', '.heic': 'image/heic',
    '.txt': 'text/plain', '.log': 'text/plain', '.md': 'text/markdown',
    '.csv': 'text/csv', '.json': 'application/json', '.xml': 'application/xml',
    '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
    '.ogg': 'audio/ogg', '.flac': 'audio/flac',
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
    '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska',
    '.zip': 'application/zip', '.rar': 'application/vnd.rar',
    '.7z': 'application/x-7z-compressed', '.tar': 'application/x-tar', '.gz': 'application/gzip',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
});

class FileTransferManager extends EventEmitter {
    constructor(basePath = './transfers', options = {}) {
        super();
        this.basePath = basePath;
        // Where a completed phone upload is finally stored. Resolved from the
        // operating system, never from the client, and injectable for tests.
        this.downloadsPath = options.downloadsPath || null;
        this.receivedManifestPath = options.receivedManifestPath || path.join(basePath, 'received.json');
        this.receivedFiles = this.loadReceivedManifest();
        this.activeTransfers = new Map();
        this.transferHistory = [];
        this.maxTransferHistory = 500;
        this.maxFileSize = 100 * 1024 * 1024; // 100MB limit
        this.maxPreviewSize = 25 * 1024 * 1024; // previews reuse the download protocol; keep them bounded
        this.allowedExtensions = [
            '.txt', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
            '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.svg',
            '.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac',
            '.zip', '.rar', '.7z', '.tar', '.gz',
            '.js', '.html', '.css', '.json', '.xml', '.csv'
        ];

        this.initializeDirectories();
    }

    // ------------------------------------------------------- upload delivery
    getDownloadsPath() {
        if (!this.downloadsPath) this.downloadsPath = resolveDownloadsFolder();
        return this.downloadsPath;
    }

    // A small record of the files Dexile itself delivered to Downloads. It
    // holds no file data, only names, and it is what keeps Shared Files
    // showing exactly what the phone sent rather than the user's whole
    // Downloads folder.
    loadReceivedManifest() {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.receivedManifestPath, 'utf8'));
            return Array.isArray(parsed) ? parsed.filter((entry) => entry && typeof entry.name === 'string') : [];
        } catch (error) {
            return [];
        }
    }

    // Writes the manifest so that it is either fully replaced or left exactly
    // as it was. A plain writeFileSync truncates first, so a process killed
    // part-way through (a crash, or the server being restarted) leaves invalid
    // JSON behind, and loadReceivedManifest then discards the whole file: every
    // previously delivered file would silently vanish from Shared Files. Writing
    // to a sibling temporary file and renaming over the target is atomic, so
    // the manifest is never observed half-written.
    writeReceivedManifest() {
        const entries = this.receivedFiles.slice(-500);
        const tempPath = `${this.receivedManifestPath}.${process.pid}.tmp`;
        try {
            fs.writeFileSync(tempPath, JSON.stringify(entries, null, 2));
            fs.renameSync(tempPath, this.receivedManifestPath);
        } catch (error) {
            console.error('❌ Could not record received file:', error.message);
            try { fs.unlinkSync(tempPath); } catch (cleanupError) { /* best effort */ }
        }
    }

    rememberReceivedFile(name, size) {
        this.receivedFiles = this.receivedFiles.filter((entry) => entry.name !== name);
        // The size is recorded alongside the name because a name on its own
        // cannot tell a delivered file apart from a different file that later
        // takes the same name. Entries written before this was recorded carry
        // no size and are still honoured.
        const entry = { name, receivedAt: new Date().toISOString() };
        if (Number.isFinite(size)) entry.size = size;
        this.receivedFiles.push(entry);
        this.writeReceivedManifest();
    }

    forgetReceivedFile(name) {
        this.receivedFiles = this.receivedFiles.filter((entry) => entry.name !== name);
        this.writeReceivedManifest();
    }

    // A record still matches the file it was written for only while that file
    // is present and, when the record carries one, the same size. A file the
    // user removed and then replaced with something of their own is no longer
    // the file Dexile delivered, so it stops being treated as such.
    receivedFileStillMatches(entry, downloadsDir) {
        const filePath = path.join(downloadsDir, entry.name);
        if (path.dirname(path.resolve(filePath)) !== path.resolve(downloadsDir)) return false;
        let stats;
        try {
            stats = fs.statSync(filePath);
        } catch (error) {
            return false;
        }
        if (!stats.isFile()) return false;
        return !Number.isFinite(entry.size) || stats.size === entry.size;
    }

    // Drops records whose file is gone, or has been replaced by a different
    // one. The user is free to delete a delivered file outside Dexile; without
    // this, a name freed that way could be taken by one of the user's own
    // downloads, which would then be listed and served as though Dexile had
    // delivered it. It also keeps the manifest from growing without bound.
    pruneMissingReceivedFiles() {
        const downloadsDir = this.getDownloadsPath();
        if (!downloadsDir || this.receivedFiles.length === 0) return;
        const present = this.receivedFiles.filter((entry) => this.receivedFileStillMatches(entry, downloadsDir));
        if (present.length === this.receivedFiles.length) return;
        this.receivedFiles = present;
        this.writeReceivedManifest();
    }

    // Never overwrites something already in Downloads. photo.jpg becomes
    // photo (1).jpg, then photo (2).jpg, and so on.
    resolveAvailablePath(dir, name) {
        const extension = path.extname(name);
        const stem = name.slice(0, name.length - extension.length);
        const resolvedDir = path.resolve(dir);
        let candidate = path.join(resolvedDir, name);
        let counter = 0;
        while (fs.existsSync(candidate)) {
            counter += 1;
            candidate = path.join(resolvedDir, `${stem} (${counter})${extension}`);
        }
        // Belt and braces: whatever the platform, the result must be a direct
        // child of the Downloads folder.
        if (path.dirname(path.resolve(candidate)) !== resolvedDir) {
            throw new Error('Invalid filename');
        }
        return { filePath: candidate, filename: path.basename(candidate) };
    }

    // ---------------------------------------------------------- shared files
    // The client never learns a filesystem path. It only ever names a plain
    // file and one of two logical locations, which the server maps onto the
    // two approved directories underneath the Dexile transfer root.
    getSharedLocations() {
        return [
            { id: 'from-laptop', label: 'From Laptop', dir: 'outgoing' },
            { id: 'from-phone', label: 'From Phone', dir: 'incoming' }
        ];
    }

    resolveLocationDir(location) {
        const match = this.getSharedLocations().find((entry) => entry.id === location);
        if (match) return match.dir;
        // The legacy protocol only ever sent a direction.
        if (location === 'outgoing' || location === 'incoming') return location;
        return null;
    }

    // A shared file is addressed by a bare name. Anything that looks like a
    // path — separators, traversal, a drive letter, a UNC prefix, a NUL, or a
    // control character — is rejected outright rather than sanitised, so a
    // caller can never steer a read or a delete outside the approved roots.
    looksLikeEncodedPath(filename) {
        if (!/%[0-9a-f]{2}/i.test(filename)) return false;
        if (/%(?:2e|2f|5c|00)/i.test(filename)) return true;
        let current = filename;
        for (let i = 0; i < 4; i++) {
            let decoded;
            try {
                decoded = decodeURIComponent(current);
            } catch (error) {
                return true;
            }
            if (decoded === current) break;
            if (/[\u0000-\u001f\u007f]/.test(decoded)) return true;
            if (decoded.includes('..') || decoded.includes('/') || decoded.includes('\\')) return true;
            if (/^[a-zA-Z]:/.test(decoded) || decoded.startsWith('~')) return true;
            current = decoded;
        }
        return false;
    }

    assertSharedFileName(filename) {
        if (typeof filename !== 'string' || !filename.length) {
            throw new Error('Invalid filename');
        }
        if (filename.length > 255) {
            throw new Error('Invalid filename');
        }
        if (/[\u0000-\u001f\u007f]/.test(filename)) {
            throw new Error('Invalid filename');
        }
        if (filename === '.' || filename === '..' || filename.includes('..')) {
            throw new Error('Invalid filename');
        }
        if (filename.includes('/') || filename.includes('\\')) {
            throw new Error('Invalid filename');
        }
        if (filename.startsWith('~')) {
            throw new Error('Invalid filename');
        }
        if (/^[a-zA-Z]:/.test(filename)) {
            throw new Error('Invalid filename');
        }
        if (this.looksLikeEncodedPath(filename)) {
            throw new Error('Invalid filename');
        }
        if (path.basename(filename) !== filename || path.dirname(filename) !== '.') {
            throw new Error('Invalid filename');
        }
        return filename;
    }

    getMimeType(filename) {
        const ext = path.extname(String(filename || '')).toLowerCase();
        return Object.prototype.hasOwnProperty.call(MIME_TYPES, ext) ? MIME_TYPES[ext] : 'application/octet-stream';
    }

    isPreviewableMime(type) {
        if (typeof type !== 'string' || !type) return false;
        if (type === 'image/svg+xml' || type === 'text/html' || type === 'text/javascript' || type === 'text/css') {
            return false;
        }
        if (type.startsWith('image/')) return true;
        if (type.startsWith('video/')) return true;
        if (type.startsWith('audio/')) return true;
        if (type === 'application/pdf') return true;
        if (type === 'text/plain' || type === 'text/markdown' || type === 'text/csv') return true;
        if (type === 'application/json' || type === 'application/xml' || type === 'text/xml') return true;
        return false;
    }

    // Resolves a logical location + bare name onto a real path. The result is
    // internal only and is never placed in anything sent to a client.
    resolveSharedFile(filename, location, { required = true } = {}) {
        const safeName = this.assertSharedFileName(filename);
        const dirName = this.resolveLocationDir(location);
        if (!dirName) {
            throw new Error('Unknown shared location');
        }
        const dir = path.join(this.basePath, dirName);
        const filePath = path.join(dir, safeName);
        // Belt and braces: even though the name is already a bare filename,
        // confirm the resolved path really is a direct child of the root.
        if (path.dirname(filePath) !== dir) {
            throw new Error('Invalid filename');
        }
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            return { name: safeName, filePath, dir, location: location };
        }
        if (required === false) return { name: safeName, filePath, dir, location };
        // A phone upload is delivered to Downloads, so it is addressed there.
        if (dirName === 'incoming') {
            const delivered = this.resolveDeliveredFile(safeName);
            if (delivered) return delivered;
        }
        throw new Error('File not found');
    }

    // Only names Dexile itself delivered are reachable. The rest of the user's
    // Downloads folder is never listed, addressed, or exposed.
    resolveDeliveredFile(name) {
        const downloadsDir = this.getDownloadsPath();
        if (!downloadsDir) return null;
        const entry = this.receivedFiles.find((candidate) => candidate.name === name);
        if (!entry) return null;
        if (!this.receivedFileStillMatches(entry, downloadsDir)) return null;
        return { name, filePath: path.join(downloadsDir, name), dir: downloadsDir, location: 'from-phone' };
    }

    listSharedFiles() {
        const results = [];
        // Self-heal the manifest before anything is served from it.
        this.pruneMissingReceivedFiles();
        for (const location of this.getSharedLocations()) {
            const dir = path.join(this.basePath, location.dir);
            let names = [];
            try {
                names = fs.readdirSync(dir);
            } catch (error) {
                continue;
            }
            for (const name of names) {
                let stats;
                try {
                    stats = fs.statSync(path.join(dir, name));
                } catch (error) {
                    continue;
                }
                if (!stats.isFile()) continue;
                let safeName;
                try {
                    safeName = this.assertSharedFileName(name);
                } catch (error) {
                    // A file the client is not allowed to address by name is
                    // simply not listed, rather than listed and then rejected.
                    continue;
                }
                const mime = this.getMimeType(safeName);
                results.push({
                    name: safeName,
                    size: stats.size,
                    formattedSize: this.formatFileSize(stats.size),
                    type: mime,
                    extension: path.extname(safeName).toLowerCase(),
                    modifiedAt: stats.mtime.toISOString(),
                    location: location.id,
                    locationLabel: location.label,
                    previewable: this.isPreviewableMime(mime) && stats.size <= this.maxPreviewSize
                });
            }
        }

        // Phone uploads are delivered into the user's Downloads folder, so
        // they are listed from there. Only names Dexile recorded as delivered
        // are included, so the rest of the user's Downloads folder is never
        // revealed to a connected device.
        const downloadsDir = this.getDownloadsPath();
        if (downloadsDir) {
            const alreadyListed = new Set(
                results.filter((file) => file.location === 'from-phone').map((file) => file.name)
            );
            const phoneLocation = this.getSharedLocations().find((entry) => entry.id === 'from-phone');
            for (const entry of this.receivedFiles) {
                if (alreadyListed.has(entry.name)) continue;
                let safeName;
                try {
                    safeName = this.assertSharedFileName(entry.name);
                } catch (error) {
                    continue;
                }
                let stats;
                try {
                    stats = fs.statSync(path.join(downloadsDir, safeName));
                } catch (error) {
                    continue;
                }
                if (!stats.isFile()) continue;
                results.push({
                    name: safeName,
                    size: stats.size,
                    formattedSize: this.formatFileSize(stats.size),
                    type: this.getMimeType(safeName),
                    extension: path.extname(safeName).toLowerCase(),
                    modifiedAt: stats.mtime.toISOString(),
                    location: phoneLocation.id,
                    locationLabel: phoneLocation.label
                });
            }
        }

        return results;
    }

    initializeDirectories() {
        // Create necessary directories
        const directories = [
            this.basePath,
            path.join(this.basePath, 'incoming'),
            path.join(this.basePath, 'outgoing'),
            path.join(this.basePath, 'temp')
        ];

        directories.forEach(dir => {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
                console.log(`📁 Created directory: ${dir}`);
            }
        });
    }

    // Validate file before transfer
    validateFile(filename, fileSize) {
        const ext = path.extname(filename).toLowerCase();

        // A declared size that is not a real, non-negative number would make
        // every later size comparison meaningless (NaN fails every `>` test,
        // and a negative total produces negative progress). Reject it up front
        // rather than discovering it at completion time.
        if (!Number.isFinite(fileSize) || fileSize < 0) {
            throw new Error('File size must be a non-negative number');
        }

        if (fileSize > this.maxFileSize) {
            throw new Error(`File too large. Maximum size is ${this.formatFileSize(this.maxFileSize)}`);
        }

        if (!this.allowedExtensions.includes(ext)) {
            throw new Error(`File type not allowed. Allowed types: ${this.allowedExtensions.join(', ')}`);
        }

        return true;
    }

    getProgressMetadata(transfer, bytesTransferred) {
        const totalBytes = transfer.fileSize;
        const elapsedSeconds = Math.max((Date.now() - transfer.startTime.getTime()) / 1000, 0.001);
        const speedBps = bytesTransferred > 0 ? Math.round(bytesTransferred / elapsedSeconds) : 0;
        return {
            bytesTransferred,
            totalBytes,
            speedBps,
            etaSeconds: speedBps > 0 ? Math.ceil((totalBytes - bytesTransferred) / speedBps) : null,
            startedAt: transfer.startTime.toISOString()
        };
    }

    retainTransferHistory(transfer) {
        const { chunks, filePath, ...metadata } = transfer;
        this.transferHistory.push(metadata);
        if (this.transferHistory.length > this.maxTransferHistory) {
            this.transferHistory.splice(0, this.transferHistory.length - this.maxTransferHistory);
        }
    }

    // Start file upload from client
    async startUpload(filename, fileSize, clientId) {
        try {
            this.validateFile(filename, fileSize);
            
            const transferId = this.generateTransferId();
            const safeFilename = this.sanitizeFilename(filename);
            const incomingDir = path.join(this.basePath, 'incoming');
            // The staging name only has to be unique among in-flight uploads.
            // The name the user actually ends up with is decided at completion,
            // against whatever is already in Downloads.
            const staging = this.resolveAvailablePath(incomingDir, safeFilename);

            const transfer = {
                id: transferId,
                filename: safeFilename,
                originalFilename: filename,
                filePath: staging.filePath,
                stagingFilename: staging.filename,
                fileSize: fileSize,
                clientId: clientId,
                direction: 'upload',
                status: 'pending',
                progress: 0,
                startTime: new Date(),
                chunks: []
            };

            this.activeTransfers.set(transferId, transfer);

            console.log(`📤 Starting upload: ${filename} (${this.formatFileSize(fileSize)})`);

            return {
                transferId: transferId,
                filename: safeFilename,
                totalBytes: fileSize,
                startedAt: transfer.startTime.toISOString(),
                chunkSize: UPLOAD_CHUNK_SIZE,
                success: true
            };
        } catch (error) {
            console.error('❌ Upload validation failed:', error.message);
            throw error;
        }
    }

    // Handle file chunk upload
    async handleChunk(transferId, chunkIndex, chunkData, isLastChunk = false) {
        const transfer = this.activeTransfers.get(transferId);

        if (!transfer) {
            throw new Error('Transfer not found');
        }

        try {
            // Convert base64 to buffer if necessary
            const buffer = typeof chunkData === 'string'
                ? Buffer.from(chunkData, 'base64')
                : chunkData;

            // The chunk index is written straight into the array that the file
            // is later assembled from, so it has to be checked before it is
            // used. A negative index would be stored as a plain property and
            // silently dropped by Buffer.concat, and a wildly large one would
            // build a sparse array large enough to exhaust memory.
            if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
                throw new Error(`Invalid chunk index: ${chunkIndex}`);
            }
            const highestPlausibleIndex = Math.max(0, Math.ceil(transfer.fileSize / UPLOAD_CHUNK_SIZE));
            if (chunkIndex > highestPlausibleIndex) {
                throw new Error(`Chunk index ${chunkIndex} is beyond the end of a ${this.formatFileSize(transfer.fileSize)} file`);
            }

            transfer.chunks[chunkIndex] = buffer;
            const bytesTransferred = transfer.chunks.reduce((sum, chunk) => sum + (chunk ? chunk.length : 0), 0);

            // The declared size is client-supplied, so it cannot be trusted to
            // bound anything. The real limit is enforced against the bytes that
            // actually arrived, otherwise one transfer can buffer the whole
            // heap while claiming to be a few bytes long.
            if (bytesTransferred > this.maxFileSize) {
                throw new Error(`File too large. Maximum size is ${this.formatFileSize(this.maxFileSize)}`);
            }

            transfer.bytesTransferred = bytesTransferred;
            transfer.progress = transfer.fileSize === 0 ? (isLastChunk ? 100 : 0) : Math.min(100, bytesTransferred / transfer.fileSize * 100);

            this.emit('progress', {
                transferId: transferId,
                progress: transfer.progress,
                filename: transfer.filename,
                ...this.getProgressMetadata(transfer, bytesTransferred)
            });

            if (isLastChunk) {
                await this.completeUpload(transferId);
            }

            return {
                success: true,
                progress: transfer.progress,
                ...this.getProgressMetadata(transfer, bytesTransferred)
            };
        } catch (error) {
            this.failTransfer(transferId);
            console.error(`❌ Chunk upload error for ${transfer.filename}:`, error);
            throw error;
        }
    }

    // Rejects an upload whose chunks do not form an unbroken run from zero.
    // `transfer.chunks` is a sparse array, so a chunk that never arrived leaves
    // a hole that Buffer.concat would turn into a zero-filled gap.
    assertNoMissingChunks(transfer) {
        let highest = -1;
        for (let i = 0; i < transfer.chunks.length; i++) {
            if (transfer.chunks[i] !== undefined) highest = i;
        }
        for (let i = 0; i <= highest; i++) {
            if (transfer.chunks[i] === undefined) {
                throw new Error(`Upload is missing chunk ${i} of ${highest + 1}`);
            }
        }
    }

    // Complete file upload
    async completeUpload(transferId) {
        const transfer = this.activeTransfers.get(transferId);

        if (!transfer) {
            throw new Error('Transfer not found');
        }

        const stagingPath = transfer.filePath;
        let deliveredPath = null;

        try {
            // 1. Stage the assembled file where partial uploads already live.
            //    The chunk array is only correct if every position up to the
            //    last one that was written is actually filled: a gap left by a
            //    dropped or reordered chunk would otherwise be assembled
            //    silently short.
            this.assertNoMissingChunks(transfer);
            const completeBuffer = Buffer.concat(transfer.chunks);

            // The client declared this size, so it is a claim rather than a
            // fact. Comparing the assembled bytes against it is the only check
            // that can catch a truncated upload, and it has to happen before
            // anything is written to the user's Downloads folder.
            if (completeBuffer.length !== transfer.fileSize) {
                throw new Error(
                    `Upload is incomplete: received ${this.formatFileSize(completeBuffer.length)} of ${this.formatFileSize(transfer.fileSize)}`
                );
            }

            fs.writeFileSync(stagingPath, completeBuffer);

            // 2. Finalize into the user's Downloads folder. The destination is
            //    decided here on the server; a client cannot choose it.
            const downloadsDir = this.getDownloadsPath();
            if (!downloadsDir) {
                throw new Error('The Downloads folder could not be located on this computer');
            }
            const safeName = this.sanitizeFilename(transfer.originalFilename || transfer.filename);
            const target = this.resolveAvailablePath(downloadsDir, safeName);
            deliveredPath = target.filePath;

            // 3. Move rather than duplicate, falling back to copy+unlink when
            //    the two folders are on different volumes.
            try {
                fs.renameSync(stagingPath, deliveredPath);
            } catch (error) {
                fs.copyFileSync(stagingPath, deliveredPath);
                fs.unlinkSync(stagingPath);
            }

            // 4. Confirm the bytes that actually landed on disk match the bytes
            //    that were verified above. This catches a short write (a full
            //    disk, for example). A file that cannot be confirmed is removed
            //    again, so Downloads never holds a partial upload.
            const stats = fs.statSync(deliveredPath);
            if (!stats.isFile() || stats.size !== completeBuffer.length) {
                throw new Error('The delivered file could not be verified');
            }

            // 5. Only now is the transfer complete.
            transfer.status = 'completed';
            transfer.endTime = new Date();
            transfer.actualSize = stats.size;
            transfer.finalFilename = target.filename;
            // The Transfer Manager shows the name the user actually received,
            // which may differ from the original when a collision was avoided.
            transfer.filename = target.filename;
            transfer.filePath = deliveredPath;
            this.rememberReceivedFile(target.filename, stats.size);

            this.retainTransferHistory(transfer);
            this.activeTransfers.delete(transferId);

            console.log(`✅ Upload completed: ${transfer.filename} → Downloads as ${target.filename}`);

            this.emit('completed', {
                transferId: transferId,
                filename: transfer.filename,
                direction: 'upload',
                ...this.getProgressMetadata(transfer, transfer.actualSize),
                completedAt: transfer.endTime.toISOString()
            });

            return {
                success: true,
                // The final name is safe metadata. The absolute path stays here,
                // on the server, and is never sent to a client.
                filename: target.filename,
                size: stats.size,
                mimeType: this.getMimeType(target.filename)
            };
        } catch (error) {
            if (deliveredPath && fs.existsSync(deliveredPath)) {
                try { fs.unlinkSync(deliveredPath); } catch (cleanupError) { /* best effort */ }
            }
            if (fs.existsSync(stagingPath)) {
                try { fs.unlinkSync(stagingPath); } catch (cleanupError) { /* best effort */ }
            }
            transfer.filePath = stagingPath;
            this.failTransfer(transferId);
            console.error(`❌ Upload completion error for ${transfer.filename}:`, error);
            throw error;
        }
    }

    // Start file download to client
    async startDownload(filename, clientId, options = {}) {
        try {
            // Defense in depth: the name must be a bare filename and must
            // resolve inside one of the two approved shared roots.
            let resolved;
            if (options.location) {
                resolved = this.resolveSharedFile(filename, options.location);
            } else {
                // Legacy behaviour: "From Laptop" wins, so a name present in
                // both roots downloads exactly the file it always did.
                const names = this.assertSharedFileName(filename);
                resolved = this.resolveSharedFile(names, 'from-laptop', { required: false });
                if (!fs.existsSync(resolved.filePath)) {
                    resolved = this.resolveSharedFile(names, 'from-phone');
                } else {
                    resolved = this.resolveSharedFile(names, 'from-laptop');
                }
            }

            const stats = fs.statSync(resolved.filePath);
            const transferId = this.generateTransferId();
            const mimeType = this.getMimeType(resolved.name);
            if (options.preview === true) {
                if (!this.isPreviewableMime(mimeType)) {
                    throw new Error('This file type cannot be previewed');
                }
                if (stats.size > this.maxPreviewSize) {
                    throw new Error(`File too large to preview. Maximum preview size is ${this.formatFileSize(this.maxPreviewSize)}`);
                }
            }

            const transfer = {
                id: transferId,
                filename: resolved.name,
                filePath: resolved.filePath,
                fileSize: stats.size,
                mimeType,
                location: resolved.location,
                clientId: clientId,
                direction: 'download',
                // A preview read borrows the same chunk protocol but must not
                // look like a transfer: nothing is announced, recorded, or
                // pushed to the Transfer Manager.
                preview: !!options.preview,
                status: 'pending',
                progress: 0,
                startTime: new Date()
            };

            this.activeTransfers.set(transferId, transfer);

            console.log(`📥 Starting ${transfer.preview ? 'preview' : 'download'}: ${resolved.name} (${this.formatFileSize(stats.size)})`);

            return {
                transferId: transferId,
                filename: resolved.name,
                totalBytes: stats.size,
                fileSize: stats.size,
                mimeType,
                location: resolved.location,
                preview: transfer.preview,
                chunkSize: UPLOAD_CHUNK_SIZE,
                startedAt: transfer.startTime.toISOString(),
                success: true
            };
        } catch (error) {
            console.error('❌ Download start failed:', error.message);
            throw error;
        }
    }

    // Get file chunk for download
    async getChunk(transferId, chunkIndex) {
        const transfer = this.activeTransfers.get(transferId);

        if (!transfer) {
            throw new Error('Transfer not found');
        }

        // A malformed index is a bad request, not a transfer failure. It is
        // rejected before the transfer is touched, so a client that asks for
        // something out of range can correct itself and carry on instead of
        // losing the whole download.
        if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
            throw new Error(`Invalid chunk index: ${chunkIndex}`);
        }
        const chunkSize = UPLOAD_CHUNK_SIZE;
        const startPos = chunkIndex * chunkSize;
        if (startPos > transfer.fileSize) {
            throw new Error(`Chunk index ${chunkIndex} is beyond the end of a ${this.formatFileSize(transfer.fileSize)} file`);
        }

        try {
            const endPos = Math.min(startPos + chunkSize, transfer.fileSize);

            const buffer = Buffer.alloc(endPos - startPos);
            // The descriptor is closed on every path. A read that throws would
            // otherwise leak it for the lifetime of the process.
            const fd = fs.openSync(transfer.filePath, 'r');
            try {
                fs.readSync(fd, buffer, 0, buffer.length, startPos);
            } finally {
                fs.closeSync(fd);
            }

            transfer.bytesTransferred = endPos;
            transfer.progress = transfer.fileSize === 0 ? 100 : Math.min(100, endPos / transfer.fileSize * 100);

            const isLastChunk = endPos >= transfer.fileSize;

            if (isLastChunk) {
                transfer.status = 'completed';
                transfer.endTime = new Date();
                this.activeTransfers.delete(transferId);

                if (!transfer.preview) {
                    this.retainTransferHistory(transfer);
                    this.emit('completed', {
                        transferId: transferId,
                        filename: transfer.filename,
                        direction: 'download',
                        ...this.getProgressMetadata(transfer, endPos),
                        completedAt: transfer.endTime.toISOString()
                    });
                }
            }

            if (!transfer.preview) {
                this.emit('progress', {
                    transferId: transferId,
                    progress: transfer.progress,
                    filename: transfer.filename,
                    ...this.getProgressMetadata(transfer, endPos)
                });
            }

            return {
                data: buffer.toString('base64'),
                isLastChunk: isLastChunk,
                progress: transfer.progress,
                ...this.getProgressMetadata(transfer, endPos)
            };
        } catch (error) {
            this.failTransfer(transferId);
            console.error(`❌ Chunk download error for ${transfer.filename}:`, error);
            throw error;
        }
    }

    // List available files for download
    listAvailableFiles() {
        return this.listSharedFiles()
            .filter((file) => file.location === 'from-laptop')
            .map((file) => ({
                filename: file.name,
                size: file.size,
                formattedSize: file.formattedSize,
                lastModified: file.modifiedAt,
                extension: file.extension,
                type: file.type
            }));
    }

    // List uploaded files
    listUploadedFiles() {
        return this.listSharedFiles()
            .filter((file) => file.location === 'from-phone')
            .map((file) => ({
                filename: file.name,
                size: file.size,
                formattedSize: file.formattedSize,
                uploadTime: file.modifiedAt,
                extension: file.extension,
                type: file.type
            }));
    }

    // Delete file
    deleteFile(filename, location = 'incoming') {
        try {
            const dirName = this.resolveLocationDir(location);
            if (!dirName) {
                throw new Error('Invalid location');
            }
            // Resolves the bare name and confirms it lands directly inside the
            // approved root before anything is removed.
            const resolved = this.resolveSharedFile(filename, location);

            fs.unlinkSync(resolved.filePath);
            if (resolved.location === 'from-phone') this.forgetReceivedFile(resolved.name);
            console.log(`🗑️ Deleted ${dirName} file: ${resolved.name}`);
            return { success: true, name: resolved.name, location };
        } catch (error) {
            console.error(`❌ Error deleting file ${filename}:`, error);
            throw error;
        }
    }

    // Get transfer status
    getTransferStatus(transferId) {
        const transfer = this.activeTransfers.get(transferId);
        
        if (transfer) {
            return {
                id: transfer.id,
                filename: transfer.filename,
                progress: transfer.progress,
                status: transfer.status,
                direction: transfer.direction,
                fileSize: transfer.fileSize,
                formattedSize: this.formatFileSize(transfer.fileSize)
            };
        }

        // Check history
        const historicalTransfer = this.transferHistory.find(t => t.id === transferId);
        if (historicalTransfer) {
            return {
                id: historicalTransfer.id,
                filename: historicalTransfer.filename,
                status: historicalTransfer.status,
                direction: historicalTransfer.direction,
                completedAt: historicalTransfer.endTime
            };
        }

        return null;
    }

    // Get all active transfers
    getActiveTransfers() {
        return Array.from(this.activeTransfers.values()).map(transfer => ({
            id: transfer.id,
            filename: transfer.filename,
            progress: transfer.progress,
            status: transfer.status,
            direction: transfer.direction,
            fileSize: transfer.fileSize,
            formattedSize: this.formatFileSize(transfer.fileSize),
            ...this.getProgressMetadata(transfer, transfer.bytesTransferred || 0)
        }));
    }

    // Cancel transfer
    failTransfer(transferId) {
        const transfer = this.activeTransfers.get(transferId);
        if (!transfer) return false;
        transfer.status = 'failed';
        transfer.endTime = new Date();
        if (transfer.direction === 'upload' && fs.existsSync(transfer.filePath)) {
            try {
                fs.unlinkSync(transfer.filePath);
            } catch (error) {
                console.error(`❌ Failed to remove partial upload ${transfer.filename}:`, error.message);
            }
        }
        this.activeTransfers.delete(transferId);
        this.retainTransferHistory(transfer);
        this.emit('failed', {
            transferId,
            filename: transfer.filename,
            direction: transfer.direction,
            progress: transfer.progress,
            ...this.getProgressMetadata(transfer, transfer.bytesTransferred || 0),
            completedAt: transfer.endTime.toISOString()
        });
        return true;
    }

    cancelTransfer(transferId, clientId) {
        const transfer = this.activeTransfers.get(transferId);

        if (transfer && clientId && transfer.clientId !== clientId) {
            throw new Error('Transfer not found');
        }
        
        if (transfer) {
            transfer.status = 'cancelled';
            transfer.endTime = new Date();
            this.activeTransfers.delete(transferId);
            
            // Clean up partial files
            if (transfer.direction === 'upload' && fs.existsSync(transfer.filePath)) {
                fs.unlinkSync(transfer.filePath);
            }
            
            console.log(`🚫 Transfer cancelled: ${transfer.filename}`);
            
            this.emit('cancelled', {
                transferId: transferId,
                filename: transfer.filename,
                direction: transfer.direction,
                ...this.getProgressMetadata(transfer, transfer.bytesTransferred || 0),
                completedAt: transfer.endTime.toISOString()
            });
            
            return { success: true };
        }
        
        throw new Error('Transfer not found');
    }

    // Utility functions
    generateTransferId() {
        return crypto.randomBytes(8).toString('hex');
    }

    // Turns whatever a client sent into a bare, Windows-safe filename while
    // keeping the original name recognisable. Directory components, traversal
    // segments, drive letters, UNC prefixes, control characters, and the
    // characters Windows forbids are all removed or replaced; the extension
    // and any non-Latin characters are preserved.
    sanitizeFilename(filename) {
        let base = String(filename == null ? '' : filename);
        // Drop any directory component, whatever separator style was used.
        base = base.split(/[\\/]/).pop() || '';
        // Control characters, including a NUL byte.
        base = base.replace(/[\u0000-\u001f\u007f]/g, '');
        // Characters Windows forbids in a filename.
        base = base.replace(/[<>:"|?*]/g, '_');
        // Leading dots and trailing dots/spaces: Windows strips these silently,
        // which would let "photo.jpg." and "photo.jpg" collide.
        base = base.replace(/^\.+/, '').replace(/[. ]+$/, '');
        if (!base || base === '.' || base === '..') base = 'file';
        // Reserved device names, with or without an extension.
        if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(base.split('.')[0])) {
            base = `_${base}`;
        }
        if (Buffer.byteLength(base, 'utf8') > 240) {
            const extension = path.extname(base).slice(0, 24);
            base = base.slice(0, 240 - extension.length) + extension;
        }
        return base;
    }

    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    // Cleanup old transfers
    cleanup() {
        const now = new Date();
        const maxAge = 24 * 60 * 60 * 1000; // 24 hours

        // Clean up old active transfers (probably stuck)
        for (const [id, transfer] of this.activeTransfers) {
            if (now - transfer.startTime > maxAge) {
                if (transfer.preview) {
                    // A stale preview read is internal state, not a transfer,
                    // so it is dropped without any cancellation being announced.
                    this.activeTransfers.delete(id);
                    continue;
                }
                console.log(`🧹 Cleaning up stale transfer: ${transfer.filename}`);
                this.cancelTransfer(id);
            }
        }

        // Clean up old history
        this.transferHistory = this.transferHistory.filter(
            transfer => now - (transfer.endTime || transfer.startTime) < maxAge * 7
        );
    }

    // Get statistics
    getStats() {
        const totalTransfers = this.transferHistory.length + this.activeTransfers.size;
        const completedTransfers = this.transferHistory.filter(t => t.status === 'completed').length;
        const totalDataTransferred = this.transferHistory
            .filter(t => t.status === 'completed')
            .reduce((sum, t) => sum + (t.actualSize || t.fileSize), 0);

        return {
            totalTransfers,
            completedTransfers,
            activeTransfers: this.activeTransfers.size,
            totalDataTransferred: this.formatFileSize(totalDataTransferred),
            successRate: totalTransfers > 0 ? (completedTransfers / totalTransfers * 100).toFixed(1) + '%' : '0%'
        };
    }
}

module.exports = FileTransferManager;