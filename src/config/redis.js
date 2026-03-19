// This file manages the Redis connection.
// Redis is used for caching, session storage, rate limiting, and pub/sub messaging.
// We wrap ioredis in a class so the rest of the app can call getClient() without
// worrying about whether the connection is ready yet.

import Redis from "ioredis";
import logger from "../utils/logger.js";

class RedisConnection {
    constructor() {
        this.client = null;       // the actual ioredis client — null until connect() is called
        this.isConnected = false; // tracks whether we currently have a live connection
    }

    connect() {
        // We return a Promise so the caller can await it and know when Redis is ready
        return new Promise((resolve, reject) => {

            // Create the ioredis client with our config
            this.client = new Redis({
                host:     process.env.REDIS_HOST || "localhost",
                port:     parseInt(process.env.REDIS_PORT) || 6379,
                password: process.env.REDIS_PASSWORD || undefined,

                // If the connection drops, wait a bit before retrying.
                // The delay grows with each attempt (50ms, 100ms, 150ms...) but never exceeds 2s.
                retryStrategy: (times) => Math.min(times * 50, 2000),

                maxRetriesPerRequest: 3,    // give up on a single command after 3 tries
                enableReadyCheck:     true, // wait for Redis to say it's ready before resolving
                connectTimeout:       10000, // if we can't connect in 10s, fail
                lazyConnect:          false, // connect immediately, don't wait for first command
            });

            // This flag prevents us from calling reject() more than once.
            // Once the promise is settled (resolved or rejected), we ignore further events.
            let settled = false;

            // "ready" fires when ioredis has connected AND Redis has responded to a PING.
            // This is the signal that Redis is actually usable.
            this.client.on("ready", () => {
                this.isConnected = true;
                settled = true; // mark as settled so the error handler won't reject after this
                logger.info("Redis connected", {
                    host: process.env.REDIS_HOST,
                    port: process.env.REDIS_PORT,
                });
                resolve(this.client);
            });

            // Something went wrong — could be wrong password, host unreachable, etc.
            this.client.on("error", (err) => {
                this.isConnected = false;
                logger.error("Redis error:", err.message);

                // Only reject the promise on the very first failure.
                // After that, ioredis handles reconnection on its own — we don't need to do anything.
                if (!settled) {
                    settled = true;
                    reject(err);
                }
            });

            // The TCP connection was closed — ioredis will try to reconnect automatically
            this.client.on("close", () => {
                this.isConnected = false;
                logger.warn("Redis connection closed");
            });

            // ioredis is actively trying to reconnect after a disconnect
            this.client.on("reconnecting", () => {
                logger.info("Redis reconnecting...");
            });
        });
    }

    // Cleanly close the Redis connection during app shutdown.
    // quit() sends the QUIT command to Redis and waits for it to acknowledge — much cleaner
    // than just destroying the socket.
    async disconnect() {
        if (this.client) {
            await this.client.quit();
            this.isConnected = false;
            logger.info("Redis disconnected gracefully");
        }
    }

    // Returns the live Redis client.
    // Throws if connect() hasn't been called yet — this is intentional so we catch
    // startup order bugs early instead of getting confusing null errors later.
    getClient() {
        if (!this.client) throw new Error("Redis client not initialized — call connect() first");
        return this.client;
    }

    // Sends a PING to Redis and checks we get PONG back.
    // Used by the health check endpoint to verify Redis is actually responding.
    async isHealthy() {
        try {
            if (!this.client) return false;
            const pong = await this.client.ping();
            return pong === "PONG" && this.isConnected;
        } catch {
            // If ping throws, Redis is not healthy
            return false;
        }
    }
}

// Export a single shared instance — the whole app uses this one connection
export default new RedisConnection();
