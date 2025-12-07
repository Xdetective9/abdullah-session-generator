const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const NodeCache = require('node-cache');

class SessionManager {
    constructor() {
        this.sessions = new Map();
        this.cache = new NodeCache({ 
            stdTTL: 300,
            checkperiod: 60 
        });
        
        // Session storage directory
        this.sessionDir = path.join(__dirname, '../../sessions');
        fs.ensureDirSync(this.sessionDir);
        
        // Statistics
        this.stats = {
            totalCreated: 0,
            totalDeleted: 0,
            activeSessions: 0,
            expiredSessions: 0,
            errors: 0
        };
        
        // Load existing sessions
        this.loadSessions();
    }

    async loadSessions() {
        try {
            const sessionDirs = await fs.readdir(this.sessionDir);
            
            for (const dir of sessionDirs) {
                const sessionPath = path.join(this.sessionDir, dir, 'session-info.json');
                
                if (await fs.pathExists(sessionPath)) {
                    try {
                        const sessionData = await fs.readJson(sessionPath);
                        this.sessions.set(sessionData.id, sessionData);
                        this.stats.totalCreated++;
                        
                        // Check if session is expired
                        if (this.isSessionExpired(sessionData)) {
                            this.stats.expiredSessions++;
                        } else {
                            this.stats.activeSessions++;
                        }
                    } catch (error) {
                        console.error(`Error loading session ${dir}:`, error);
                        this.stats.errors++;
                    }
                }
            }
            
            console.log(`✅ Loaded ${this.sessions.size} sessions from storage`);
        } catch (error) {
            console.error('Error loading sessions:', error);
        }
    }

