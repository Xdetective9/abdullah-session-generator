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
