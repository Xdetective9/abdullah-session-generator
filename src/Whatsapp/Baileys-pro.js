const { 
    default: makeWASocket, 
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    proto
} = require('@whiskeysockets/baileys');
const P = require('pino');
const fs = require('fs-extra');
const path = require('path');
const NodeCache = require('node-cache');
const WebSocket = require('ws');

class BaileysPro {
    constructor(options = {}) {
        this.options = {
            sessionId: options.sessionId || 'default',
            phoneNumber: options.phoneNumber,
            logger: P({ level: options.logLevel || 'silent' }),
            browser: ['Abdullah-Md Pro', 'Chrome', '121.0.0.0'],
            version: options.version || [2, 2413, 1],
            syncFullHistory: false,
            generateHighQualityLinkPreview: true,
            emitOwnEvents: true,
            defaultQueryTimeoutMs: 0,
            maxRetries: 3,
            retryDelay: 5000,
            ...options
        };

        this.sessionId = this.options.sessionId;
        this.phoneNumber = this.options.phoneNumber;
        this.sock = null;
        this.state = null;
        this.saveCreds = null;
        this.isConnecting = false;
        this.isConnected = false;
        this.retryCount = 0;
        
        // Cache for messages and contacts
        this.cache = new NodeCache({ 
            stdTTL: 300,
            checkperiod: 60 
        });
        
        // Event listeners
        this.listeners = new Map();
        
        // Connection stats
        this.stats = {
            connectedAt: null,
            disconnectedAt: null,
            messagesSent: 0,
            messagesReceived: 0,
            reconnects: 0,
            errors: 0
        };
    }

    async initialize() {
        try {
            console.log(`🔄 Initializing BaileysPro for session: ${this.sessionId}`);
            
            // Create session directory
            const sessionDir = path.join(__dirname, '../../sessions', this.sessionId);
            await fs.ensureDir(sessionDir);
            
            // Load or create auth state
            const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
            this.state = state;
            this.saveCreds = saveCreds;
            
            // Fetch latest version if needed
            const { version, isLatest } = await fetchLatestBaileysVersion();
            if (!isLatest) {
                console.log(`📦 Using WhatsApp Web version: ${version.join('.')}`);
                this.options.version = version;
            }
            
            // Create socket
            this.sock = makeWASocket({
                ...this.options,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, this.options.logger)
                }
            });
            
            // Setup event handlers
            this.setupEventHandlers();
            