    createSession(data) {
        try {
            const sessionId = data.id || `WA_${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
            
            const session = {
                id: sessionId,
                name: data.name || 'Abdullah-Md-Session',
                phone: data.phone,
                security: data.security || 'high',
                method: data.method || 'code',
                status: 'pending',
                createdAt: new Date(),
                expiresAt: data.expiresAt || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
                metadata: data.metadata || {},
                stats: {
                    connectionAttempts: 0,
                    lastConnection: null,
                    messagesSent: 0,
                    messagesReceived: 0,
                    errors: 0
                }
            };

            this.sessions.set(sessionId, session);
            this.stats.totalCreated++;
            this.stats.activeSessions++;
            
            // Save to disk
            this.saveSession(session);
            
            // Cache session
            this.cache.set(`session_${sessionId}`, session);
            
            console.log(`✅ Created session: ${sessionId} for ${session.phone}`);
            
            return {
                success: true,
                session: session
            };
            
        } catch (error) {
            console.error('Error creating session:', error);
            this.stats.errors++;
            
            return {
                success: false,
                error: error.message
            };
        }
    }

    async saveSession(session) {
        try {
            const sessionDir = path.join(this.sessionDir, session.id);
            await fs.ensureDir(sessionDir);
            
            const sessionPath = path.join(sessionDir, 'session-info.json');
            await fs.writeJson(sessionPath, session, { spaces: 2 });
            
            console.log(`💾 Saved session: ${session.id}`);
            
        } catch (error) {
            console.error('Error saving session:', error);
            this.stats.errors++;
        }
    }

    getSession(sessionId) {
        // Try cache first
        const cached = this.cache.get(`session_${sessionId}`);
        if (cached) return cached;
        
        // Get from memory
        const session = this.sessions.get(sessionId);
        if (session) {
            this.cache.set(`session_${sessionId}`, session);
        }
        
        return session;
    }

    getAllSessions(filter = {}) {
        let sessions = Array.from(this.sessions.values());
        
        // Apply filters
        if (filter.status) {
            sessions = sessions.filter(s => s.status === filter.status);
        }
        
        if (filter.phone) {
            sessions = sessions.filter(s => s.phone.includes(filter.phone));
        }
        
        if (filter.dateFrom) {
            const dateFrom = new Date(filter.dateFrom);
            sessions = sessions.filter(s => new Date(s.createdAt) >= dateFrom);
        }
        
        if (filter.dateTo) {
            const dateTo = new Date(filter.dateTo);
            sessions = sessions.filter(s => new Date(s.createdAt) <= dateTo);
        }
        
        // Sort by creation date (newest first)
        sessions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        
        return sessions;
    }

    updateSession(sessionId, updates) {
        try {
            const session = this.getSession(sessionId);
            if (!session) {
                return {
                    success: false,
                    error: 'Session not found'
                };
            }
            
            // Merge updates
            Object.assign(session, updates);
            session.updatedAt = new Date();
            
            // Update in memory
            this.sessions.set(sessionId, session);
            
            // Update cache
            this.cache.set(`session_${sessionId}`, session);
            
            // Save to disk
            this.saveSession(session);
            
            console.log(`🔄 Updated session: ${sessionId}`);
            
            return {
                success: true,
                session: session
            };
            
        } catch (error) {
            console.error('Error updating session:', error);
            this.stats.errors++;
            
            return {
                success: false,
                error: error.message
            };
        }
    }

    async deleteSession(sessionId) {
        try {
            const session = this.getSession(sessionId);
            if (!session) {
                return {
                    success: false,
                    error: 'Session not found'
                };
            }
            
            // Remove from memory
            this.sessions.delete(sessionId);
            
            // Remove from cache
            this.cache.del(`session_${sessionId}`);
            
            // Delete session directory
            const sessionDir = path.join(this.sessionDir, sessionId);
            if (await fs.pathExists(sessionDir)) {
                await fs.remove(sessionDir);
            }
            
            this.stats.activeSessions--;
            this.stats.totalDeleted++;
            
            console.log(`🗑️ Deleted session: ${sessionId}`);
            
            return {
                success: true,
                message: 'Session deleted successfully'
            };
            
        } catch (error) {
            console.error('Error deleting session:', error);
            this.stats.errors++;
            
            return {
                success: false,
                error: error.message
            };
        }
    }

    async cleanupExpiredSessions() {
        try {
            const now = new Date();
            let cleaned = 0;
            
            for (const [sessionId, session] of this.sessions.entries()) {
                if (this.isSessionExpired(session)) {
                    await this.deleteSession(sessionId);
                    cleaned++;
                }
            }
            
            console.log(`🧹 Cleaned up ${cleaned} expired sessions`);
            
            return cleaned;
            
        } catch (error) {
            console.error('Error cleaning up sessions:', error);
            return 0;
        }
    }

    isSessionExpired(session) {
        if (!session.expiresAt) return false;
        
        const now = new Date();
        const expiresAt = new Date(session.expiresAt);
        
        return now > expiresAt;
    }

    getSessionStats(sessionId) {
        const session = this.getSession(sessionId);
        if (!session) return null;
        
        return {
            id: session.id,
            status: session.status,
            phone: session.phone,
            created: session.createdAt,
            expires: session.expiresAt,
            age: Math.floor((new Date() - new Date(session.createdAt)) / (1000 * 60 * 60 * 24)),
            stats: session.stats,
            isExpired: this.isSessionExpired(session),
            storage: this.getSessionStorageInfo(sessionId)
        };
    }

    async getSessionStorageInfo(sessionId) {
        try {
            const sessionDir = path.join(this.sessionDir, sessionId);
            
            if (!await fs.pathExists(sessionDir)) {
                return { exists: false };
            }
            
            const files = await fs.readdir(sessionDir);
            let totalSize = 0;
            
            for (const file of files) {
                const filePath = path.join(sessionDir, file);
                const stats = await fs.stat(filePath);
                totalSize += stats.size;
            }
            
            return {
                exists: true,
                fileCount: files.length,
                totalSize: totalSize,
                sizeReadable: this.formatBytes(totalSize),
                files: files
            };
            
        } catch (error) {
            return { error: error.message };
        }
    }

    formatBytes(bytes) {
        if (bytes === 0) return '0 Bytes';
        
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    searchSessions(query) {
        const results = [];
        
        for (const session of this.sessions.values()) {
            const searchable = [
                session.id,
                session.name,
                session.phone,
                session.status
            ].join(' ').toLowerCase();
            
            if (searchable.includes(query.toLowerCase())) {
                results.push(session);
            }
        }
        
        return results;
    }

    exportSessions(format = 'json') {
        const sessions = Array.from(this.sessions.values());
        
        switch (format) {
            case 'json':
                return JSON.stringify(sessions, null, 2);
                
            case 'csv':
                const headers = ['ID', 'Name', 'Phone', 'Status', 'Created', 'Expires'];
                const rows = sessions.map(s => [
                    s.id,
                    s.name,
                    s.phone,
                    s.status,
                    new Date(s.createdAt).toISOString(),
                    new Date(s.expiresAt).toISOString()
                ]);
                
                return [headers, ...rows]
                    .map(row => row.join(','))
                    .join('\n');
                    
            case 'txt':
                return sessions.map(s => 
                    `${s.id} | ${s.name} | ${s.phone} | ${s.status} | ${new Date(s.createdAt).toLocaleString()}`
                ).join('\n');
                
            default:
                throw new Error(`Unsupported format: ${format}`);
        }
    }

    getStats() {
        const now = new Date();
        const sessions = Array.from(this.sessions.values());
        
        // Calculate daily stats
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        const createdToday = sessions.filter(s => 
            new Date(s.createdAt) >= today
        ).length;
        
        // Calculate by status
        const byStatus = {};
        sessions.forEach(s => {
            byStatus[s.status] = (byStatus[s.status] || 0) + 1;
        });
        
        // Calculate by method
        const byMethod = {};
        sessions.forEach(s => {
            byMethod[s.method] = (byMethod[s.method] || 0) + 1;
        });
        
        return {
            total: this.sessions.size,
            active: this.stats.activeSessions,
            expired: this.stats.expiredSessions,
            createdToday: createdToday,
            byStatus: byStatus,
            byMethod: byMethod,
            storage: {
                directory: this.sessionDir,
                sessionCount: this.sessions.size,
                cacheSize: this.cache.keys().length
            },
            system: this.stats
        };
    }

    // Backup and restore methods
    async createBackup() {
        try {
            const backupId = `backup_${Date.now()}`;
            const backupDir = path.join(__dirname, '../../backups', backupId);
            await fs.ensureDir(backupDir);
            
            // Copy all session directories
            const sessions = Array.from(this.sessions.values());
            const backupData = {
                timestamp: new Date().toISOString(),
                sessionCount: sessions.length,
                sessions: sessions
            };
            
            // Save metadata
            const metadataPath = path.join(backupDir, 'metadata.json');
            await fs.writeJson(metadataPath, backupData, { spaces: 2 });
            
            // Copy session files
            for (const session of sessions) {
                const sourceDir = path.join(this.sessionDir, session.id);
                const targetDir = path.join(backupDir, 'sessions', session.id);
                
                if (await fs.pathExists(sourceDir)) {
                    await fs.copy(sourceDir, targetDir);
                }
            }
            
            console.log(`💾 Created backup: ${backupId}`);
            
            return {
                success: true,
                backupId: backupId,
                path: backupDir,
                size: await this.getDirectorySize(backupDir)
            };
            
        } catch (error) {
            console.error('Error creating backup:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    async restoreBackup(backupPath) {
        try {
            const metadataPath = path.join(backupPath, 'metadata.json');
            
            if (!await fs.pathExists(metadataPath)) {
                throw new Error('Backup metadata not found');
            }
            
            const metadata = await fs.readJson(metadataPath);
            
            // Restore sessions
            for (const session of metadata.sessions) {
                const sourceDir = path.join(backupPath, 'sessions', session.id);
                const targetDir = path.join(this.sessionDir, session.id);
                
                if (await fs.pathExists(sourceDir)) {
                    await fs.copy(sourceDir, targetDir);
                    this.sessions.set(session.id, session);
                }
            }
            
            console.log(`🔄 Restored backup with ${metadata.sessions.length} sessions`);
            
            return {
                success: true,
                restored: metadata.sessions.length
            };
            
        } catch (error) {
            console.error('Error restoring backup:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    async getDirectorySize(dirPath) {
        try {
            const files = await fs.readdir(dirPath);
            let totalSize = 0;
            
            for (const file of files) {
                const filePath = path.join(dirPath, file);
                const stats = await fs.stat(filePath);
                
                if (stats.isDirectory()) {
                    totalSize += await this.getDirectorySize(filePath);
                } else {
                    totalSize += stats.size;
                }
            }
            
            return totalSize;
        } catch (error) {
            return 0;
        }
    }

    // Utility methods
    validatePhoneNumber(phone) {
        const phoneRegex = /^\+?[1-9]\d{1,14}$/;
        return phoneRegex.test(phone);
    }

    generateSessionName(phone) {
        const date = new Date();
        const timestamp = date.toISOString().replace(/[:.]/g, '-');
        return `WhatsApp_${phone}_${timestamp}`;
    }

    // WebSocket broadcast for real-time updates
    broadcastUpdate(type, data) {
        // This would integrate with WebSocket server
        // For now, we'll just log it
        console.log(`📡 Broadcast: ${type}`, data);
    }
}

module.exports = SessionManager;
