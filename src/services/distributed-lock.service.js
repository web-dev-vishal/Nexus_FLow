// Distributed lock using Redis.
// When multiple requests come in for the same user at the same time,
// we need to make sure only one of them can touch the balance at once.
// This lock prevents two payouts from running in parallel for the same user.

import crypto from "crypto";
import logger from "../utils/logger.js";

class DistributedLock {
    constructor(redisClient) {
        this.redis = redisClient;
    }

    // Try to acquire a lock for a given resource (usually a userId).
    // Returns a random lock value if successful, or null if someone else holds the lock.
    // The lock automatically expires after ttlMs milliseconds — so if the process crashes,
    // the lock won't stay forever.
    async acquire(resource, ttlMs = 30000) {
        const lockKey = `lock:${resource}`;

        // Generate a unique value so we can prove we own this lock when releasing it
        const lockValue = crypto.randomBytes(16).toString("hex");

        // NX = only set if the key doesn't already exist
        // PX = expire after ttlMs milliseconds
        const result = await this.redis.set(lockKey, lockValue, "PX", ttlMs, "NX");

        if (result === "OK") {
            logger.debug("Lock acquired", { resource, ttlMs });
            return lockValue;
        }

        // Someone else holds the lock right now
        logger.warn("Lock already held", { resource });
        return null;
    }

    // Release the lock — but only if we're the one who set it.
    // We use a Lua script to make the check-and-delete atomic.
    // Without this, a slow process could accidentally release a lock that a different process acquired.
    async release(resource, lockValue) {
        const lockKey = `lock:${resource}`;

        // Lua script ensures we only delete the key if we're the one who set it.
        // Without this check, a slow process could release a lock that another process acquired.
        const lua = `
            if redis.call("get", KEYS[1]) == ARGV[1] then
                return redis.call("del", KEYS[1])
            else
                return 0
            end
        `;

        const result = await this.redis.eval(lua, 1, lockKey, lockValue);

        if (result === 1) {
            logger.debug("Lock released", { resource });
            return true;
        }

        // This can happen if the lock expired before we released it (TTL too short)
        logger.warn("Lock release failed — not owner or already expired", { resource });
        return false;
    }

    // Try to acquire the lock multiple times before giving up.
    // Useful when there's brief contention — we wait a bit and try again
    // instead of immediately failing the request.
    async acquireWithRetry(resource, ttlMs = 30000, maxRetries = 3, retryDelayMs = 100) {
        // Try a few times with increasing delay before giving up.
        // This handles brief lock contention without hammering Redis.
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            const lockValue = await this.acquire(resource, ttlMs);
            if (lockValue) return lockValue;

            // Wait a bit longer each attempt (100ms, 200ms, 300ms...)
            if (attempt < maxRetries) {
                await new Promise((r) => setTimeout(r, retryDelayMs * attempt));
            }
        }

        logger.warn("Failed to acquire lock after retries", { resource, maxRetries });
        return null;
    }
}

export default DistributedLock;
