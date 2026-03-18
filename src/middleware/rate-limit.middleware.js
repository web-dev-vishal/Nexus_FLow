import rateLimit from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import redis from "../lib/redis.js";

/**
 * Factory — creates a rate limiter backed by Redis.
 * @param {number} max        - max requests allowed in the window
 * @param {number} windowSec  - window size in seconds
 * @param {string} prefix     - unique Redis key prefix for this limiter
 * @param {string} message    - error message returned when limit is hit
 */
const createLimiter = (max, windowSec, prefix, message) =>
    rateLimit({
        windowMs: windowSec * 1000,
        max,
        standardHeaders: true,  // Return RateLimit-* headers
        legacyHeaders: false,
        message: { success: false, message },
        store: new RedisStore({
            sendCommand: (...args) => redis.call(...args),
            prefix: `rl:${prefix}:`,
        }),
    });

// ─── Route-specific limiters ─────────────────────────────────────────────────

// Global fallback — 100 requests per 15 minutes per IP
export const globalLimiter = createLimiter(
    100,
    15 * 60,
    "global",
    "Too many requests. Please try again later."
);

// Register — 5 attempts per hour (prevent account spam)
export const registerLimiter = createLimiter(
    5,
    60 * 60,
    "register",
    "Too many registration attempts. Please try again after an hour."
);

// Login — 10 attempts per 15 minutes (brute force protection)
export const loginLimiter = createLimiter(
    10,
    15 * 60,
    "login",
    "Too many login attempts. Please try again after 15 minutes."
);

// Forgot password — 5 attempts per hour (prevent OTP spam)
export const forgotPasswordLimiter = createLimiter(
    5,
    60 * 60,
    "forgot-password",
    "Too many password reset requests. Please try again after an hour."
);

// Verify OTP — 5 attempts per 15 minutes (prevent OTP brute force)
export const verifyOtpLimiter = createLimiter(
    5,
    15 * 60,
    "verify-otp",
    "Too many OTP attempts. Please request a new OTP and try again."
);

// Change password — 5 attempts per hour
export const changePasswordLimiter = createLimiter(
    5,
    60 * 60,
    "change-password",
    "Too many password change attempts. Please try again after an hour."
);

// Refresh token — 20 attempts per 15 minutes
export const refreshTokenLimiter = createLimiter(
    20,
    15 * 60,
    "refresh-token",
    "Too many token refresh attempts. Please try again after 15 minutes."
);
