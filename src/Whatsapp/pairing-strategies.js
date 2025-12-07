const crypto = require('crypto');
const NodeCache = require('node-cache');
const twilio = require('twilio');
const nodemailer = require('nodemailer');
const axios = require('axios');

class PairingStrategies {
    constructor() {
        this.cache = new NodeCache({ 
            stdTTL: 600, // 10 minutes
            checkperiod: 60 
        });
        
        this.strategies = {
            code: {
                name: '8-Digit Code',
                description: 'Primary method using WhatsApp Web pairing code',
                enabled: true,
                priority: 1,
                requires: ['phone'],
                generates: '8-digit code',
                timeout: 600 // 10 minutes
            },
            sms: {
                name: 'SMS Code',
                description: 'Fallback method sending code via SMS',
                enabled: true,
                priority: 2,
                requires: ['phone'],
                generates: '6-digit SMS code',
                timeout: 300 // 5 minutes
            },
            call: {
                name: 'Call Verification',
                description: 'Automated call with voice code',
                enabled: true,
                priority: 3,
                requires: ['phone'],
                generates: 'voice code',
                timeout: 300
            },
            email: {
                name: 'Email Code',
                description: 'Send code to registered email',
                enabled: true,
                priority: 4,
                requires: ['email'],
                generates: 'email with code',
                timeout: 600
            },
            backup: {
                name: 'Backup Code',
                description: 'Pre-generated backup codes',
                enabled: true,
                priority: 5,
                requires: [],
                generates: 'backup code',
                timeout: 0 // No expiration
            }
        };
        
        // Initialize services if configured
        this.initServices();
        
        // Statistics
        this.stats = {
            totalAttempts: 0,
            successful: 0,
            failed: 0,
            byMethod: {},
            fallbacksUsed: 0
        };
    }

    initServices() {
        // SMS Service (Twilio)
        if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
            this.twilioClient = twilio(
                process.env.TWILIO_ACCOUNT_SID,
                process.env.TWILIO_AUTH_TOKEN
            );
        }

        // Email Service
        if (process.env.SMTP_HOST && process.env.SMTP_USER) {
            this.emailTransporter = nodemailer.createTransport({
                host: process.env.SMTP_HOST,
                port: process.env.SMTP_PORT || 587,
                secure: process.env.SMTP_SECURE === 'true',
                auth: {
                    user: process.env.SMTP_USER,
                    pass: process.env.SMTP_PASS
                }
            });
        }