            console.log(`✅ BaileysPro initialized for ${this.phoneNumber}`);
            return { success: true, sessionId: this.sessionId };
            
        } catch (error) {
            console.error('❌ BaileysPro initialization failed:', error);
            throw error;
        }
    }

    setupEventHandlers() {
        if (!this.sock) return;

        // Connection updates
        this.sock.ev.on('connection.update', (update) => {
            this.handleConnectionUpdate(update);
        });

        // Credentials update
        this.sock.ev.on('creds.update', () => {
            if (this.saveCreds) {
                this.saveCreds();
            }
        });

        // Messages
        this.sock.ev.on('messages.upsert', (m) => {
            this.handleMessagesUpsert(m);
        });

        // Message updates (acknowledgments, etc.)
        this.sock.ev.on('messages.update', (m) => {
            this.handleMessagesUpdate(m);
        });

        // Contacts update
        this.sock.ev.on('contacts.update', (updates) => {
            this.handleContactsUpdate(updates);
        });

        // Chats update
        this.sock.ev.on('chats.update', (updates) => {
            this.handleChatsUpdate(updates);
        });

        // Presence update
        this.sock.ev.on('presence.update', (update) => {
            this.handlePresenceUpdate(update);
        });

        // Groups update
        this.sock.ev.on('groups.update', (updates) => {
            this.handleGroupsUpdate(updates);
        });
    }

    handleConnectionUpdate(update) {
        const { connection, lastDisconnect } = update;
        
        console.log(`🔌 Connection update: ${connection}`);
        
        if (connection === 'open') {
            this.isConnected = true;
            this.isConnecting = false;
            this.retryCount = 0;
            this.stats.connectedAt = new Date();
            this.stats.reconnects++;
            
            console.log(`✅ WhatsApp connected successfully!`);
            this.emit('connected', {
                sessionId: this.sessionId,
                phoneNumber: this.phoneNumber,
                timestamp: new Date()
            });
        }
        
        if (connection === 'close') {
            this.isConnected = false;
            this.stats.disconnectedAt = new Date();
            
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(`🔌 Connection closed. Status: ${statusCode}, Should reconnect: ${shouldReconnect}`);
            
            if (shouldReconnect && this.retryCount < this.options.maxRetries) {
                this.retryCount++;
                console.log(`🔄 Attempting reconnect ${this.retryCount}/${this.options.maxRetries}...`);
                
                setTimeout(() => {
                    this.reconnect();
                }, this.options.retryDelay);
            } else if (statusCode === DisconnectReason.loggedOut) {
                console.log(`🚫 Logged out from WhatsApp`);
                this.emit('loggedOut', {
                    sessionId: this.sessionId,
                    reason: 'logged_out'
                });
            }
            
            this.emit('disconnected', {
                sessionId: this.sessionId,
                reason: lastDisconnect?.error?.message,
                statusCode: statusCode
            });
        }
        
        if (connection === 'connecting') {
            this.isConnecting = true;
            console.log(`🔄 Connecting to WhatsApp...`);
        }
    }

    handleMessagesUpsert(m) {
        const { messages, type } = m;
        
        messages.forEach(message => {
            // Skip if message is from the bot itself
            if (message.key.fromMe) return;
            
            this.stats.messagesReceived++;
            
            // Cache message
            const messageId = message.key.id;
            this.cache.set(`message_${messageId}`, message, 3600);
            
            console.log(`📨 New message from ${message.key.remoteJid}: ${message.message?.conversation || '[media]'}`);
            
            this.emit('message', {
                sessionId: this.sessionId,
                message: message,
                type: type
            });
        });
    }

    handleMessagesUpdate(m) {
        m.forEach(update => {
            if (update.update) {
                const messageId = update.key.id;
                const cached = this.cache.get(`message_${messageId}`);
                
                if (cached) {
                    // Update cached message
                    Object.assign(cached, update.update);
                    this.cache.set(`message_${messageId}`, cached);
                    
                    this.emit('messageUpdate', {
                        sessionId: this.sessionId,
                        messageId: messageId,
                        update: update.update
                    });
                }
            }
        });
    }

    handleContactsUpdate(updates) {
        updates.forEach(update => {
            this.emit('contactUpdate', {
                sessionId: this.sessionId,
                contact: update
            });
        });
    }

    handleChatsUpdate(updates) {
        updates.forEach(update => {
            this.emit('chatUpdate', {
                sessionId: this.sessionId,
                chat: update
            });
        });
    }

    handlePresenceUpdate(update) {
        this.emit('presenceUpdate', {
            sessionId: this.sessionId,
            presence: update
        });
    }

    handleGroupsUpdate(updates) {
        updates.forEach(update => {
            this.emit('groupUpdate', {
                sessionId: this.sessionId,
                group: update
            });
        });
    }

    async reconnect() {
        try {
            if (this.isConnecting) return;
            
            console.log(`🔄 Reconnecting BaileysPro...`);
            await this.disconnect();
            await this.initialize();
            
        } catch (error) {
            console.error('❌ Reconnection failed:', error);
            this.stats.errors++;
        }
    }

    async disconnect() {
        try {
            if (this.sock) {
                await this.sock.logout();
                this.sock = null;
            }
            
            this.isConnected = false;
            this.isConnecting = false;
            
            console.log(`✅ Disconnected BaileysPro`);
            
        } catch (error) {
            console.error('❌ Disconnect failed:', error);
        }
    }

    async sendMessage(to, content, options = {}) {
        try {
            if (!this.isConnected) {
                throw new Error('Not connected to WhatsApp');
            }
            
            let message;
            
            // Handle different content types
            if (typeof content === 'string') {
                // Text message
                message = { text: content };
            } else if (content.image) {
                // Image message
                message = {
                    image: { url: content.image },
                    caption: content.caption,
                    mimetype: content.mimetype
                };
            } else if (content.document) {
                // Document message
                message = {
                    document: { url: content.document },
                    mimetype: content.mimetype,
                    fileName: content.fileName
                };
            } else if (content.audio) {
                // Audio message
                message = {
                    audio: { url: content.audio },
                    mimetype: content.mimetype
                };
            } else if (content.video) {
                // Video message
                message = {
                    video: { url: content.video },
                    caption: content.caption,
                    mimetype: content.mimetype
                };
            } else if (content.sticker) {
                // Sticker message
                message = {
                    sticker: { url: content.sticker }
                };
            } else if (content.location) {
                // Location message
                message = {
                    location: content.location
                };
            } else if (content.contact) {
                // Contact message
                message = {
                    contacts: {
                        displayName: content.contact.name,
                        contacts: [{
                            displayName: content.contact.name,
                            vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${content.contact.name}\nTEL;type=CELL;type=VOICE:${content.contact.phone}\nEND:VCARD`
                        }]
                    }
                };
            }
            
            const sent = await this.sock.sendMessage(to, message, {
                quoted: options.quoted,
                mentions: options.mentions,
                ephemeralExpiration: options.expiresIn
            });
            
            this.stats.messagesSent++;
            
            this.emit('messageSent', {
                sessionId: this.sessionId,
                to: to,
                messageId: sent.key.id,
                content: content
            });
            
            return {
                success: true,
                messageId: sent.key.id,
                timestamp: new Date()
            };
            
        } catch (error) {
            console.error('❌ Send message failed:', error);
            this.stats.errors++;
            
            return {
                success: false,
                error: error.message
            };
        }
    }

    async getProfilePicture(jid) {
        try {
            const profilePic = await this.sock.profilePictureUrl(jid, 'image');
            return {
                success: true,
                url: profilePic
            };
        } catch (error) {
            return {
                success: false,
                error: 'No profile picture found'
            };
        }
    }

    async getChats(limit = 50) {
        try {
            const chats = await this.sock.fetchRecentChats(limit);
            return {
                success: true,
                chats: chats,
                count: Object.keys(chats).length
            };
        } catch (error) {
            console.error('❌ Get chats failed:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    async getContacts() {
        try {
            const contacts = await this.sock.fetchContacts();
            return {
                success: true,
                contacts: contacts,
                count: contacts.length
            };
        } catch (error) {
            console.error('❌ Get contacts failed:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    async getGroups() {
        try {
            const groups = await this.sock.groupFetchAllParticipating();
            return {
                success: true,
                groups: groups,
                count: Object.keys(groups).length
            };
        } catch (error) {
            console.error('❌ Get groups failed:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    async getStatus() {
        return {
            connected: this.isConnected,
            connecting: this.isConnecting,
            sessionId: this.sessionId,
            phoneNumber: this.phoneNumber,
            stats: this.stats,
            cache: {
                size: this.cache.keys().length,
                hits: this.cache.getStats().hits,
                misses: this.cache.getStats().misses
            }
        };
    }

    // Event emitter methods
    on(event, listener) {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, []);
        }
        this.listeners.get(event).push(listener);
    }

    off(event, listener) {
        if (this.listeners.has(event)) {
            const listeners = this.listeners.get(event);
            const index = listeners.indexOf(listener);
            if (index > -1) {
                listeners.splice(index, 1);
            }
        }
    }

    emit(event, data) {
        if (this.listeners.has(event)) {
            this.listeners.get(event).forEach(listener => {
                try {
                    listener(data);
                } catch (error) {
                    console.error(`Error in ${event} listener:`, error);
                }
            });
        }
    }

    async cleanup() {
        await this.disconnect();
        this.cache.flushAll();
        this.listeners.clear();
        
        console.log(`🧹 BaileysPro cleaned up for session: ${this.sessionId}`);
    }
}

// Export factory function for creating instances
module.exports = {
    createBaileysPro: (options) => new BaileysPro(options),
    BaileysPro
};
