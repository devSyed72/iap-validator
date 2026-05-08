class RateLimiter {
    constructor() {
        this.requests = new Map();
        this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
    }

    generateKey(gameId, clientIP) {
        return `${gameId}:${clientIP}`;
    }

    isAllowed(gameId, clientIP, rateConfig) {
        const key = this.generateKey(gameId, clientIP);
        const now = Date.now();
        const windowStart = now - rateConfig.window;

        if (!this.requests.has(key)) {
            this.requests.set(key, []);
        }

        const requestTimes = this.requests.get(key);

        const recentRequests = requestTimes.filter(time => time > windowStart);

        if (recentRequests.length >= rateConfig.requests) {
            console.log(`Rate limit exceeded for ${gameId} from ${clientIP}`);
            return false;
        }

        recentRequests.push(now);
        this.requests.set(key, recentRequests);

        return true;
    }

    middleware() {
        return (req, res, next) => {
            if (!req.gameConfig || !req.gameConfig.settings.rateLimit) {
                return next();
            }

            const rateConfig = req.gameConfig.settings.rateLimit;
            const gameId = req.gameId;
            const clientIP = req.clientIP;

            if (!this.isAllowed(gameId, clientIP, rateConfig)) {
                const retryAfter = Math.ceil(rateConfig.window / 1000);

                return res.status(429).json({
                    error: 'Too many requests',
                    gameId: gameId,
                    retryAfter: retryAfter,
                    limit: rateConfig.requests,
                    window: rateConfig.window
                });
            }

            next();
        };
    }

    cleanup() {
        const now = Date.now();
        const maxAge = 3600000;

        for (const [key, requestTimes] of this.requests.entries()) {
            const recentRequests = requestTimes.filter(time => time > now - maxAge);

            if (recentRequests.length === 0) {
                this.requests.delete(key);
            } else {
                this.requests.set(key, recentRequests);
            }
        }
    }

    reset(gameId = null, clientIP = null) {
        if (gameId && clientIP) {
            const key = this.generateKey(gameId, clientIP);
            this.requests.delete(key);
        } else if (gameId) {
            const prefix = `${gameId}:`;
            for (const key of this.requests.keys()) {
                if (key.startsWith(prefix)) {
                    this.requests.delete(key);
                }
            }
        } else {
            this.requests.clear();
        }
    }

    getStatus(gameId = null) {
        const status = {
            totalKeys: this.requests.size,
            games: {}
        };

        for (const [key, requestTimes] of this.requests.entries()) {
            const [game, ip] = key.split(':');

            if (!gameId || game === gameId) {
                if (!status.games[game]) {
                    status.games[game] = {
                        uniqueIPs: 0,
                        totalRequests: 0,
                        ips: {}
                    };
                }

                status.games[game].uniqueIPs++;
                status.games[game].totalRequests += requestTimes.length;
                status.games[game].ips[ip] = requestTimes.length;
            }
        }

        return status;
    }

    destroy() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        this.requests.clear();
    }
}

module.exports = RateLimiter;