        // Voice Call Service
        if (process.env.TWILIO_ACCOUNT_SID) {
            // Already initialized with Twilio
        }
    }

    async generatePairingCode(phone, sessionId, method = 'code') {
        try {
            this.stats.totalAttempts++;
            this.stats.byMethod[method] = (this.stats.byMethod[method] || 0) + 1;

            const strategy = this.strategies[method];
            if (!strategy || !strategy.enabled) {
                throw new Error(`Method ${method} is not available`);
            }

            let code;
            let result;

            switch (method) {
                case 'code':
                    result = await this.generateWhatsAppCode(phone, sessionId);
                    break;
                    
                case 'sms':
                    result = await this.generateSMSCode(phone, sessionId);
                    break;
                    
                case 'call':
                    result = await this.generateCallCode(phone, sessionId);
                    break;
                    
                case 'email':
                    // For email, we need email from session metadata
                    result = await this.generateEmailCode(phone, sessionId);
                    break;
                    
                case 'backup':
                    result = await this.generateBackupCode(sessionId);
                    break;
                    
                default:
                    throw new Error(`Unknown method: ${method}`);
            }

            // Store in cache for verification
            const cacheKey = `pairing_${sessionId}_${method}`;
            this.cache.set(cacheKey, {
                code: result.code,
                phone: phone,
                sessionId: sessionId,
                method: method,
                generatedAt: new Date(),
                expiresAt: new Date(Date.now() + (strategy.timeout * 1000))
            });

            console.log(`✅ Generated ${method} code for session ${sessionId}`);

            return {
                success: true,
                method: method,
                code: result.code,
                formattedCode: this.formatCode(result.code, method),
                expiresIn: strategy.timeout,
                instructions: this.getInstructions(method),
                alternatives: this.getAlternativeMethods(method)
            };

        } catch (error) {
            console.error(`❌ Failed to generate ${method} code:`, error);
            this.stats.failed++;
            
            // Try fallback method
            return await this.tryFallbackMethod(phone, sessionId, method);
        }
    }

    async generateWhatsAppCode(phone, sessionId) {
        // Generate 8-digit code for WhatsApp Web
        const code = crypto.randomInt(10000000, 99999999).toString();
        
        // Simulate WhatsApp code generation
        // In real implementation, this would interface with WhatsApp Web
        
        return {
            code: code,
            type: 'whatsapp_code',
            note: 'Enter this code in WhatsApp Web → Linked Devices'
        };
    }

    async generateSMSCode(phone, sessionId) {
        if (!this.twilioClient) {
            throw new Error('SMS service not configured');
        }

        // Generate 6-digit code
        const code = crypto.randomInt(100000, 999999).toString();

        try {
            // Send SMS via Twilio
            await this.twilioClient.messages.create({
                body: `Your WhatsApp pairing code is: ${code}. This code expires in 5 minutes.`,
                from: process.env.TWILIO_PHONE_NUMBER,
                to: phone
            });

            return {
                code: code,
                type: 'sms_code',
                note: 'Code sent via SMS'
            };

        } catch (error) {
            console.error('SMS sending failed:', error);
            throw new Error('Failed to send SMS');
        }
    }

    async generateCallCode(phone, sessionId) {
        if (!this.twilioClient) {
            throw new Error('Call service not configured');
        }

        const code = crypto.randomInt(100000, 999999).toString();
        const digits = code.split('').join(' ');

        try {
            // Make voice call with code
            await this.twilioClient.calls.create({
                twiml: `<Response>
                    <Say voice="alice" language="en-US">
                        Your WhatsApp pairing code is: ${digits}. 
                        I repeat: ${digits}.
                        This code expires in 5 minutes.
                    </Say>
                    <Pause length="2"/>
                    <Say voice="alice" language="en-US">
                        Your code is: ${digits}
                    </Say>
                </Response>`,
                to: phone,
                from: process.env.TWILIO_PHONE_NUMBER
            });

            return {
                code: code,
                type: 'call_code',
                note: 'Code delivered via voice call'
            };

        } catch (error) {
            console.error('Call failed:', error);
            throw new Error('Failed to make call');
        }
    }

    async generateEmailCode(phone, sessionId) {
        if (!this.emailTransporter) {
            throw new Error('Email service not configured');
        }

        const code = crypto.randomInt(100000, 999999).toString();

        try {
            // Get email from session metadata (in real app, this would come from DB)
            const email = this.getEmailForSession(sessionId);
            
            if (!email) {
                throw new Error('No email registered for this session');
            }

            await this.emailTransporter.sendMail({
                from: process.env.SMTP_FROM || 'whatsapp@abdullah-md.com',
                to: email,
                subject: 'Your WhatsApp Pairing Code',
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                        <h2>WhatsApp Pairing Code</h2>
                        <p>Your pairing code for WhatsApp session <strong>${sessionId}</strong> is:</p>
                        <div style="background: #f4f4f4; padding: 20px; text-align: center; font-size: 32px; letter-spacing: 5px; margin: 20px 0;">
                            <strong>${code}</strong>
                        </div>
                        <p>Enter this code in WhatsApp Web to link your device.</p>
                        <p>This code expires in 10 minutes.</p>
                        <hr>
                        <p style="color: #666; font-size: 12px;">
                            If you didn't request this code, please ignore this email.
                        </p>
                    </div>
                `
            });

            return {
                code: code,
                type: 'email_code',
                note: 'Code sent via email'
            };

        } catch (error) {
            console.error('Email sending failed:', error);
            throw new Error('Failed to send email');
        }
    }

    async generateBackupCode(sessionId) {
        // Generate a longer backup code (12 digits)
        const code = crypto.randomBytes(6).toString('hex').toUpperCase();

        // Store backup code in persistent storage
        await this.storeBackupCode(sessionId, code);

        return {
            code: code,
            type: 'backup_code',
            note: 'Backup code - use if other methods fail',
            permanent: true
        };
    }

    async verifyPairingCode(sessionId, code, method = 'code') {
        try {
            const cacheKey = `pairing_${sessionId}_${method}`;
            const pairingData = this.cache.get(cacheKey);

            if (!pairingData) {
                return {
                    success: false,
                    error: 'CODE_EXPIRED',
                    message: 'Pairing code has expired'
                };
            }

            // Normalize code for comparison
            const normalizedInput = code.replace(/\D/g, '');
            const normalizedStored = pairingData.code.replace(/\D/g, '');

            if (normalizedInput !== normalizedStored) {
                this.stats.failed++;
                
                return {
                    success: false,
                    error: 'INVALID_CODE',
                    message: 'Invalid pairing code',
                    attemptsLeft: this.getAttemptsLeft(sessionId, method)
                };
            }

            // Code is valid
            this.cache.del(cacheKey); // Remove used code
            this.stats.successful++;

            console.log(`✅ Verified ${method} code for session ${sessionId}`);

            return {
                success: true,
                message: 'Code verified successfully',
                method: method,
                sessionId: sessionId,
                phone: pairingData.phone
            };

        } catch (error) {
            console.error('Verification error:', error);
            
            return {
                success: false,
                error: 'VERIFICATION_FAILED',
                message: 'Failed to verify code'
            };
        }
    }

    async tryFallbackMethod(phone, sessionId, failedMethod) {
        try {
            this.stats.fallbacksUsed++;
            
            // Get alternative methods ordered by priority
            const alternatives = this.getAlternativeMethods(failedMethod);
            
            for (const method of alternatives) {
                if (method === failedMethod) continue;
                
                console.log(`🔄 Trying fallback method: ${method}`);
                
                try {
                    const result = await this.generatePairingCode(phone, sessionId, method);
                    
                    if (result.success) {
                        console.log(`✅ Fallback ${method} succeeded for session ${sessionId}`);
                        
                        return {
                            ...result,
                            fallback: true,
                            originalMethod: failedMethod
                        };
                    }
                } catch (fallbackError) {
                    console.error(`Fallback ${method} failed:`, fallbackError);
                    continue; // Try next fallback
                }
            }
            
            // All fallbacks failed
            throw new Error('All pairing methods failed');
            
        } catch (error) {
            console.error('All fallback methods failed:', error);
            
            return {
                success: false,
                error: 'ALL_METHODS_FAILED',
                message: 'All pairing methods have failed',
                originalMethod: failedMethod,
                triedFallbacks: this.getAlternativeMethods(failedMethod)
            };
        }
    }

    getAlternativeMethods(currentMethod) {
        // Return alternative methods ordered by priority
        return Object.entries(this.strategies)
            .filter(([method, config]) => 
                method !== currentMethod && 
                config.enabled && 
                config.priority > this.strategies[currentMethod]?.priority
            )
            .sort((a, b) => a[1].priority - b[1].priority)
            .map(([method]) => method);
    }

    getInstructions(method) {
        const instructions = {
            code: [
                'Open WhatsApp on your phone',
                'Tap Menu → Linked Devices',
                'Tap "Link a Device"',
                'Enter the 8-digit code shown above',
                'Tap "Link" to complete pairing'
            ],
            sms: [
                'Check your SMS messages',
                'Find the message with your 6-digit code',
                'Enter the code in the verification field',
                'Submit to complete pairing'
            ],
            call: [
                'Answer the incoming call',
                'Listen carefully to the code',
                'Enter the code in the verification field',
                'Submit to complete pairing'
            ],
            email: [
                'Check your email inbox',
                'Find the email with subject "WhatsApp Pairing Code"',
                'Copy the 6-digit code from the email',
                'Enter the code in the verification field',
                'Submit to complete pairing'
            ],
            backup: [
                'Use your pre-generated backup code',
                'Enter the 12-character code',
                'Submit to complete pairing'
            ]
        };

        return instructions[method] || instructions.code;
    }

    formatCode(code, method) {
        switch (method) {
            case 'code':
                // Format as 1234-5678
                return code.replace(/(\d{4})(\d{4})/, '$1-$2');
                
            case 'sms':
            case 'call':
            case 'email':
                // Format as 123-456
                return code.replace(/(\d{3})(\d{3})/, '$1-$2');
                
            case 'backup':
                // Format as ABCD-EF12-3456
                return code.match(/.{1,4}/g).join('-');
                
            default:
                return code;
        }
    }

    getAttemptsLeft(sessionId, method) {
        const cacheKey = `attempts_${sessionId}_${method}`;
        const attempts = this.cache.get(cacheKey) || 0;
        
        const maxAttempts = 3;
        const attemptsLeft = maxAttempts - attempts;
        
        if (attemptsLeft > 0) {
            this.cache.set(cacheKey, attempts + 1, 600);
        }
        
        return Math.max(0, attemptsLeft);
    }

    getAvailableMethods() {
        return Object.entries(this.strategies)
            .filter(([_, config]) => config.enabled)
            .map(([method, config]) => ({
                id: method,
                name: config.name,
                description: config.description,
                priority: config.priority,
                requirements: config.requires,
                timeout: config.timeout
            }))
            .sort((a, b) => a.priority - b.priority);
    }

    getRecommendations() {
        const methods = this.getAvailableMethods();
        
        return {
            primary: methods[0],
            fallbacks: methods.slice(1),
            bestFor: {
                speed: methods.find(m => m.id === 'code'),
                reliability: methods.find(m => m.id === 'sms'),
                security: methods.find(m => m.id === 'email')
            }
        };
    }

    getStatus() {
        const methods = this.getAvailableMethods();
        
        return {
            availableMethods: methods.length,
            enabledMethods: methods.map(m => m.id),
            stats: this.stats,
            cache: {
                size: this.cache.keys().length,
                hits: this.cache.getStats().hits,
                misses: this.cache.getStats().misses
            }
        };
    }

    // Utility methods (would be implemented in real app)
    getEmailForSession(sessionId) {
        // In real implementation, get email from database
        return process.env.DEFAULT_EMAIL;
    }

    async storeBackupCode(sessionId, code) {
        // In real implementation, store in database
        const backupKey = `backup_${sessionId}`;
        this.cache.set(backupKey, code, 0); // No expiration
    }

    async validatePhoneNumber(phone) {
        // Basic validation
        const phoneRegex = /^\+?[1-9]\d{1,14}$/;
        return phoneRegex.test(phone);
    }

    // Rate limiting
    canAttemptPairing(phone, method) {
        const rateKey = `rate_${phone}_${method}`;
        const attempts = this.cache.get(rateKey) || 0;
        
        if (attempts >= 5) {
            const ttl = this.cache.getTtl(rateKey);
            const timeLeft = Math.ceil((ttl - Date.now()) / 1000 / 60);
            
            return {
                allowed: false,
                reason: 'RATE_LIMITED',
                retryAfter: timeLeft,
                message: `Too many attempts. Try again in ${timeLeft} minutes.`
            };
        }
        
        this.cache.set(rateKey, attempts + 1, 300); // 5 minutes
        return { allowed: true };
    }

    resetRateLimit(phone, method) {
        const rateKey = `rate_${phone}_${method}`;
        this.cache.del(rateKey);
    }
}

module.exports = PairingStrategies;
