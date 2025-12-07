class ConfettiManager {
    constructor() {
        this.isActive = false;
        this.defaults = {
            particleCount: 100,
            angle: 90,
            spread: 45,
            startVelocity: 45,
            decay: 0.9,
            gravity: 1,
            drift: 0,
            ticks: 200,
            origin: { x: 0.5, y: 0.5 },
            colors: ['#25D366', '#128C7E', '#6A11CB', '#FF6B6B', '#10B981', '#F59E0B', '#3B82F6'],
            shapes: ['circle', 'square'],
            scalar: 1,
            zIndex: 10000
        };
    }

    celebrate(type = 'success') {
        if (this.isActive) return;
        
        this.isActive = true;
        
        const configs = {
            success: {
                particleCount: 150,
                spread: 70,
                origin: { y: 0.6 }
            },
            achievement: {
                particleCount: 200,
                angle: 60,
                spread: 55,
                origin: { x: 0.5, y: 0.5 }
            },
            welcome: {
                particleCount: 250,
                angle: 90,
                spread: 360,
                startVelocity: 60,
                decay: 0.94,
                origin: { x: 0.5, y: 0.5 }
            },
            premium: {
                particleCount: 300,
                spread: 100,
                scalar: 1.2,
                colors: ['#FFD700', '#FFA500', '#FF6B6B', '#25D366'],
                shapes: ['star', 'circle']
            }
        };

        const config = { ...this.defaults, ...configs[type] };
        
        // Create confetti container if it doesn't exist
        let container = document.querySelector('.confetti-container');
        if (!container) {
            container = document.createElement('div');
            container.className = 'confetti-container';
            container.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                pointer-events: none;
                z-index: 9999;
            `;
            document.body.appendChild(container);
        }

        // Generate confetti particles
        for (let i = 0; i < config.particleCount; i++) {
            this.createParticle(container, config);
        }

        // Cleanup after animation
        setTimeout(() => {
            container.remove();
            this.isActive = false;
        }, 3000);
    }

    createParticle(container, config) {
        const particle = document.createElement('div');
        
        // Random properties
        const color = config.colors[Math.floor(Math.random() * config.colors.length)];
        const shape = config.shapes[Math.floor(Math.random() * config.shapes.length)];
        const size = Math.random() * 10 + 5;
        const left = Math.random() * 100;
        
        // Set styles
        particle.style.cssText = `
            position: absolute;
            width: ${size}px;
            height: ${size}px;
            background: ${color};
            border-radius: ${shape === 'circle' ? '50%' : '0'};
            left: ${left}%;
            top: -20px;
            opacity: ${Math.random() + 0.5};
            transform: rotate(${Math.random() * 360}deg);
            animation: confetti-fall ${Math.random() * 3 + 2}s linear forwards;
        `;

        // Add star shape for premium
        if (shape === 'star') {
            particle.innerHTML = '★';
            particle.style.background = 'none';
            particle.style.color = color;
            particle.style.fontSize = `${size * 1.5}px`;
            particle.style.textShadow = '0 0 5px rgba(255,255,255,0.5)';
        }

        // Add to container
        container.appendChild(particle);

        // Remove after animation
        setTimeout(() => {
            if (particle.parentNode) {
                particle.remove();
            }
        }, 3000);
    }

    // Predefined celebration sequences
    successSequence() {
        this.celebrate('success');
        setTimeout(() => {
            this.celebrate('success');
        }, 300);
        setTimeout(() => {
            this.celebrate('success');
        }, 600);
    }

    premiumSequence() {
        this.celebrate('premium');
        setTimeout(() => {
            this.celebrate('premium');
        }, 500);
        setTimeout(() => {
            this.celebrate('premium');
        }, 1000);
    }

    welcomeSequence() {
        this.celebrate('welcome');
        setTimeout(() => {
            this.celebrate('success');
        }, 1000);
    }
}

// Add CSS animation
const style = document.createElement('style');
style.textContent = `
    @keyframes confetti-fall {
        0% {
            transform: translateY(0) rotate(0deg);
            opacity: 1;
        }
        100% {
            transform: translateY(100vh) rotate(720deg);
            opacity: 0;
        }
    }
    
    @keyframes confetti-spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
    }
`;
document.head.appendChild(style);

// Export global instance
window.Confetti = new ConfettiManager();
