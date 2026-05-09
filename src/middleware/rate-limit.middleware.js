// Rate limiting middleware — prevents abuse by limiting how many requests
// a client can make in a given time window.
// All limiters use Redis as the backing store so counters are shared across
// multiple server instances and survive restarts.

import rateLimit from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import redisConnection from "../config/redis.js";

// Helper to create a Redis-backed store for a given key prefix.
// Using Redis means rate limit counters survive server restarts and work across multiple instances.
const makeStore = (prefix) =>
    new RedisStore({
        sendCommand: (...args) => redisConnection.getClient().call(...args),
        prefix:      `rl:${prefix}:`,
    });

// Factory to avoid repeating the same rateLimit config for every route
const createLimiter = (max, windowSec, prefix, message) =>
    rateLimit({
        windowMs:        windowSec * 1000,
        max,
        standardHeaders: true,   // Return rate limit info in the RateLimit-* headers
        legacyHeaders:   false,  // Don't send the old X-RateLimit-* headers
        message:         { success: false, message },
        store:           makeStore(prefix),
    });

// ⚠️  TESTING MODE — limits are intentionally relaxed. Restore before going to production.

// Applied to every request — a broad safety net against abuse.
// DEV: 1000 requests per 1 minute per IP  (was: 100 / 15 min)
export const globalLimiter = createLimiter(
    1000, 60, "global",
    "Too many requests. Please try again later."
);

// Tighter limits on sensitive auth endpoints to slow down brute force attempts.

// DEV: 100 registrations per minute  (was: 5 / hour)
export const registerLimiter = createLimiter(
    100, 60, "register",
    "Too many registration attempts. Please try again after an hour."
);

// DEV: 100 login attempts per minute  (was: 10 / 15 min)
export const loginLimiter = createLimiter(
    100, 60, "login",
    "Too many login attempts. Please try again after 15 minutes."
);

// DEV: 100 password reset requests per minute  (was: 5 / hour)
export const forgotPasswordLimiter = createLimiter(
    100, 60, "forgot-password",
    "Too many password reset requests. Please try again after an hour."
);

// DEV: 100 OTP attempts per minute  (was: 5 / 15 min)
export const verifyOtpLimiter = createLimiter(
    100, 60, "verify-otp",
    "Too many OTP attempts. Please request a new OTP."
);

// DEV: 500 requests per minute for public API proxy endpoints  (was: 60 / min)
export const publicApiLimiter = createLimiter(
    500, 60, "public-api",
    "Too many public API requests. Please try again after a minute."
);

// DEV: 100 password change attempts per minute  (was: 5 / hour)
export const changePasswordLimiter = createLimiter(
    100, 60, "change-password",
    "Too many password change attempts. Please try again after an hour."
);

// DEV: 200 token refresh attempts per minute  (was: 20 / 15 min)
export const refreshTokenLimiter = createLimiter(
    200, 60, "refresh-token",
    "Too many token refresh attempts. Please try again after 15 minutes."
);

// Per-user payout limiter — keyed by userId so one user can't flood the queue.
// Falls back to IP if userId isn't in the body (shouldn't happen after validation).
// This is a factory function because it needs the Redis client passed in from app.js.
export const payoutUserLimiter = (redisClient) =>
    rateLimit({
        windowMs:        60 * 1000,  // 1 minute window
        max:             100,         // DEV: 100 payout requests per minute per user  (was: 10)
        standardHeaders: true,
        legacyHeaders:   false,
        // Key by userId so the limit is per-user, not per-IP
        keyGenerator:    (req) => req.body?.userId || req.ip,
        store: new RedisStore({
            sendCommand: (...args) => redisClient.call(...args),
            prefix:      "rl:user:",
        }),
        message: {
            success: false,
            error:   "Too many payout requests for this user",
            code:    "USER_RATE_LIMIT_EXCEEDED",
        },
        handler: (_req, res) => {
            res.status(429).json({
                success: false,
                error:   "Too many payout requests. Please try again later.",
                code:    "USER_RATE_LIMIT_EXCEEDED",
            });
        },
    });
