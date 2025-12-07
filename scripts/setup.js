#!/usr/bin/env node

const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const chalk = require('chalk');
const ora = require('ora');
const figlet = require('figlet');
const { execSync } = require('child_process');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

console.clear();

// Display banner
console.log(chalk.cyan(figlet.textSync('Abdullah-Md Pro', { horizontalLayout: 'full' })));
console.log(chalk.green('🚀 WhatsApp Session Generator v4.0 - Setup Wizard\n'));

const questions = [
    {
        name: 'domain',
        question: 'Enter your domain (e.g., whatsapp.abdullah-md.com):',
        default: 'whatsapp.abdullah-md.com',
        required: true
    },
    {
        name: 'port',
        question: 'Enter server port:',
        default: '3000',
        required: true
    },
    {
        name: 'secret',
        question: 'Enter secret key (min 32 chars, leave empty to generate):',
        default: crypto.randomBytes(32).toString('hex'),
        required: false
    },
    {
        name: 'twilioSid',
        question: 'Twilio Account SID (for SMS/Call fallbacks, optional):',
        default: '',
        required: false
    },
    {
        name: 'twilioToken',
        question: 'Twilio Auth Token:',
        default: '',
        required: false
    },
    {
        name: 'twilioPhone',
        question: 'Twilio Phone Number:',
        default: '',
        required: false
    },
    {
        name: 'smtpHost',
        question: 'SMTP Host (for Email fallback, optional):',
        default: 'smtp.gmail.com',
        required: false
    },
    {
        name: 'smtpUser',
        question: 'SMTP Username:',
        default: '',
        required: false
    },
    {
        name: 'smtpPass',
        question: 'SMTP Password:',
        default: '',
        required: false
    },
    {
        name: 'mongodb',
        question: 'MongoDB URI (optional):',
        default: 'mongodb://localhost:27017/whatsapp_sessions',
        required: false
    },
    {
        name: 'redis',
        question: 'Redis URL (optional):',
        default: 'redis://localhost:6379',
        required: false
    }
];

async function askQuestion(questionObj) {
    return new Promise((resolve) => {
        rl.question(chalk.yellow(`❓ ${questionObj.question} `), (answer) => {
            if (!answer && questionObj.default) {
                answer = questionObj.default;
            }
            
            if (!answer && questionObj.required) {
                console.log(chalk.red('⚠️ This field is required!'));
                askQuestion(questionObj).then(resolve);
                return;
            }
            
            resolve(answer);
        });
    });
}

