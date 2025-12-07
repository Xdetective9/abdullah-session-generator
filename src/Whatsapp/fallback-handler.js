const crypto = require('crypto');
const NodeCache = require('node-cache');
const axios = require('axios');

class FallbackHandler {
    constructor() {
        this.cache = new NodeCache({ 
            stdTTL: 300,
            checkperiod: 60 
        });
        
        this.fallbacks = {
            // Primary fallbacks (automatic)
            automatic: [
                {
                    id: 'method_rotation',
                    name: 'Method Rotation',
                    description: 'Automatically try different pairing methods',
                    priority: 1,
                    enabled: true,
                    conditions: ['code_failed', 'sms_failed', 'call_failed'],
                    action: 'rotate_method'
                },
                {
                    id: 'code_regeneration',
                    name: 'Code Regeneration',
                    description: 'Generate new code if current expires',
                    priority: 2,
                    enabled: true,
                    conditions: ['code_expired'],
                    action: 'regenerate_code'
                },
                {
                    id: 'session_refresh',
                    name: 'Session Refresh',
                    description: 'Refresh session if stale',
                    priority: 3,
                    enabled: true,
                    conditions: ['session_stale', 'connection_timeout'],
                    action: 'refresh_session'
                }
            ],
            
            // Secondary fallbacks (manual trigger)
            manual: [
                {
                    id: 'backup_codes',
                    name: 'Backup Codes',
                    description: 'Use pre-generated backup codes',
                    priority: 4,
                    enabled: true,
                    requires: ['backup_code'],
                    action: 'use_backup'
                },
                {
                    id: 'alternative_auth',
                    name: 'Alternative Authentication',
                    description: 'Use email or 2FA instead',
                    priority: 5,
                    enabled: true,
                    requires: ['email_access', '2fa_enabled'],
                    action: 'alternative_auth'
                },
                {
                    id: 'support_intervention',
                    name: 'Support Intervention',
                    description: 'Contact support for manual pairing',
                    priority: 6,
                    enabled: true,
                    requires: ['support_available'],
                    action: 'contact_support'
                }
            ],
            
            // Emergency fallbacks
            emergency: [
                {
                    id: 'new_session',
                    name: 'New Session',
                    description: 'Create completely new session',
                    priority: 7,
                    enabled: true,
                    conditions: ['all_failed', 'persistent_errors'],
                    action: 'create_new_session'
                },
                {
                    id: 'device_switch',
                    name: 'Device Switch',
                    description: 'Try pairing from different device',
                    priority: 8,
                    enabled: true,
                    conditions: ['device_issues'],
                    action: 'switch_device'
                },
                {
                    id: 'time_delay',
                    name: 'Time Delay',
                    description: 'Wait and retry later',
                    priority: 9,
                    enabled: true,
                    conditions: ['rate_limited', 'server_issues'],
                    action: 'delayed_retry'
                }
            ]
        };
        
        this.stats = {
            totalFallbacks: 0,
            successfulFallbacks: 0,
            failedFallbacks: 0,
            byType: {},
            byCondition: {},
            responseTimes: []
        };
    }

