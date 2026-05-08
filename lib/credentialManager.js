const fs = require('fs').promises;
const path = require('path');
const { google } = require('googleapis');

class CredentialManager {
    constructor() {
        this.credentials = new Map();
        this.authClients = new Map();
        this.basePath = process.env.SERVICE_ACCOUNTS_PATH || path.join(__dirname, '..', 'serviceAccountKeys');
    }

    async loadCredentials(gameId, serviceAccountFile) {
        const cacheKey = `${gameId}_credentials`;

        if (this.credentials.has(cacheKey)) {
            return this.credentials.get(cacheKey);
        }

        try {
            let credentials;

            const perGameEnvKey = `GOOGLE_CREDENTIALS_${gameId.toUpperCase().replace(/-/g, '_')}`;
            const sharedEnvKey = 'GOOGLE_PLAY_CREDENTIALS';
            if (process.env[perGameEnvKey]) {
                credentials = JSON.parse(process.env[perGameEnvKey]);
                console.log(`Loaded credentials for ${gameId} from per-game env var ${perGameEnvKey}`);
            } else if (process.env[sharedEnvKey]) {
                credentials = JSON.parse(process.env[sharedEnvKey]);
                console.log(`Loaded credentials for ${gameId} from shared env var ${sharedEnvKey}`);
            } else {
                const filePath = path.join(this.basePath, serviceAccountFile);
                const fileContent = await fs.readFile(filePath, 'utf8');
                credentials = JSON.parse(fileContent);
                console.log(`Loaded credentials for ${gameId} from file: ${serviceAccountFile}`);
            }

            await this.validateCredentials(credentials);

            this.credentials.set(cacheKey, credentials);
            return credentials;
        } catch (error) {
            console.error(`Failed to load credentials for ${gameId}:`, error.message);
            throw new Error(`Invalid credentials for game ${gameId}`);
        }
    }

    async validateCredentials(credentials) {
        const requiredFields = ['project_id', 'private_key', 'client_email'];

        for (const field of requiredFields) {
            if (!credentials[field]) {
                throw new Error(`Missing required field: ${field}`);
            }
        }

        if (!credentials.private_key.includes('BEGIN PRIVATE KEY')) {
            throw new Error('Invalid private key format');
        }

        return true;
    }

    async getAuthClient(gameId, serviceAccountFile) {
        const cacheKey = `${gameId}_auth`;

        if (this.authClients.has(cacheKey)) {
            return this.authClients.get(cacheKey);
        }

        try {
            const credentials = await this.loadCredentials(gameId, serviceAccountFile);

            const authClient = new google.auth.GoogleAuth({
                credentials: credentials,
                scopes: ['https://www.googleapis.com/auth/androidpublisher']
            });

            const client = await authClient.getClient();
            this.authClients.set(cacheKey, client);

            return client;
        } catch (error) {
            console.error(`Failed to create auth client for ${gameId}:`, error.message);
            throw error;
        }
    }

    async rotateCredentials(gameId, newCredentials) {
        const cacheKey = `${gameId}_credentials`;
        const authCacheKey = `${gameId}_auth`;

        await this.validateCredentials(newCredentials);

        this.credentials.set(cacheKey, newCredentials);
        this.authClients.delete(authCacheKey);

        console.log(`Successfully rotated credentials for ${gameId}`);
        return true;
    }

    clearCache(gameId = null) {
        if (gameId) {
            this.credentials.delete(`${gameId}_credentials`);
            this.authClients.delete(`${gameId}_auth`);
        } else {
            this.credentials.clear();
            this.authClients.clear();
        }
    }

    getStatus() {
        return {
            loadedCredentials: Array.from(this.credentials.keys()),
            activeAuthClients: Array.from(this.authClients.keys()),
            basePath: this.basePath
        };
    }
}

module.exports = CredentialManager;