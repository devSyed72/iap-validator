const bcrypt = require('bcryptjs');
const fs = require('fs').promises;
const path = require('path');

class AuthMiddleware {
    constructor() {
        this.gamesConfig = null;
        this.configPath = process.env.GAMES_CONFIG_PATH || path.join(__dirname, '..', 'config', 'games-registry.json');
        this.loadConfig();
    }

    async loadConfig() {
        try {
            const configContent = await fs.readFile(this.configPath, 'utf8');
            this.gamesConfig = JSON.parse(configContent);
            console.log('Games configuration loaded successfully');
        } catch (error) {
            console.error('Failed to load games configuration:', error.message);
            this.gamesConfig = { games: {} };
        }
    }

    async reloadConfig() {
        await this.loadConfig();
    }

    async validateApiKey(apiKey, apiKeyHash) {
        try {
            return await bcrypt.compare(apiKey, apiKeyHash);
        } catch (error) {
            console.error('API key validation error:', error.message);
            return false;
        }
    }

    validateIPAddress(gameConfig, clientIP) {
        if (!gameConfig.settings.allowedIPs || gameConfig.settings.allowedIPs.length === 0) {
            return true;
        }

        const normalizedIP = clientIP.replace(/^::ffff:/, '');

        return gameConfig.settings.allowedIPs.includes(normalizedIP);
    }

    middleware() {
        return async (req, res, next) => {
            try {
                const apiKey = req.headers['x-api-key'];
                const gameId = req.headers['x-game-id'];

                if (!apiKey || !gameId) {
                    return res.status(401).json({
                        error: 'Missing authentication headers',
                        details: 'X-API-Key and X-Game-ID headers are required'
                    });
                }

                if (!this.gamesConfig || !this.gamesConfig.games) {
                    await this.loadConfig();
                }

                const gameConfig = this.gamesConfig.games[gameId];

                if (!gameConfig) {
                    console.log(`Invalid game ID: ${gameId}`);
                    return res.status(401).json({
                        error: 'Invalid game ID',
                        gameId: gameId
                    });
                }

                if (!gameConfig.enabled) {
                    return res.status(403).json({
                        error: 'Game is disabled',
                        gameId: gameId
                    });
                }

                const isValidApiKey = await this.validateApiKey(apiKey, gameConfig.apiKeyHash);

                if (!isValidApiKey) {
                    console.log(`Invalid API key for game: ${gameId}`);
                    return res.status(401).json({
                        error: 'Invalid API key',
                        gameId: gameId
                    });
                }

                const clientIP = req.headers['x-forwarded-for'] ||
                                req.connection.remoteAddress ||
                                req.socket.remoteAddress;

                if (!this.validateIPAddress(gameConfig, clientIP)) {
                    console.log(`IP not allowed for game ${gameId}: ${clientIP}`);
                    return res.status(403).json({
                        error: 'IP address not allowed',
                        gameId: gameId
                    });
                }

                req.gameConfig = gameConfig;
                req.gameId = gameId;
                req.clientIP = clientIP;

                console.log(`Authenticated request for game: ${gameId} from IP: ${clientIP}`);

                next();
            } catch (error) {
                console.error('Authentication middleware error:', error);
                return res.status(500).json({
                    error: 'Authentication error',
                    details: error.message
                });
            }
        };
    }

    optionalMiddleware() {
        return async (req, res, next) => {
            try {
                const apiKey = req.headers['x-api-key'];
                const gameId = req.headers['x-game-id'];

                if (apiKey && gameId) {
                    return this.middleware()(req, res, next);
                }

                next();
            } catch (error) {
                next();
            }
        };
    }

    async generateApiKeyHash(apiKey) {
        const saltRounds = 10;
        return await bcrypt.hash(apiKey, saltRounds);
    }

    async addGame(gameId, gameConfig, apiKey) {
        if (!this.gamesConfig) {
            await this.loadConfig();
        }

        const apiKeyHash = await this.generateApiKeyHash(apiKey);

        this.gamesConfig.games[gameId] = {
            ...gameConfig,
            apiKeyHash: apiKeyHash
        };

        await fs.writeFile(
            this.configPath,
            JSON.stringify(this.gamesConfig, null, 2),
            'utf8'
        );

        console.log(`Added new game: ${gameId}`);
        return true;
    }

    async updateGameApiKey(gameId, newApiKey) {
        if (!this.gamesConfig || !this.gamesConfig.games[gameId]) {
            throw new Error(`Game ${gameId} not found`);
        }

        const apiKeyHash = await this.generateApiKeyHash(newApiKey);
        this.gamesConfig.games[gameId].apiKeyHash = apiKeyHash;

        await fs.writeFile(
            this.configPath,
            JSON.stringify(this.gamesConfig, null, 2),
            'utf8'
        );

        console.log(`Updated API key for game: ${gameId}`);
        return true;
    }

    async disableGame(gameId) {
        if (!this.gamesConfig || !this.gamesConfig.games[gameId]) {
            throw new Error(`Game ${gameId} not found`);
        }

        this.gamesConfig.games[gameId].enabled = false;

        await fs.writeFile(
            this.configPath,
            JSON.stringify(this.gamesConfig, null, 2),
            'utf8'
        );

        console.log(`Disabled game: ${gameId}`);
        return true;
    }

    getGames() {
        if (!this.gamesConfig) {
            return [];
        }

        return Object.keys(this.gamesConfig.games).map(gameId => ({
            gameId,
            displayName: this.gamesConfig.games[gameId].displayName,
            packageName: this.gamesConfig.games[gameId].packageName,
            enabled: this.gamesConfig.games[gameId].enabled,
            validProducts: this.gamesConfig.games[gameId].validProducts
        }));
    }
}

module.exports = AuthMiddleware;