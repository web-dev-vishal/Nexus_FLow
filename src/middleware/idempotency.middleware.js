// Idempotency middleware — prevents duplicate payout requests caused by client retries.
//
// How it works:
//   1. Client sends a unique X-Idempotency-Key header with every payout request.
//   2. On first request: we store a "pending" marker in Redis, process normally,
//      then store the final response keyed by the idempotency key.
//   3. On retry (same key): we return the stored response immediately without
//      re-processing — the client gets the same result as the first request.
//
// TTL: 24 hours — keys expire automatically so Redis doesn't grow unboundedly.
// If no key is provided: the request is allowed through (backwards compatible).

import redisConnection from "../config/redis.js";
import logger from "../utils/logger.js";

const IDEMPOTENCY_TTL_SECONDS = parseInt(process.env.IDEMPOTENCY_TTL_SECONDS) || 86400; // 24h
const KEY_PREFIX = "idempotency:";

export const idempotencyCheck = async (req, res, next) => {
    const idempotencyKey = req.headers["x-idempotency-key"];

    // No key provided — allow through (backwards compatible with existing clients)
    if (!idempotencyKey) return next();

    // Validate key format — alphanumeric, hyphens, underscores, max 128 chars
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(idempotencyKey)) {
        return res.status(400).json({
            success: false,
            error:   "X-Idempotency-Key must be 1–128 alphanumeric characters (hyphens and underscores allowed)",
            code:    "INVALID_IDEMPOTENCY_KEY",
        });
    }

    const redis = redisConnection.getClient();
    const redisKey = `${KEY_PREFIX}${idempotencyKey}`;

    try {
        const stored = await redis.get(redisKey);

        if (stored) {
            const parsed = JSON.parse(stored);

            if (parsed.status === "pending") {
                // A request with this key is currently in-flight — reject the duplicate
                return res.status(409).json({
                    success: false,
                    error:   "A request with this idempotency key is already being processed",
                    code:    "IDEMPOTENCY_CONFLICT",
                });
            }

            // We have a completed response — return it directly without re-processing
            logger.info("Idempotent response served from cache", {
                idempotencyKey,
                statusCode: parsed.statusCode,
            });

            return res.status(parsed.statusCode).json(parsed.body);
        }

        // First time we've seen this key — mark it as pending so concurrent requests
        // with the same key are rejected while this one is processing.
        // NX = only set if key doesn't exist (atomic — handles the race between two
        // simultaneous first requests with the same key).
        const claimed = await redis.set(
            redisKey,
            JSON.stringify({ status: "pending" }),
            "EX",
            IDEMPOTENCY_TTL_SECONDS,
            "NX"
        );

        if (claimed !== "OK") {
            // Another request with the same key just claimed it — reject this one
            return res.status(409).json({
                success: false,
                error:   "A request with this idempotency key is already being processed",
                code:    "IDEMPOTENCY_CONFLICT",
            });
        }

        // Attach the key to the request so the response interceptor can store the result
        req.idempotencyKey = idempotencyKey;

        // Intercept res.json() to capture and store the response before sending it
        const originalJson = res.json.bind(res);
        res.json = async (body) => {
            try {
                // Store the response so future retries get the same result
                await redis.set(
                    redisKey,
                    JSON.stringify({ status: "completed", statusCode: res.statusCode, body }),
                    "EX",
                    IDEMPOTENCY_TTL_SECONDS
                );
            } catch (err) {
                // Non-critical — log but don't block the response
                logger.error("Failed to store idempotency response", {
                    idempotencyKey,
                    error: err.message,
                });
            }
            return originalJson(body);
        };

        next();
    } catch (err) {
        // Redis failure — fail open (allow the request through) rather than blocking all payouts
        logger.error("Idempotency middleware Redis error — failing open", {
            idempotencyKey,
            error: err.message,
        });
        next();
    }
};
