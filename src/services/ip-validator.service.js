// IP Validator — checks where a request is coming from.
// If the IP's country doesn't match the user's registered country, we flag it as suspicious.
// We don't block the payout — we just log it so it can be reviewed.
// IP lookups are cached in Redis for 24 hours to avoid burning through the free API limit.

import logger from "../utils/logger.js";

// Cache IP results for 24 hours — an IP's location rarely changes
const CACHE_TTL = 24 * 60 * 60;

class IPValidator {
    constructor(redisClient) {
        this.redis = redisClient;

        // IP validation can be turned off via env var — useful in development
        this.enabled = process.env.ENABLE_IP_VALIDATION === "true";
    }

    // Check an IP address and return its country, city, and whether it looks suspicious.
    // "Suspicious" means the IP's country doesn't match the user's registered country.
    async validateIP(ipAddress, userCountry) {
        // If validation is disabled, return a safe default
        if (!this.enabled) {
            return { valid: true, country: null, suspicious: false, cached: false };
        }

        // Localhost IPs are always fine — this happens in development
        if (!ipAddress || ipAddress === "::1" || ipAddress === "127.0.0.1") {
            return { valid: true, country: "localhost", suspicious: false, cached: false };
        }

        try {
            const cacheKey = `cache:ip:${ipAddress}`;

            // Check Redis cache first — saves an API call if we've seen this IP before
            const cached = await this.redis.get(cacheKey);

            if (cached) {
                const data = JSON.parse(cached);
                return {
                    valid:      true,
                    country:    data.country,
                    city:       data.city,
                    // Re-evaluate suspicious flag each time — user's country might have changed
                    suspicious: !!(userCountry && data.country !== userCountry),
                    cached:     true,
                };
            }

            // Track how many API calls we've made today — ipapi.co has a 1000/day free limit
            await this._incrementCounter("ipapi");

            // Abort the request if it takes more than 2 seconds — we can't hold up a payout
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 2000);

            const response = await fetch(`https://ipapi.co/${ipAddress}/json/`, {
                headers: { "User-Agent": "SwiftPay/1.0" },
                signal: controller.signal,
            });

            clearTimeout(timeout);

            if (!response.ok) throw new Error(`ipapi error: ${response.status}`);

            const data = await response.json();
            if (data.error) throw new Error(data.reason || "IP lookup failed");

            // Only cache the fields we actually use — keeps Redis memory lean
            const result = {
                country: data.country_code || "Unknown",
                city:    data.city,
                region:  data.region,
            };

            await this.redis.setex(cacheKey, CACHE_TTL, JSON.stringify(result));

            return {
                valid:      true,
                country:    result.country,
                city:       result.city,
                region:     result.region,
                suspicious: !!(userCountry && result.country !== userCountry),
                cached:     false,
            };
        } catch (error) {
            if (error.name === "AbortError") {
                logger.warn("IP validation timed out", { ipAddress });
            } else {
                logger.error("IP validation failed", { ipAddress, error: error.message });
            }

            // Fail open — don't block payouts just because the IP lookup failed.
            // The payout still goes through; we just won't have location data.
            return { valid: true, country: null, suspicious: false, cached: false, error: error.message };
        }
    }

    // Track daily API usage in Redis so we can warn before hitting the free tier limit.
    // Each service has its own counter keyed by date.
    async _incrementCounter(service) {
        try {
            const today = new Date().toISOString().split("T")[0];
            const key = `cache:api_count:${service}:${today}`;
            const count = await this.redis.incr(key);

            // Set expiry to 24 hours so old counters clean themselves up
            await this.redis.expire(key, 86400);

            const limit = this._getLimit(service);

            // Warn at 90% usage so we have time to react before hitting the limit
            if (count >= limit * 0.9) {
                logger.warn(`API usage near limit for ${service}`, {
                    count,
                    limit,
                    pct: Math.round((count / limit) * 100),
                });
            }
        } catch {
            // Non-critical — don't fail the request if the counter update fails
        }
    }

    // Free tier limits for each external API we use
    _getLimit(service) {
        return { ipapi: 1000, exchangerate: 1500, groq: 14400 }[service] ?? 1000;
    }

    // Returns today's usage stats for a given service — used by the /api/ai/usage endpoint
    async getAPIUsage(service) {
        try {
            const today = new Date().toISOString().split("T")[0];
            const count = parseInt(await this.redis.get(`cache:api_count:${service}:${today}`)) || 0;
            const limit = this._getLimit(service);
            return { service, count, limit, percentage: Math.round((count / limit) * 100) };
        } catch {
            return { service, count: 0, limit: this._getLimit(service), percentage: 0 };
        }
    }
}

export default IPValidator;
