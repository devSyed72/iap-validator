const { google } = require('googleapis');
const CredentialManager = require('./credentialManager');
const CacheManager = require('./cacheManager');

class GameValidatorService {
    constructor() {
        this.credentialManager = new CredentialManager();
        this.cacheManager = new CacheManager();
        this.androidpublisher = google.androidpublisher('v3');
        this.validators = new Map();
    }

    async validatePurchase(gameConfig, purchaseData) {
        const { gameId, packageName, productId, purchaseToken, platform } = purchaseData;

        if (platform !== 'android') {
            throw new Error(`Unsupported platform: ${platform}`);
        }

        if (!gameConfig.enabled) {
            throw new Error(`Game ${gameId} is disabled`);
        }

        if (!gameConfig.validProducts.includes(productId)) {
            throw new Error(`Invalid product ID: ${productId} for game ${gameId}`);
        }

        const cacheKey = this.cacheManager.generateKey(gameId, packageName, productId, purchaseToken);

        const cachedResult = this.cacheManager.get(gameId, cacheKey);
        if (cachedResult) {
            console.log(`Cache hit for ${gameId}: ${productId}`);
            return { ...cachedResult, cached: true };
        }

        try {
            const authClient = await this.credentialManager.getAuthClient(
                gameId,
                gameConfig.serviceAccountFile
            );

            const response = await this.androidpublisher.purchases.products.get({
                auth: authClient,
                packageName: packageName,
                productId: productId,
                token: purchaseToken
            });

            const purchaseDetails = response.data;
            console.log(`Validation for ${gameId} - Product: ${productId}, State: ${purchaseDetails.purchaseState}`);

            let result;
            if (purchaseDetails.purchaseState === 0) {
                result = {
                    isValid: true,
                    gameId: gameId,
                    transactionId: purchaseDetails.orderId,
                    purchaseTime: purchaseDetails.purchaseTimeMillis,
                    purchaseState: purchaseDetails.purchaseState,
                    consumptionState: purchaseDetails.consumptionState,
                    acknowledgementState: purchaseDetails.acknowledgementState,
                    developerPayload: purchaseDetails.developerPayload
                };
            } else {
                result = {
                    isValid: false,
                    gameId: gameId,
                    error: `Invalid purchase state: ${purchaseDetails.purchaseState}`,
                    purchaseState: purchaseDetails.purchaseState
                };
            }

            this.cacheManager.set(
                gameId,
                cacheKey,
                result,
                gameConfig.settings.cacheTimeout
            );

            return result;
        } catch (error) {
            console.error(`Validation error for ${gameId}:`, error.message);

            if (error.code === 404) {
                return {
                    isValid: false,
                    gameId: gameId,
                    error: 'Purchase not found or already consumed',
                    errorCode: 404
                };
            } else if (error.code === 410) {
                return {
                    isValid: false,
                    gameId: gameId,
                    error: 'Purchase token expired',
                    errorCode: 410
                };
            } else if (error.code === 403) {
                return {
                    isValid: false,
                    gameId: gameId,
                    error: 'Access denied - check service account permissions',
                    errorCode: 403
                };
            } else if (error.code === 401) {
                this.credentialManager.clearCache(gameId);
                return {
                    isValid: false,
                    gameId: gameId,
                    error: 'Authentication failed - credentials may be invalid',
                    errorCode: 401
                };
            }

            return {
                isValid: false,
                gameId: gameId,
                error: error.message || 'Unknown validation error',
                errorCode: error.code || 500
            };
        }
    }

    parseUnityReceipt(receipt) {
        try {
            const receiptData = JSON.parse(receipt);

            if (receiptData.Store !== 'GooglePlay') {
                throw new Error('Only Google Play receipts are supported');
            }

            const payload = JSON.parse(receiptData.Payload);
            const purchaseData = JSON.parse(payload.json);

            return {
                packageName: purchaseData.packageName,
                productId: purchaseData.productId,
                purchaseToken: purchaseData.purchaseToken,
                orderId: purchaseData.orderId,
                purchaseTime: purchaseData.purchaseTime,
                developerPayload: purchaseData.developerPayload
            };
        } catch (error) {
            throw new Error(`Failed to parse Unity receipt: ${error.message}`);
        }
    }

    async validateSubscription(gameConfig, subscriptionData) {
        const { gameId, packageName, subscriptionId, purchaseToken } = subscriptionData;

        if (!gameConfig.enabled) {
            throw new Error(`Game ${gameId} is disabled`);
        }

        try {
            const authClient = await this.credentialManager.getAuthClient(
                gameId,
                gameConfig.serviceAccountFile
            );

            const response = await this.androidpublisher.purchases.subscriptions.get({
                auth: authClient,
                packageName: packageName,
                subscriptionId: subscriptionId,
                token: purchaseToken
            });

            const subscriptionDetails = response.data;

            const isValid = subscriptionDetails.expiryTimeMillis > Date.now();

            return {
                isValid: isValid,
                gameId: gameId,
                expiryTime: subscriptionDetails.expiryTimeMillis,
                startTime: subscriptionDetails.startTimeMillis,
                autoRenewing: subscriptionDetails.autoRenewing,
                priceCurrencyCode: subscriptionDetails.priceCurrencyCode,
                priceAmountMicros: subscriptionDetails.priceAmountMicros,
                countryCode: subscriptionDetails.countryCode,
                paymentState: subscriptionDetails.paymentState,
                cancelReason: subscriptionDetails.cancelReason
            };
        } catch (error) {
            console.error(`Subscription validation error for ${gameId}:`, error.message);

            return {
                isValid: false,
                gameId: gameId,
                error: error.message || 'Subscription validation failed',
                errorCode: error.code || 500
            };
        }
    }

    getStatus() {
        return {
            credentialStatus: this.credentialManager.getStatus(),
            cacheStatus: this.cacheManager.getStatus(),
            activeValidators: this.validators.size
        };
    }

    clearCache(gameId = null) {
        this.cacheManager.clear(gameId);
        this.credentialManager.clearCache(gameId);
    }
}

module.exports = GameValidatorService;