    async handleFallback(sessionId, phone, error, context = {}) {
        try {
            this.stats.totalFallbacks++;
            
            console.log(`🔄 Handling fallback for session ${sessionId}: ${error}`);
            
            // Analyze error and determine appropriate fallback
            const analysis = this.analyzeError(error, context);
            
            // Select fallback strategy
            const strategy = this.selectStrategy(analysis);
            
            if (!strategy) {
                return {
                    success: false,
                    error: 'NO_FALLBACK_AVAILABLE',
                    message: 'No suitable fallback strategy found'
                };
            }
            
            // Execute fallback
            const startTime = Date.now();
            const result = await this.executeStrategy(strategy, {
                sessionId,
                phone,
                error,
                context,
                analysis
            });
            const responseTime = Date.now() - startTime;
            
            // Update statistics
            this.stats.responseTimes.push(responseTime);
            this.stats.byType[strategy.type] = (this.stats.byType[strategy.type] || 0) + 1;
            
            if (result.success) {
                this.stats.successfulFallbacks++;
                console.log(`✅ Fallback ${strategy.id} succeeded for session ${sessionId}`);
            } else {
                this.stats.failedFallbacks++;
                console.log(`❌ Fallback ${strategy.id} failed for session ${sessionId}`);
                
                // Try next fallback if available
                if (analysis.severity === 'critical') {
                    return await this.handleCriticalFallback(sessionId, phone, error, context);
                }
            }
            
            return {
                success: result.success,
                strategy: strategy,
                result: result,
                responseTime: responseTime,
                analysis: analysis
            };
            
        } catch (error) {
            console.error('Fallback handler error:', error);
            
            return {
                success: false,
                error: 'FALLBACK_HANDLER_ERROR',
                message: 'Fallback handler encountered an error'
            };
        }
    }

    analyzeError(error, context) {
        const analysis = {
            errorType: this.classifyError(error),
            severity: 'low',
            conditions: [],
            suggestions: [],
            metadata: {}
        };
        
        // Classify error type
        if (error.includes('expired') || error.includes('timeout')) {
            analysis.errorType = 'expired';
            analysis.severity = 'medium';
            analysis.conditions.push('code_expired', 'session_stale');
        }
        
        if (error.includes('invalid') || error.includes('wrong')) {
            analysis.errorType = 'invalid';
            analysis.severity = 'low';
            analysis.conditions.push('code_failed');
        }
        
        if (error.includes('rate limit') || error.includes('too many')) {
            analysis.errorType = 'rate_limited';
            analysis.severity = 'high';
            analysis.conditions.push('rate_limited');
        }
        
        if (error.includes('connection') || error.includes('network')) {
            analysis.errorType = 'network';
            analysis.severity = 'high';
            analysis.conditions.push('connection_timeout', 'server_issues');
        }
        
        if (error.includes('all methods') || error.includes('failed')) {
            analysis.errorType = 'persistent';
            analysis.severity = 'critical';
            analysis.conditions.push('all_failed', 'persistent_errors');
        }
        
        // Add context-based conditions
        if (context.attempts > 3) {
            analysis.conditions.push('multiple_attempts');
            analysis.severity = Math.max(analysis.severity, 'medium');
        }
        
        if (context.timeSinceStart > 300000) { // 5 minutes
            analysis.conditions.push('prolonged_issue');
            analysis.severity = Math.max(analysis.severity, 'high');
        }
        
        // Generate suggestions
        analysis.suggestions = this.generateSuggestions(analysis);
        
        return analysis;
    }

    selectStrategy(analysis) {
        const strategies = [];
        
        // Check automatic fallbacks
        for (const fallback of this.fallbacks.automatic) {
            if (this.matchesConditions(fallback.conditions, analysis.conditions)) {
                strategies.push({
                    ...fallback,
                    type: 'automatic',
                    priority: fallback.priority
                });
            }
        }
        
        // Check manual fallbacks if severity is high
        if (analysis.severity === 'high' || analysis.severity === 'critical') {
            for (const fallback of this.fallbacks.manual) {
                if (this.meetsRequirements(fallback.requires, analysis)) {
                    strategies.push({
                        ...fallback,
                        type: 'manual',
                        priority: fallback.priority
                    });
                }
            }
        }
        
        // Check emergency fallbacks for critical issues
        if (analysis.severity === 'critical') {
            for (const fallback of this.fallbacks.emergency) {
                if (this.matchesConditions(fallback.conditions, analysis.conditions)) {
                    strategies.push({
                        ...fallback,
                        type: 'emergency',
                        priority: fallback.priority
                    });
                }
            }
        }
        
        // Sort by priority and return the highest priority strategy
        if (strategies.length > 0) {
            strategies.sort((a, b) => a.priority - b.priority);
            return strategies[0];
        }
        
        return null;
    }