async function setup() {
    const spinner = ora('Setting up WhatsApp Session Generator...').start();
    
    try {
        // Create necessary directories
        spinner.text = 'Creating directories...';
        const directories = [
            'sessions',
            'logs',
            'backups',
            'public/assets',
            'public/uploads',
            'config'
        ];
        
        for (const dir of directories) {
            await fs.ensureDir(dir);
            spinner.text = `Creating ${dir}...`;
        }
        
        // Ask questions
        spinner.stop();
        console.log('\n' + chalk.cyan('📝 Configuration Questions:\n'));
        
        const answers = {};
        for (const q of questions) {
            answers[q.name] = await askQuestion(q);
        }
        
        spinner.start('Generating configuration files...');
        
        // Generate .env file
        const envContent = `# Server Configuration
NODE_ENV=production
PORT=${answers.port}
HOST=0.0.0.0
DOMAIN=${answers.domain}
SECRET_KEY=${answers.secret || crypto.randomBytes(32).toString('hex')}
SESSION_SECRET=${crypto.randomBytes(32).toString('hex')}

# WhatsApp Configuration
WHATSAPP_VERSION=2.2413.1
WHATSAPP_BROWSER_NAME=Abdullah-Md Pro
WHATSAPP_BROWSER_VERSION=Chrome/121.0.0.0
MAX_SESSIONS=100
SESSION_TIMEOUT=86400000

${answers.twilioSid ? `# Twilio Configuration
TWILIO_ACCOUNT_SID=${answers.twilioSid}
TWILIO_AUTH_TOKEN=${answers.twilioToken}
TWILIO_PHONE_NUMBER=${answers.twilioPhone}` : '# Twilio not configured'}

${answers.smtpUser ? `# Email Configuration
SMTP_HOST=${answers.smtpHost}
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=${answers.smtpUser}
SMTP_PASS=${answers.smtpPass}
SMTP_FROM=${answers.smtpUser}` : '# Email not configured'}

${answers.mongodb ? `# Database Configuration
MONGODB_URI=${answers.mongodb}` : '# MongoDB not configured'}

${answers.redis ? `REDIS_URL=${answers.redis}` : '# Redis not configured'}

# Security Configuration
RATE_LIMIT_WINDOW=15
RATE_LIMIT_MAX=100
JWT_SECRET=${crypto.randomBytes(32).toString('hex')}
JWT_EXPIRES_IN=7d
ENCRYPTION_KEY=${crypto.randomBytes(32).toString('hex')}

# Storage Configuration
MAX_STORAGE_SIZE=1073741824
SESSION_RETENTION_DAYS=30
BACKUP_RETENTION_DAYS=7
CLEANUP_INTERVAL=3600000

# Feature Flags
FEATURE_BULK_GENERATE=true
FEATURE_ADVANCED_FALLBACKS=true
FEATURE_REAL_TIME_UPDATES=true
FEATURE_AUTO_BACKUP=true
FEATURE_MULTI_DEVICE=true
FEATURE_ADMIN_PANEL=true
FEATURE_API_KEYS=true`;
        
        await fs.writeFile('.env', envContent);
        
        // Generate Nginx config if domain is provided
        if (answers.domain && answers.domain !== 'localhost') {
            const nginxConfig = `server {
    listen 80;
    server_name ${answers.domain};
    
    location / {
        proxy_pass http://localhost:${answers.port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
    
    location /socket.io/ {
        proxy_pass http://localhost:${answers.port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}`;
            
            await fs.writeFile('config/nginx.conf', nginxConfig);
        }
        
        // Generate systemd service file
        const serviceConfig = `[Unit]
Description=Abdullah-Md WhatsApp Session Generator
After=network.target

[Service]
Type=simple
User=${process.env.USER || 'node'}
WorkingDirectory=${process.cwd()}
Environment=NODE_ENV=production
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=whatsapp-session-pro

[Install]
WantedBy=multi-user.target`;
        
        await fs.writeFile('config/whatsapp-session-pro.service', serviceConfig);
        
        // Generate backup script
        const backupScript = `#!/bin/bash
# Backup script for WhatsApp Session Generator
BACKUP_DIR="${process.cwd()}/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="backup_\${TIMESTAMP}.tar.gz"

echo "Starting backup..."
tar -czf "\${BACKUP_DIR}/\${BACKUP_FILE}" sessions/ config/ .env
echo "Backup created: \${BACKUP_FILE}"

# Keep only last 7 backups
cd "\${BACKUP_DIR}"
ls -t backup_*.tar.gz | tail -n +8 | xargs -r rm -f
echo "Old backups cleaned up"`;
        
        await fs.writeFile('scripts/backup.sh', backupScript);
        await fs.chmod('scripts/backup.sh', '755');
        
        spinner.succeed('Configuration files generated!');
        
        // Install dependencies
        spinner.start('Installing dependencies...');
        try {
            execSync('npm install', { stdio: 'inherit' });
            spinner.succeed('Dependencies installed!');
        } catch (error) {
            spinner.warn('Dependencies installation had issues. Check manually.');
        }
        
        // Create first admin user
        spinner.start('Creating default admin user...');
        const adminData = {
            username: 'admin',
            email: 'admin@' + answers.domain,
            password: crypto.randomBytes(8).toString('hex'),
            role: 'superadmin',
            createdAt: new Date()
        };
        
        await fs.writeJson('config/admin.json', adminData, { spaces: 2 });
        spinner.succeed('Default admin created!');
        
        // Final instructions
        console.log('\n' + chalk.green('✅ Setup Complete!\n'));
        console.log(chalk.cyan('📋 Next Steps:'));
        console.log('1. Review the generated .env file');
        console.log('2. Configure your reverse proxy (Nginx config in config/)');
        console.log('3. Start the server: ' + chalk.yellow('npm start'));
        console.log('4. For production: ' + chalk.yellow('pm2 start ecosystem.config.js'));
        console.log('\n' + chalk.yellow('🔐 Admin Credentials:'));
        console.log('Username: ' + chalk.green('admin'));
        console.log('Password: ' + chalk.green(adminData.password));
        console.log('Email: ' + chalk.green(adminData.email));
        console.log('\n' + chalk.blue('🌐 Access URLs:'));
        console.log('Dashboard: ' + chalk.underline(`http://${answers.domain}`));
        console.log('API: ' + chalk.underline(`http://${answers.domain}/api/v1/health`));
        console.log('\n' + chalk.magenta('🚀 Start using:'));
        console.log(chalk.yellow('  npm start') + ' - Start development server');
        console.log(chalk.yellow('  npm run prod') + ' - Start production with PM2');
        console.log(chalk.yellow('  npm run backup') + ' - Create backup');
        
        // Create README
        const readme = `# Abdullah-Md WhatsApp Session Generator v4.0

## 🚀 Features
- Advanced WhatsApp session generation
- Multiple pairing methods (Code, SMS, Call, Email)
- Smart fallback system
- Real-time updates
- Professional dashboard
- API support
- Backup & restore
- PM2 process management

## 📦 Installation
1. \`npm install\`
2. \`npm run setup\`
3. Configure .env file
4. \`npm start\`

## 🔧 Configuration
Edit \`.env\` file for:
- Server settings
- WhatsApp configuration
- Third-party services (Twilio, SMTP)
- Database connections
- Security settings

## 🚀 Deployment
### With PM2:
\`\`\`bash
npm run prod
pm2 logs whatsapp-session-pro
\`\`\`

### With Docker:
\`\`\`bash
docker-compose up -d
\`\`\`

## 📚 Documentation
- API: http://your-domain.com/api-docs
- Dashboard: http://your-domain.com
- Health Check: http://your-domain.com/health

## 🔒 Security
- Regular backups in \`backups/\` directory
- Session encryption
- Rate limiting
- Input validation
- CORS protection

## 🆘 Support
- Issues: GitHub Issues
- Email: support@abdullah-md.com
- Documentation: https://docs.abdullah-md.com`;
        
        await fs.writeFile('SETUP.md', readme);
        
    } catch (error) {
        spinner.fail('Setup failed!');
        console.error(chalk.red('Error:'), error.message);
        process.exit(1);
    } finally {
        rl.close();
    }
}

// Run setup
setup().catch(console.error);
