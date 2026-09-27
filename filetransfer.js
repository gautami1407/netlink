const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

class FileTransferManager extends EventEmitter {
    constructor(basePath = './transfers') {
        super();
        this.basePath = basePath;
        this.activeTransfers = new Map();
        this.transferHistory = [];
        this.maxFileSize = 100 * 1024 * 1024; // 100MB limit
        this.allowedExtensions = [
            '.txt', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
            '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.svg',
            '.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac',
            '.zip', '.rar', '.7z', '.tar', '.gz',
            '.js', '.html', '.css', '.json', '.xml', '.csv'
        ];
        
        this.initializeDirectories();
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
        
        if (fileSize > this.maxFileSize) {
            throw new Error(`File too large. Maximum size is ${this.formatFileSize(this.maxFileSize)}`);
        }

        if (!this.allowedExtensions.includes(ext)) {
            throw new Error(`File type not allowed. Allowed types: ${this.allowedExtensions.join(', ')}`);
        }

        return true;
    }

    // Start file upload from client
    async startUpload(filename, fileSize, clientId) {
        try {
            this.validateFile(filename, fileSize);
            
            const transferId = this.generateTransferId();
            const baseName = this.sanitizeFilename(path.basename(filename)) || 'file';
            const incomingDir = path.join(this.basePath, 'incoming');
            let sanitizedFilename = baseName;
            let filePath = path.join(incomingDir, sanitizedFilename);
            if (path.dirname(filePath) !== incomingDir) {
                throw new Error('Invalid filename');
            }
            // Avoid silently overwriting an existing file of the same name.
            if (fs.existsSync(filePath)) {
                sanitizedFilename = `${Date.now()}_${baseName}`;
                filePath = path.join(incomingDir, sanitizedFilename);
            }
            
            const transfer = {
                id: transferId,
                filename: sanitizedFilename,
                originalFilename: filename,
                filePath: filePath,
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
                chunkSize: 64 * 1024, // 64KB chunks
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

            transfer.chunks[chunkIndex] = buffer;
            transfer.progress = (transfer.chunks.filter(chunk => chunk).length / 
                Math.ceil(transfer.fileSize / (64 * 1024))) * 100;

            this.emit('progress', {
                transferId: transferId,
                progress: transfer.progress,
                filename: transfer.filename
            });

            if (isLastChunk) {
                await this.completeUpload(transferId);
            }

            return { success: true, progress: transfer.progress };
        } catch (error) {
            transfer.status = 'error';
            console.error(`❌ Chunk upload error for ${transfer.filename}:`, error);
            throw error;
        }
    }

    // Complete file upload
    async completeUpload(transferId) {
        const transfer = this.activeTransfers.get(transferId);
        
        if (!transfer) {
            throw new Error('Transfer not found');
        }

        try {
            // Combine all chunks
            const completeBuffer = Buffer.concat(transfer.chunks);
            
            // Write to file
            fs.writeFileSync(transfer.filePath, completeBuffer);
            
            transfer.status = 'completed';
            transfer.endTime = new Date();
            transfer.actualSize = completeBuffer.length;
            
            // Move to history
            this.transferHistory.push({ ...transfer });
            this.activeTransfers.delete(transferId);
            
            console.log(`✅ Upload completed: ${transfer.filename}`);
            
            this.emit('completed', {
                transferId: transferId,
                filename: transfer.filename,
                filePath: transfer.filePath,
                direction: 'upload'
            });

            return {
                success: true,
                filePath: transfer.filePath,
                filename: transfer.filename
            };
        } catch (error) {
            transfer.status = 'error';
            console.error(`❌ Upload completion error for ${transfer.filename}:`, error);
            throw error;
        }
    }

    // Start file download to client
    async startDownload(filename, clientId) {
        try {
            // Defense in depth: never trust a client-supplied path, only a bare filename.
            const safeName = path.basename(filename);
            const outgoingDir = path.join(this.basePath, 'outgoing');
            const filePath = path.join(outgoingDir, safeName);

            if (path.dirname(filePath) !== outgoingDir) {
                throw new Error('Invalid filename');
            }

            if (!fs.existsSync(filePath)) {
                throw new Error('File not found');
            }
            filename = safeName;

            const stats = fs.statSync(filePath);
            const transferId = this.generateTransferId();
            
            const transfer = {
                id: transferId,
                filename: filename,
                filePath: filePath,
                fileSize: stats.size,
                clientId: clientId,
                direction: 'download',
                status: 'pending',
                progress: 0,
                startTime: new Date()
            };

            this.activeTransfers.set(transferId, transfer);
            
            console.log(`📥 Starting download: ${filename} (${this.formatFileSize(stats.size)})`);
            
            return {
                transferId: transferId,
                fileSize: stats.size,
                chunkSize: 64 * 1024,
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

        try {
            const chunkSize = 64 * 1024;
            const startPos = chunkIndex * chunkSize;
            const endPos = Math.min(startPos + chunkSize, transfer.fileSize);
            
            const buffer = Buffer.alloc(endPos - startPos);
            const fd = fs.openSync(transfer.filePath, 'r');
            fs.readSync(fd, buffer, 0, buffer.length, startPos);
            fs.closeSync(fd);
            
            transfer.progress = ((chunkIndex + 1) * chunkSize / transfer.fileSize) * 100;
            
            const isLastChunk = endPos >= transfer.fileSize;
            
            if (isLastChunk) {
                transfer.status = 'completed';
                transfer.endTime = new Date();
                this.transferHistory.push({ ...transfer });
                this.activeTransfers.delete(transferId);
                
                this.emit('completed', {
                    transferId: transferId,
                    filename: transfer.filename,
                    direction: 'download'
                });
            }

            this.emit('progress', {
                transferId: transferId,
                progress: transfer.progress,
                filename: transfer.filename
            });

            return {
                data: buffer.toString('base64'),
                isLastChunk: isLastChunk,
                progress: transfer.progress
            };
        } catch (error) {
            transfer.status = 'error';
            console.error(`❌ Chunk download error for ${transfer.filename}:`, error);
            throw error;
        }
    }

    // List available files for download
    listAvailableFiles() {
        const outgoingDir = path.join(this.basePath, 'outgoing');
        
        try {
            const files = fs.readdirSync(outgoingDir).map(filename => {
                const filePath = path.join(outgoingDir, filename);
                const stats = fs.statSync(filePath);
                
                return {
                    filename: filename,
                    size: stats.size,
                    formattedSize: this.formatFileSize(stats.size),
                    lastModified: stats.mtime,
                    extension: path.extname(filename)
                };
            });

            return files;
        } catch (error) {
            console.error('❌ Error listing files:', error);
            return [];
        }
    }

    // List uploaded files
    listUploadedFiles() {
        const incomingDir = path.join(this.basePath, 'incoming');
        
        try {
            const files = fs.readdirSync(incomingDir).map(filename => {
                const filePath = path.join(incomingDir, filename);
                const stats = fs.statSync(filePath);
                
                return {
                    filename: filename,
                    size: stats.size,
                    formattedSize: this.formatFileSize(stats.size),
                    uploadTime: stats.ctime,
                    extension: path.extname(filename)
                };
            });

            return files;
        } catch (error) {
            console.error('❌ Error listing uploaded files:', error);
            return [];
        }
    }

    // Delete file
    deleteFile(filename, direction = 'incoming') {
        try {
            if (direction !== 'incoming' && direction !== 'outgoing') {
                throw new Error('Invalid direction');
            }
            const dir = path.join(this.basePath, direction);
            const filePath = path.join(dir, path.basename(filename));
            if (path.dirname(filePath) !== dir) {
                throw new Error('Invalid filename');
            }

            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                console.log(`🗑️ Deleted file: ${filename}`);
                return { success: true };
            } else {
                throw new Error('File not found');
            }
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
            formattedSize: this.formatFileSize(transfer.fileSize)
        }));
    }

    // Cancel transfer
    cancelTransfer(transferId) {
        const transfer = this.activeTransfers.get(transferId);
        
        if (transfer) {
            transfer.status = 'cancelled';
            this.activeTransfers.delete(transferId);
            
            // Clean up partial files
            if (transfer.direction === 'upload' && fs.existsSync(transfer.filePath)) {
                fs.unlinkSync(transfer.filePath);
            }
            
            console.log(`🚫 Transfer cancelled: ${transfer.filename}`);
            
            this.emit('cancelled', {
                transferId: transferId,
                filename: transfer.filename
            });
            
            return { success: true };
        }
        
        throw new Error('Transfer not found');
    }

    // Utility functions
    generateTransferId() {
        return crypto.randomBytes(8).toString('hex');
    }

    sanitizeFilename(filename) {
        return filename.replace(/[^a-zA-Z0-9.-]/g, '_');
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