    async executeStrategy(strategy, params) {
        console.log(`🚀 Executing fallback strategy: ${strategy.name}`);
        
        switch (strategy.action) {
            case 'rotate_method':
                return await this.rotateMethod(params);
                
            case 'regenerate_code':
                return await this.regenerateCode(params);
                
            case 'refresh_session':
                return await this.refreshSession(params);
                
            case 'use_backup':
                return await this.useBackupCode(params);
                
            case 'alternative_auth':
                return await this.alternativeAuth(params);
                
            case 'contact_support':
                return await this.contactSupport(params);
                
            case 'create_new_session':
                return await this.createNewSession(params);
                
            case 'switch_device':
                return await this.switchDevice(params);
                
            case 'delayed_retry':
                return await this.delayedRetry(params);
                
            default:
                throw new Error(`Unknown strategy action: ${strategy.action}`);
        }
    }

    async rotateMethod(params) {
        const { sessionId, phone, context } = params;
        
        // Get list of available methods in order of priority
        const methods = ['sms', 'call', 'email', 'backup'];
        const currentMethod = context.method || 'code';
        
        // Find next method
        const currentIndex = methods.indexOf(currentMethod);
        const nextMethod = methods[(currentIndex + 1) % methods.length];
        
        console.log(`🔄 Rotating from ${currentMethod} to ${nextMethod}`);
        
        // Simulate method rotation (in real app, this would call pairing service)
        await this.simulateDelay(1000);
        
        return {
            success: true,
            action: 'method_rotated',
            newMethod: nextMethod,
            message: `Switched to ${nextMethod} verification`,
            instructions: this.getMethodInstructions(nextMethod)
        };
    }

    async regenerateCode(params) {
        const { sessionId, phone } = params;
        
        console.log(`🔄 Regenerating code for session ${sessionId}`);
        
        // Simulate code regeneration
        await this.simulateDelay(1500);
        
        const newCode = crypto.randomInt(100000, 999999).toString();
        
        return {
            success: true,
            action: 'code_regenerated',
            newCode: newCode,
            formattedCode: newCode.replace(/(\d{3})(\d{3})/, '$1-$2'),
            expiresIn: 300, // 5 minutes
            message: 'New code generated successfully'
        };
    }

