// Shared utility functions used across the codebase.
// These are pure functions with no side effects — easy to test and reuse.

import crypto from "crypto";

// Generate a unique transaction ID.
// Format: TXN_<timestamp in base36>_<8 random bytes in hex>
// Example: TXN_LX4K2A_3F9B1C2D4E5F6A7B
// Using base36 for the timestamp keeps it short while still being sortable.
export const generateTransactionId = () => {
    const timestamp = Date.now().toString(36);
    const random = crypto.randomBytes(8).toString("hex");
    return `TXN_${timestamp}_${random}`.toUpperCase();
};

// Round a number to 2 decimal places.
// Using Math.round instead of toFixed avoids floating point string conversion issues.
// e.g. roundAmount(10.005) → 10.01
export const roundAmount = (amount) => Math.round(amount * 100) / 100;

// Simple promise-based sleep — useful for adding delays in retry loops.
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Retry a function up to maxRetries times with exponential backoff.
// Waits baseDelay * 2^attempt ms between retries (1s, 2s, 4s, ...).
// Throws the last error if all retries fail.
export const retryWithBackoff = async (fn, maxRetries = 3, baseDelay = 1000) => {
    let lastError;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            if (attempt < maxRetries - 1) {
                await sleep(baseDelay * Math.pow(2, attempt));
            }
        }
    }
    throw lastError;
};

// Calculate how many milliseconds have passed since a given Date object.
// Used for logging processing times.
export const calculateDuration = (startTime) => Date.now() - startTime.getTime();

// Extract the real client IP from a request.
// Checks X-Forwarded-For first (set by proxies/load balancers), then falls back to the socket IP.
// X-Forwarded-For can contain multiple IPs if there are multiple proxies — we want the first one.
export const getClientIP = (req) =>
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.headers["x-real-ip"] ||
    req.socket?.remoteAddress ||
    req.ip ||
    "127.0.0.1";

// Remove sensitive fields from an object before logging it.
// Prevents passwords, tokens, and API keys from appearing in log files.
export const sanitizeForLogging = (obj) => {
    const sensitive = ["password", "token", "secret", "apikey", "authorization"];
    return Object.fromEntries(
        Object.entries(obj).map(([k, v]) =>
            sensitive.some((s) => k.toLowerCase().includes(s)) ? [k, "[REDACTED]"] : [k, v]
        )
    );
};
