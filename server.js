const express = require('express');
const cors = require('cors');
const GameValidatorService = require('./lib/gameValidatorService');
const AuthMiddleware = require('./middleware/authMiddleware');
const RateLimiter = require('./middleware/rateLimiter');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Initialize services
const validatorService = new GameValidatorService();
const authMiddleware = new AuthMiddleware();
const rateLimiter = new RateLimiter();

// Add request timing
app.use((req, res, next) => {
    req.requestTime = Date.now();
    next();
});

// Main validation endpoint
app.post('/api/v1/validate-purchase',
    authMiddleware.middleware(),
    rateLimiter.middleware(),
    async (req, res) => {
        try {
            const { receipt, productId, userId, platform } = req.body;
            const { gameId, gameConfig } = req;

            console.log(`Validation request - Game: ${gameId}, User: ${userId}, Product: ${productId}`);

            if (!receipt || !productId) {
                return res.status(400).json({
                    isValid: false,
                    error: 'Missing receipt or product ID',
                    processingTime: Date.now() - req.requestTime
                });
            }

            if (platform !== 'android') {
                return res.status(400).json({
                    isValid: false,
                    error: 'Only Android platform is currently supported',
                    processingTime: Date.now() - req.requestTime
                });
            }

            // Parse Unity receipt
            let parsedReceipt;
            try {
                parsedReceipt = validatorService.parseUnityReceipt(receipt);
            } catch (parseError) {
                console.error(`Receipt parsing error for ${gameId}:`, parseError);
                return res.status(400).json({
                    isValid: false,
                    error: parseError.message,
                    processingTime: Date.now() - req.requestTime
                });
            }

            // Validate product and package
            if (parsedReceipt.productId !== productId) {
                return res.status(400).json({
                    isValid: false,
                    error: 'Product ID mismatch',
                    processingTime: Date.now() - req.requestTime
                });
            }

            if (parsedReceipt.packageName !== gameConfig.packageName) {
                return res.status(400).json({
                    isValid: false,
                    error: 'Package name mismatch',
                    processingTime: Date.now() - req.requestTime
                });
            }

            // Validate with Google Play
            const purchaseData = {
                gameId: gameId,
                packageName: parsedReceipt.packageName,
                productId: productId,
                purchaseToken: parsedReceipt.purchaseToken,
                platform: platform
            };

            const validationResult = await validatorService.validatePurchase(gameConfig, purchaseData);
            validationResult.processingTime = Date.now() - req.requestTime;

            console.log(`Validation complete - Game: ${gameId}, Valid: ${validationResult.isValid}, Time: ${validationResult.processingTime}ms`);

            res.json(validationResult);
        } catch (error) {
            console.error('Validation error:', error);
            res.status(500).json({
                isValid: false,
                error: 'Server error during validation',
                processingTime: Date.now() - req.requestTime
            });
        }
    }
);

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        version: '2.0.0'
    });
});

// Server status endpoint
app.get('/api/v1/status', (req, res) => {
    const status = {
        server: 'OK',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        environment: process.env.NODE_ENV || 'development'
    };
    res.json(status);
});

// Error handler
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
        error: 'Internal server error'
    });
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    server.close(() => {
        rateLimiter.destroy();
        validatorService.cacheManager.destroy();
        process.exit(0);
    });
});

// Start server
const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`IAP Validator Server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});