import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL);

redis.on("connect", () => console.log("Redis connected successfully"));
redis.on("error", (err) => console.error("Redis connection error:", err.message));

// ─── Key factories ───────────────────────────────────────────────────────────
export const keys = {
    otp:          (email)  => `otp:${email}`,
    refreshToken: (userId) => `refresh_token:${userId}`,
    verifyToken:  (userId) => `verify_token:${userId}`,
    userCache:    (userId) => `user:${userId}`,
};

// ─── TTLs (seconds) ──────────────────────────────────────────────────────────
export const TTL = {
    OTP:          10 * 60,           // 10 minutes
    REFRESH:      30 * 24 * 60 * 60, // 30 days
    VERIFY:       10 * 60,           // 10 minutes
    USER_CACHE:   60 * 60,           // 1 hour
};

export default redis;