    async refreshSession(params) {
        const { sessionId } = params;
        
        console.log(`🔄 Refreshing session ${sessionId}`);
        
        // Simulate session refresh
        await this.simulateDelay(2000);
        
        return {
            success: true,
            action: 'session_refreshed',
            sessionId: sessionId,
            newSessionId: `WA_${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
            message: 'Session refreshed successfully'
        };
    }

    async useBackupCode(params) {
        const { sessionId } = params;
        
        console.log(`🔄 Using backup code for session ${sessionId}`);
        
        // Generate backup code
        const backupCode = crypto.randomBytes(8).toString('hex').toUpperCase();
        
        return {
            success: true,
            action: 'backup_code_generated',
            backupCode: backupCode,
            formattedCode: backupCode.match(/.{1,4}/g).join('-'),
            permanent: true,
            message: 'Backup code generated. Save this code for future use.',
            warning: 'Backup codes are single-use and should be stored securely'
        };
    }

    async alternativeAuth(params) {
        const { phone } = params;
        
        console.log(`🔄 Initiating alternative authentication for ${phone}`);
        
        // This would integrate with email/2FA services
        await this.simulateDelay(2500);
        
        return {
            success: true,
            action: 'alternative_auth_initiated',
            methods: ['email_verification', '2fa_verification'],
            message: 'Alternative authentication methods available',
            instructions: [
                'Check your email for verification link',
                'Or use your 2FA app for authentication'
            ]
        };
    }

    async contactSupport(params) {
        const { sessionId, phone, error } = params;
        
        console.log(`🔄 Contacting support for session ${sessionId}`);
        
        // This would create a support ticket or connect to live support
        await this.simulateDelay(3000);
        
        const ticketId = `TICKET_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
        
        return {
            success: true,
            action: 'support_contacted',
            ticketId: ticketId,
            priority: 'high',
            estimatedResponse: '15-30 minutes',
            message: 'Support ticket created. Our team will contact you shortly.',
            instructions: [
                'Keep this ticket ID for reference: ' + ticketId,
                'Check your email for updates',
                'Support hours: 24/7'
            ]
        };
    }

    async createNewSession(params) {
        const { phone } = params;
        
        console.log(`🔄 Creating new session for ${phone}`);
        
        // Simulate new session creation
        await this.simulateDelay(4000);
        
        const newSessionId = `WA_${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
        
        return {
            success: true,
            action: 'new_session_created',
            newSessionId: newSessionId,
            message: 'New session created successfully',
            instructions: [
                'Start the pairing process again with the new session',
                'Previous session data has been preserved as backup'
            ]
        };
    }

    async switchDevice(params) {
        console.log(`🔄 Switching device strategy`);
        
        await this.simulateDelay(2000);
        
        return {
            success: true,
            action: 'device_switch_initiated',
            message: 'Try pairing from a different device',
            suggestions: [
                'Use a different phone or computer',
                'Clear browser cache and cookies',
                'Try incognito/private browsing mode',
                'Update your WhatsApp app'
            ]
        };
    }

    async delayedRetry(params) {
        const { analysis } = params;
        
        // Calculate retry delay based on severity
        let delayMinutes;
        switch (analysis.severity) {
            case 'low': delayMinutes = 1; break;
            case 'medium': delayMinutes = 5; break;
            case 'high': delayMinutes = 15; break;
            case 'critical': delayMinutes = 60; break;
            default: delayMinutes = 5;
        }
        
        console.log(`⏰ Delaying retry for ${delayMinutes} minutes`);
        
        return {
            success: true,
            action: 'delayed_retry_scheduled',
            delayMinutes: delayMinutes,
            retryTime: new Date(Date.now() + delayMinutes * 60 * 1000),
            message: `Retry scheduled in ${delayMinutes} minutes`,
            suggestions: [
                'Check your internet connection',
                'Restart your phone',
                'Update WhatsApp to latest version'
            ]
        };
    }

    async handleCriticalFallback(sessionId, phone, error, context) {
        console.log(`🚨 Handling critical fallback for session ${sessionId}`);
        
        // Emergency measures for critical failures
        const emergencyActions = [
            {
                action: 'force_new_session',
                priority: 1,
                execute: async () => this.createNewSession({ phone })
            },
            {
                action: 'support_escalation',
                priority: 2,
                execute: async () => this.contactSupport({ sessionId, phone, error })
            },
            {
                action: 'system_reset',
                priority: 3,
                execute: async () => this.systemReset({ sessionId })
            }
        ];
        
        // Try emergency actions in order
        for (const action of emergencyActions.sort((a, b) => a.priority - b.priority)) {
            try {
                console.log(`🚨 Trying emergency action: ${action.action}`);
                const result = await action.execute();
                
                if (result.success) {
                    return {
                        success: true,
                        emergency: true,
                        action: action.action,
                        result: result,
                        message: 'Critical issue resolved with emergency measures'
                    };
                }
            } catch (actionError) {
                console.error(`Emergency action ${action.action} failed:`, actionError);
                continue;
            }
        }
        
        // All emergency actions failed
        return {
            success: false,
            error: 'CRITICAL_FAILURE',
            message: 'All emergency measures have failed. Please contact support immediately.',
            supportContact: {
                email: 'support@abdullah-md.com',
                phone: '+1-800-HELP-NOW',
                liveChat: 'https://abdullah-md.com/support'
            }
        };
    }

    // Utility methods
    classifyError(error) {
        const errorPatterns = {
            expired: ['expired', 'timeout', 'old', 'stale'],
            invalid: ['invalid', 'wrong', 'incorrect', 'mismatch'],
            rate_limited: ['rate limit', 'too many', 'attempts', 'wait'],
            network: ['connection', 'network', 'timeout', 'offline', 'unreachable'],
            server: ['server', 'internal', '500', '503', 'service'],
            device: ['device', 'phone', 'sim', 'number'],
            permanent: ['blocked', 'banned', 'suspended', 'terminated']
        };
        
        const errorStr = error.toLowerCase();
        
        for (const [type, patterns] of Object.entries(errorPatterns)) {
            if (patterns.some(pattern => errorStr.includes(pattern))) {
                return type;
            }
        }
        
        return 'unknown';
    }

    matchesConditions(strategyConditions, errorConditions) {
        if (!strategyConditions || strategyConditions.length === 0) return true;
        
        return strategyConditions.some(condition => 
            errorConditions.includes(condition)
        );
    }

    meetsRequirements(requirements, analysis) {
        if (!requirements || requirements.length === 0) return true;
        
        // In real implementation, check if requirements are met
        // For now, assume all requirements are met for manual fallbacks
        return true;
    }

    generateSuggestions(analysis) {
        const suggestions = [];
        
        if (analysis.conditions.includes('code_expired')) {
            suggestions.push('Request a new pairing code');
        }
        
        if (analysis.conditions.includes('rate_limited')) {
            suggestions.push('Wait a few minutes before trying again');
        }
        
        if (analysis.conditions.includes('connection_timeout')) {
            suggestions.push('Check your internet connection');
            suggestions.push('Try switching between WiFi and mobile data');
        }
        
        if (analysis.conditions.includes('multiple_attempts')) {
            suggestions.push('Double-check the code you\'re entering');
            suggestions.push('Make sure your phone\'s time is synchronized');
        }
        
        if (analysis.severity === 'critical') {
            suggestions.push('Contact support for immediate assistance');
        }
        
        return suggestions;
    }

    getMethodInstructions(method) {
        const instructions = {
            sms: 'Check your SMS for the verification code',
            call: 'Answer the phone call to hear the code',
            email: 'Check your email inbox for the code',
            backup: 'Use your previously saved backup code'
        };
        
        return instructions[method] || 'Follow the on-screen instructions';
    }

    async simulateDelay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async systemReset(params) {
        console.log(`🔄 Performing system reset`);
        
        await this.simulateDelay(5000);
        
        return {
            success: true,
            action: 'system_reset',
            message: 'System has been reset. Please try pairing again.',
            warning: 'This action cleared temporary data but preserved your sessions'
        };
    }

    getAvailableFallbacks() {
        const allFallbacks = [
            ...this.fallbacks.automatic,
            ...this.fallbacks.manual,
            ...this.fallbacks.emergency
        ];
        
        return allFallbacks
            .filter(f => f.enabled)
            .map(f => ({
                id: f.id,
                name: f.name,
                description: f.description,
                type: this.getFallbackType(f),
                priority: f.priority,
                conditions: f.conditions || [],
                requirements: f.requires || []
            }));
    }

    getFallbackType(fallback) {
        if (this.fallbacks.automatic.includes(fallback)) return 'automatic';
        if (this.fallbacks.manual.includes(fallback)) return 'manual';
        if (this.fallbacks.emergency.includes(fallback)) return 'emergency';
        return 'unknown';
    }

    getStatus() {
        const available = this.getAvailableFallbacks();
        
        return {
            totalFallbacks: available.length,
            byType: {
                automatic: available.filter(f => f.type === 'automatic').length,
                manual: available.filter(f => f.type === 'manual').length,
                emergency: available.filter(f => f.type === 'emergency').length
            },
            stats: this.stats,
            averageResponseTime: this.stats.responseTimes.length > 0 
                ? Math.round(this.stats.responseTimes.reduce((a, b) => a + b) / this.stats.responseTimes.length)
                : 0,
            successRate: this.stats.totalFallbacks > 0
                ? Math.round((this.stats.successfulFallbacks / this.stats.totalFallbacks) * 100)
                : 0
        };
    }
}

module.exports = FallbackHandler;
