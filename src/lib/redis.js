// Thin wrapper around the shared Redis connection.
// The actual connection lifecycle (connect/disconnect/health) lives in src/config/redis.js.
// This file exports key name factories and TTL constants used by the auth service.

import redisConnection from "../config/redis.js";

// ─── Key factories ────────────────────────────────────────────────────────────
// Centralizing key names here means we never have typos scattered across files.
// Every Redis key used by the auth system goes through one of these functions.
export const keys = {
    otp:          (email)  => `otp:${email}`,           // Stores the OTP for password reset
    refreshToken: (userId) => `refresh_token:${userId}`, // Stores the refresh token for a user
    verifyToken:  (userId) => `verify_token:${userId}`,  // Stores the email verification token
    userCache:    (userId) => `user:${userId}`,           // Cached user profile from MongoDB
};

// ─── TTLs (in seconds) ────────────────────────────────────────────────────────
// All expiry times in one place — easy to adjust without hunting through the codebase.
export const TTL = {
    OTP:        10 * 60,            // 10 minutes — OTPs expire quickly for security
    REFRESH:    30 * 24 * 60 * 60,  // 30 days — matches the JWT refresh token lifetime
    VERIFY:     10 * 60,            // 10 minutes — email verification links are short-lived
    USER_CACHE: 60 * 60,            // 1 hour — cached user profile
};

// Returns the live Redis client.
// We use a getter function instead of capturing the client at import time
// because the connection might not be established yet when this module loads.
export const getRedis = () => redisConnection.getClient();
