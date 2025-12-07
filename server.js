require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs-extra');
const cluster = require('cluster');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

// Import custom modules
const WhatsAppService = require('./src/whatsapp/whatsapp-service');
const SessionManager = require('./src/whatsapp/session-manager');
const PairingStrategies = require('./src/whatsapp/pairing-strategies');
const FallbackHandler = require('./src/whatsapp/fallback-handler');
const BackupSystem = require('./src/utils/backup-system');
const logger = require('./src/utils/logger');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable clustering for production
if (cluster.isMaster && process.env.NODE_ENV === 'production') {
    const numCPUs = os.cpus().length;
    console.log(`🚀 Master ${process.pid} is running`);
    
    // Fork workers
    for (let i = 0; i < numCPUs; i++) {
        cluster.fork();
    }
    
    cluster.on('exit', (worker, code, signal) => {
        console.log(`⚠️ Worker ${worker.process.pid} died. Forking new worker...`);
        cluster.fork();
    });
} else {
    // Initialize services
    const whatsappService = new WhatsAppService();
    const sessionManager = new SessionManager();
    const pairingStrategies = new PairingStrategies();
    const fallbackHandler = new FallbackHandler();
    const backupSystem = new BackupSystem();

    // Ensure directories exist
    const directories = [
        'sessions',
        'logs',
        'backups',
        'public/uploads',
        'public/assets'
    ];

    directories.forEach(dir => {
        fs.ensureDirSync(dir);
    });

    // Middleware
    app.use(cors({
        origin: process.env.CORS_ORIGIN || '*',
        credentials: true
    }));

    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
                scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdnjs.cloudflare.com"],
                fontSrc: ["'self'", "https://fonts.gstatic.com"],
                imgSrc: ["'self'", "data:", "https:"]
            }
        }
    }));

    app.use(compression());
    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Rate limiting
    const apiLimiter = rateLimit({
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 100,
        message: 'Too many requests from this IP, please try again later.'
    });

    const authLimiter = rateLimit({
        windowMs: 60 * 60 * 1000, // 1 hour
        max: 5,
        message: 'Too many login attempts, please try again later.'
    });

    // Logging
    app.use(morgan('combined', {
        stream: {
            write: message => logger.info(message.trim())
        }
    }));

    // Static files
    app.use(express.static('public'));
    app.use('/assets', express.static('public/assets'));

    // Health check endpoint
    app.get('/health', (req, res) => {
        res.json({
            status: 'OK',
            timestamp: new Date().toISOString(),
            version: '4.0.0',
            worker: process.pid,
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            services: {
                whatsapp: whatsappService.isConnected() ? 'connected' : 'disconnected',
                sessions: sessionManager.getStats(),
                pairing: pairingStrategies.getStatus(),
                fallbacks: fallbackHandler.getStatus()
            }
        });
    });

    // Generate new session
    app.post('/api/v1/generate', apiLimiter, async (req, res) => {
        try {
            const { phone, sessionName, securityLevel = 'high', method = 'code' } = req.body;
            
            // Validate input
            if (!phone) {
                return res.status(400).json({
                    success: false,
                    error: 'PHONE_REQUIRED',
                    message: 'Phone number is required'
                });
            }

            // Validate phone format
            const phoneRegex = /^\+?[1-9]\d{1,14}$/;
            if (!phoneRegex.test(phone)) {
                return res.status(400).json({
                    success: false,
                    error: 'INVALID_PHONE',
                    message: 'Invalid phone number format'
                });
            }

            // Generate session ID
            const sessionId = `WA_${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
            
            // Create session data
            const sessionData = {
                id: sessionId,
                name: sessionName || 'Abdullah-Md-Session',
                phone: phone,
                security: securityLevel,
                method: method,
                createdAt: new Date(),
                expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
                status: 'pending'
            };

            // Store session
            sessionManager.createSession(sessionData);

            // Generate pairing code using selected method
            let pairingResult;
            try {
                pairingResult = await pairingStrategies.generatePairingCode(
                    phone, 
                    sessionId, 
                    method
                );
            } catch (error) {
                // Try fallback method
                pairingResult = await fallbackHandler.tryFallbackMethod(
                    phone,
                    sessionId,
                    method
                );
            }

            // Log activity
            logger.info(`Session generated: ${sessionId} for ${phone}`, {
                sessionId,
                phone,
                method
            });

            res.json({
                success: true,
                session: sessionData,
                pairing: pairingResult,
                instructions: pairingStrategies.getInstructions(method),
                fallbacks: fallbackHandler.getAvailableFallbacks()
            });

        } catch (error) {
            logger.error('Session generation error:', error);
            res.status(500).json({
                success: false,
                error: 'GENERATION_FAILED',
                message: 'Failed to generate session'
            });
        }
    });

    // Verify pairing code
    app.post('/api/v1/verify', apiLimiter, async (req, res) => {
        try {
            const { sessionId, pairingCode, method = 'code' } = req.body;
            
            if (!sessionId || !pairingCode) {
                return res.status(400).json({
                    success: false,
                    error: 'INVALID_INPUT',
                    message: 'Session ID and pairing code are required'
                });
            }

            // Get session
            const session = sessionManager.getSession(sessionId);
            if (!session) {
                return res.status(404).json({
                    success: false,
                    error: 'SESSION_NOT_FOUND',
                    message: 'Session not found'
                });
            }

            // Verify pairing code
            const verification = await pairingStrategies.verifyPairingCode(
                sessionId,
                pairingCode,
                method
            );

            if (!verification.success) {
                // Try fallback verification
                const fallbackVerification = await fallbackHandler.verifyFallback(
                    sessionId,
                    pairingCode,
                    method
                );
                
                if (!fallbackVerification.success) {
                    return res.status(400).json({
                        success: false,
                        error: 'INVALID_CODE',
                        message: 'Invalid pairing code'
                    });
                }
            }

            // Connect to WhatsApp
            const connection = await whatsappService.connectSession(
                sessionId,
                session.phone
            );

            if (!connection.success) {
                return res.status(500).json({
                    success: false,
                    error: 'CONNECTION_FAILED',
                    message: 'Failed to connect to WhatsApp'
                });
            }

            // Update session status
            session.status = 'active';
            session.connectedAt = new Date();
            sessionManager.updateSession(sessionId, session);

            // Create session files
            const sessionFiles = await whatsappService.createSessionFiles(sessionId);

            logger.info(`Session verified: ${sessionId}`, {
                sessionId,
                phone: session.phone
            });

            res.json({
                success: true,
                session: session,
                connection: connection,
                files: sessionFiles,
                credentials: {
                    sessionId: sessionId,
                    phone: session.phone,
                    authInfo: 'Stored in session files'
                }
            });

        } catch (error) {
            logger.error('Verification error:', error);
            res.status(500).json({
                success: false,
                error: 'VERIFICATION_FAILED',
                message: 'Failed to verify pairing code'
            });
        }
    });

    // Get session details
    app.get('/api/v1/session/:id', async (req, res) => {
        try {
            const session = sessionManager.getSession(req.params.id);
            
            if (!session) {
                return res.status(404).json({
                    success: false,
                    error: 'SESSION_NOT_FOUND',
                    message: 'Session not found'
                });
            }

            const connection = whatsappService.getConnection(req.params.id);
            const stats = whatsappService.getSessionStats(req.params.id);

            res.json({
                success: true,
                session: session,
                connection: connection,
                stats: stats,
                files: await whatsappService.getSessionFiles(req.params.id)
            });

        } catch (error) {
            logger.error('Get session error:', error);
            res.status(500).json({
                success: false,
                error: 'FETCH_FAILED',
                message: 'Failed to get session details'
            });
        }
    });

    // Get all sessions
    app.get('/api/v1/sessions', async (req, res) => {
        try {
            const sessions = sessionManager.getAllSessions();
            const stats = sessionManager.getStats();
            
            const enrichedSessions = await Promise.all(
                sessions.map(async session => ({
                    ...session,
                    connection: whatsappService.getConnection(session.id),
                    files: await whatsappService.getSessionFiles(session.id)
                }))
            );

            res.json({
                success: true,
                count: sessions.length,
                stats: stats,
                sessions: enrichedSessions
            });

        } catch (error) {
            logger.error('Get sessions error:', error);
            res.status(500).json({
                success: false,
                error: 'FETCH_FAILED',
                message: 'Failed to get sessions'
            });
        }
    });

    // Delete session
    app.delete('/api/v1/session/:id', async (req, res) => {
        try {
            const sessionId = req.params.id;
            
            // Disconnect from WhatsApp
            await whatsappService.disconnectSession(sessionId);
            
            // Delete session data
            const deleted = sessionManager.deleteSession(sessionId);
            
            // Delete session files
            await whatsappService.deleteSessionFiles(sessionId);

            logger.info(`Session deleted: ${sessionId}`);

            res.json({
                success: true,
                message: 'Session deleted successfully'
            });

        } catch (error) {
            logger.error('Delete session error:', error);
            res.status(500).json({
                success: false,
                error: 'DELETE_FAILED',
                message: 'Failed to delete session'
            });
        }
    });

    // Test session connection
    app.post('/api/v1/session/:id/test', async (req, res) => {
        try {
            const sessionId = req.params.id;
            const session = sessionManager.getSession(sessionId);
            
            if (!session) {
                return res.status(404).json({
                    success: false,
                    error: 'SESSION_NOT_FOUND',
                    message: 'Session not found'
                });
            }

            const testResult = await whatsappService.testConnection(sessionId);
            
            res.json({
                success: testResult.success,
                message: testResult.message,
                data: testResult.data
            });

        } catch (error) {
            logger.error('Test connection error:', error);
            res.status(500).json({
                success: false,
                error: 'TEST_FAILED',
                message: 'Failed to test connection'
            });
        }
    });

    // Download session files
    app.get('/api/v1/session/:id/download', async (req, res) => {
        try {
            const sessionId = req.params.id;
            const format = req.query.format || 'zip';
            
            const session = sessionManager.getSession(sessionId);
            if (!session) {
                return res.status(404).json({
                    success: false,
                    error: 'SESSION_NOT_FOUND',
                    message: 'Session not found'
                });
            }

            const downloadPath = await whatsappService.packageSessionFiles(
                sessionId, 
                format
            );

            res.download(downloadPath, `whatsapp-session-${sessionId}.${format}`, (err) => {
                if (err) {
                    logger.error('Download error:', err);
                }
                // Cleanup temporary file
                fs.unlink(downloadPath).catch(() => {});
            });

        } catch (error) {
            logger.error('Download error:', error);
            res.status(500).json({
                success: false,
                error: 'DOWNLOAD_FAILED',
                message: 'Failed to download session files'
            });
        }
    });

    // Get available pairing methods
    app.get('/api/v1/pairing-methods', (req, res) => {
        try {
            const methods = pairingStrategies.getAvailableMethods();
            const fallbacks = fallbackHandler.getAvailableFallbacks();
            
            res.json({
                success: true,
                methods: methods,
                fallbacks: fallbacks,
                recommendations: pairingStrategies.getRecommendations()
            });

        } catch (error) {
            logger.error('Get methods error:', error);
            res.status(500).json({
                success: false,
                error: 'FETCH_FAILED',
                message: 'Failed to get pairing methods'
            });
        }
    });

    // Backup sessions
    app.post('/api/v1/backup', async (req, res) => {
        try {
            const { password } = req.body;
            
            const backupResult = await backupSystem.createBackup(password);
            
            res.json({
                success: true,
                backup: backupResult,
                message: 'Backup created successfully'
            });

        } catch (error) {
            logger.error('Backup error:', error);
            res.status(500).json({
                success: false,
                error: 'BACKUP_FAILED',
                message: 'Failed to create backup'
            });
        }
    });

    // Restore from backup
    app.post('/api/v1/restore', async (req, res) => {
        try {
            const { backupId, password } = req.body;
            
            if (!req.files || !req.files.backupFile) {
                return res.status(400).json({
                    success: false,
                    error: 'NO_FILE',
                    message: 'Backup file is required'
                });
            }

            const restoreResult = await backupSystem.restoreBackup(
                req.files.backupFile,
                password
            );

            res.json({
                success: true,
                restore: restoreResult,
                message: 'Backup restored successfully'
            });

        } catch (error) {
            logger.error('Restore error:', error);
            res.status(500).json({
                success: false,
                error: 'RESTORE_FAILED',
                message: 'Failed to restore backup'
            });
        }
    });

    // System statistics
    app.get('/api/v1/stats', (req, res) => {
        try {
            const stats = {
                system: {
                    uptime: process.uptime(),
                    memory: process.memoryUsage(),
                    cpu: process.cpuUsage(),
                    platform: process.platform,
                    version: process.version
                },
                whatsapp: whatsappService.getStats(),
                sessions: sessionManager.getStats(),
                pairing: pairingStrategies.getStats(),
                fallbacks: fallbackHandler.getStats(),
                storage: {
                    sessions: whatsappService.getStorageStats(),
                    backups: backupSystem.getStats()
                }
            };

            res.json({
                success: true,
                stats: stats,
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            logger.error('Stats error:', error);
            res.status(500).json({
                success: false,
                error: 'STATS_FAILED',
                message: 'Failed to get system statistics'
            });
        }
    });

    // WebSocket for real-time updates
    const WebSocket = require('ws');
    const wss = new WebSocket.Server({ noServer: true });

    wss.on('connection', (ws) => {
        logger.info('WebSocket client connected');
        
        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                
                switch(data.type) {
                    case 'subscribe':
                        // Subscribe to session updates
                        break;
                    case 'ping':
                        ws.send(JSON.stringify({ type: 'pong' }));
                        break;
                }
            } catch (error) {
                logger.error('WebSocket message error:', error);
            }
        });

        ws.on('close', () => {
            logger.info('WebSocket client disconnected');
        });
    });

    // Broadcast function
    function broadcast(data) {
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(data));
            }
        });
    }

    // HTTP upgrade for WebSocket
    const server = app.listen(PORT, () => {
        console.log(`🚀 Worker ${process.pid} running on port ${PORT}`);
        console.log(`📱 WhatsApp Session Generator v4.0`);
        console.log(`🔗 http://localhost:${PORT}`);
        console.log(`📊 Health: http://localhost:${PORT}/health`);
        
        // Start periodic tasks
        startPeriodicTasks();
    });

    server.on('upgrade', (request, socket, head) => {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    });

    // Periodic tasks
    function startPeriodicTasks() {
        // Cleanup expired sessions every hour
        setInterval(async () => {
            try {
                const cleaned = await sessionManager.cleanupExpiredSessions();
                if (cleaned > 0) {
                    logger.info(`Cleaned up ${cleaned} expired sessions`);
                }
            } catch (error) {
                logger.error('Cleanup error:', error);
            }
        }, 60 * 60 * 1000);

        // Backup every 24 hours
        setInterval(async () => {
            try {
                await backupSystem.autoBackup();
            } catch (error) {
                logger.error('Auto backup error:', error);
            }
        }, 24 * 60 * 60 * 1000);

        // Health check every 5 minutes
        setInterval(() => {
            const health = {
                timestamp: new Date().toISOString(),
                status: 'running',
                sessions: sessionManager.getStats().total,
                memory: process.memoryUsage().heapUsed / 1024 / 1024
            };
            broadcast({ type: 'health', data: health });
        }, 5 * 60 * 1000);
    }

    // Graceful shutdown
    process.on('SIGTERM', gracefulShutdown);
    process.on('SIGINT', gracefulShutdown);

    async function gracefulShutdown() {
        console.log('🛑 Received shutdown signal');
        
        // Disconnect all WhatsApp sessions
        await whatsappService.disconnectAll();
        
        // Create final backup
        await backupSystem.createBackup('shutdown_' + Date.now());
        
        // Close server
        server.close(() => {
            console.log('✅ Server closed');
            process.exit(0);
        });

        // Force exit after 10 seconds
        setTimeout(() => {
            console.log('⚠️ Forcing shutdown');
            process.exit(1);
        }, 10000);
    }

    // Error handling middleware
    app.use((err, req, res, next) => {
        logger.error('Unhandled error:', err);
        
        res.status(500).json({
            success: false,
            error: 'INTERNAL_ERROR',
            message: 'An internal server error occurred',
            requestId: req.id
        });
    });

    // 404 handler
    app.use((req, res) => {
        res.status(404).json({
            success: false,
            error: 'NOT_FOUND',
            message: 'Endpoint not found'
        });
    });
}
