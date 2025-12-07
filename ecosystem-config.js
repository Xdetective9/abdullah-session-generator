module.exports = {
    apps: [{
        name: 'whatsapp-session-pro',
        script: './server.js',
        instances: 'max',
        exec_mode: 'cluster',
        autorestart: true,
        watch: false,
        max_memory_restart: '1G',
        env: {
            NODE_ENV: 'development',
            PORT: 3000
        },
        env_production: {
            NODE_ENV: 'production',
            PORT: 3000
        },
        error_file: './logs/pm2-err.log',
        out_file: './logs/pm2-out.log',
        log_file: './logs/pm2-combined.log',
        time: true,
        
        // Advanced PM2 configuration
        kill_timeout: 5000,
        listen_timeout: 5000,
        shutdown_with_message: true,
        
        // Health check
        wait_ready: true,
        listen_timeout: 10000,
        kill_timeout: 5000,
        
        // Metrics
        max_restarts: 10,
        min_uptime: '60s',
        
        // Process management
        merge_logs: true,
        log_date_format: 'YYYY-MM-DD HH:mm:ss',
        
        // Watch options
        watch_options: {
            persistent: true,
            ignoreInitial: true,
            usePolling: true,
            interval: 1000
        },
        
        // Environment specific
        env_development: {
            NODE_ENV: 'development',
            DEBUG: 'whatsapp:*',
            LOG_LEVEL: 'debug'
        },
        
        env_staging: {
            NODE_ENV: 'staging',
            LOG_LEVEL: 'info'
        },
        
        env_production: {
            NODE_ENV: 'production',
            LOG_LEVEL: 'warn'
        },
        
        // Instance configuration
        instance_var: 'INSTANCE_ID',
        
        // Advanced monitoring
        node_args: [
            '--max-old-space-size=4096',
            '--max-semi-space-size=128',
            '--optimize-for-size',
            '--trace-warnings'
        ],
        
        // PM2 features
        post_update: ['npm install', 'echo updating...'],
        pre_restart: 'npm run cleanup',
        post_restart: 'npm run start',
        
        // Deployment hooks
        pre_deploy: 'npm run build',
        post_deploy: 'pm2 restart ecosystem.config.js --env production',
        
        // Resource limits
        max_memory_restart: '2G',
        exp_backoff_restart_delay: 100,
        
        // Cron restart for memory leak prevention
        cron_restart: '0 */6 * * *',
        
        // Interpreter
        interpreter: 'node',
        interpreter_args: '--harmony'
    }, {
        // Worker for background tasks
        name: 'whatsapp-worker',
        script: './src/workers/main.js',
        instances: 2,
        exec_mode: 'cluster',
        autorestart: true,
        watch: false,
        env: {
            NODE_ENV: 'production',
            WORKER: true
        }
    }, {
        // Queue processor
        name: 'whatsapp-queue',
        script: './src/queues/processor.js',
        instances: 1,
        autorestart: true,
        watch: false
    }],
    
    // Deployment configuration
    deploy: {
        production: {
            user: 'ubuntu',
            host: ['server1.abdullah-md.com', 'server2.abdullah-md.com'],
            ref: 'origin/main',
            repo: 'git@github.com:abdullah-md/whatsapp-session-pro.git',
            path: '/var/www/whatsapp-session-pro',
            'post-deploy': 'npm install && pm2 reload ecosystem.config.js --env production',
            env: {
                NODE_ENV: 'production'
            }
        },
        staging: {
            user: 'ubuntu',
            host: 'staging.abdullah-md.com',
            ref: 'origin/develop',
            repo: 'git@github.com:abdullah-md/whatsapp-session-pro.git',
            path: '/var/www/staging',
            'post-deploy': 'npm install && pm2 reload ecosystem.config.js --env staging',
            env: {
                NODE_ENV: 'staging'
            }
        }
    }
};
