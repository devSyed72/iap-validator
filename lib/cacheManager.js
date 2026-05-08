class CacheManager {
    constructor() {
        this.caches = new Map();
        this.stats = new Map();
        this.maxCacheSize = process.env.MAX_CACHE_SIZE || 1000;
        this.cleanupInterval = setInterval(() => this.cleanup(), 300000);
    }

    getGameCache(gameId) {
        if (!this.caches.has(gameId)) {
            this.caches.set(gameId, new Map());
            this.stats.set(gameId, {
                hits: 0,
                misses: 0,
                sets: 0,
                evictions: 0
            });
        }
        return this.caches.get(gameId);
    }

    generateKey(gameId, packageName, productId, purchaseToken) {
        return `${gameId}:${packageName}:${productId}:${purchaseToken}`;
    }

    get(gameId, key) {
        const cache = this.getGameCache(gameId);
        const stats = this.stats.get(gameId);

        if (cache.has(key)) {
            const entry = cache.get(key);

            if (entry.expiresAt > Date.now()) {
                stats.hits++;
                entry.lastAccessed = Date.now();
                entry.accessCount++;
                return entry.data;
            } else {
                cache.delete(key);
            }
        }

        stats.misses++;
        return null;
    }

    set(gameId, key, data, ttl = 3600000) {
        const cache = this.getGameCache(gameId);
        const stats = this.stats.get(gameId);

        if (cache.size >= this.maxCacheSize / this.caches.size) {
            this.evictLRU(gameId);
            stats.evictions++;
        }

        const entry = {
            data: data,
            expiresAt: Date.now() + ttl,
            createdAt: Date.now(),
            lastAccessed: Date.now(),
            accessCount: 0,
            ttl: ttl
        };

        cache.set(key, entry);
        stats.sets++;

        return true;
    }

    evictLRU(gameId) {
        const cache = this.getGameCache(gameId);

        if (cache.size === 0) return;

        let oldestKey = null;
        let oldestTime = Date.now();

        for (const [key, entry] of cache.entries()) {
            if (entry.lastAccessed < oldestTime) {
                oldestTime = entry.lastAccessed;
                oldestKey = key;
            }
        }

        if (oldestKey) {
            cache.delete(oldestKey);
        }
    }

    clear(gameId = null) {
        if (gameId) {
            const cache = this.getGameCache(gameId);
            cache.clear();
            this.stats.set(gameId, {
                hits: 0,
                misses: 0,
                sets: 0,
                evictions: 0
            });
        } else {
            this.caches.clear();
            this.stats.clear();
        }
    }

    cleanup() {
        const now = Date.now();

        for (const [gameId, cache] of this.caches.entries()) {
            for (const [key, entry] of cache.entries()) {
                if (entry.expiresAt <= now) {
                    cache.delete(key);
                }
            }

            if (cache.size === 0 && this.caches.size > 1) {
                this.caches.delete(gameId);
                this.stats.delete(gameId);
            }
        }
    }

    getStatus(gameId = null) {
        if (gameId) {
            const cache = this.getGameCache(gameId);
            const stats = this.stats.get(gameId) || {
                hits: 0,
                misses: 0,
                sets: 0,
                evictions: 0
            };

            const hitRate = stats.hits + stats.misses > 0
                ? (stats.hits / (stats.hits + stats.misses) * 100).toFixed(2)
                : 0;

            return {
                gameId: gameId,
                size: cache.size,
                stats: stats,
                hitRate: `${hitRate}%`,
                maxSize: Math.floor(this.maxCacheSize / this.caches.size)
            };
        }

        const globalStats = {
            totalGames: this.caches.size,
            totalEntries: 0,
            games: {}
        };

        for (const [gId, cache] of this.caches.entries()) {
            globalStats.totalEntries += cache.size;
            globalStats.games[gId] = this.getStatus(gId);
        }

        return globalStats;
    }

    setMaxCacheSize(size) {
        this.maxCacheSize = size;
    }

    destroy() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        this.caches.clear();
        this.stats.clear();
    }

    exportMetrics() {
        const metrics = [];

        for (const [gameId, stats] of this.stats.entries()) {
            const cache = this.getGameCache(gameId);
            const hitRate = stats.hits + stats.misses > 0
                ? (stats.hits / (stats.hits + stats.misses))
                : 0;

            metrics.push({
                gameId: gameId,
                timestamp: Date.now(),
                cacheSize: cache.size,
                hits: stats.hits,
                misses: stats.misses,
                sets: stats.sets,
                evictions: stats.evictions,
                hitRate: hitRate
            });
        }

        return metrics;
    }
}

module.exports = CacheManager;