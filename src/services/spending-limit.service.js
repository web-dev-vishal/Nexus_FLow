// Spending Limit Service — checks and tracks how much a user has spent in a time window.
// Before a payout goes through, we check if it would exceed any active limits.
// We track usage in Redis for speed, and fall back to MongoDB if Redis has no data.

import SpendingLimit from "../models/spending-limit.model.js";
import Transaction from "../models/transaction.model.js";
import logger from "../utils/logger.js";

class SpendingLimitService {
    constructor(redisClient) {
        this.redis = redisClient;
    }

    // Redis key for tracking how much a user has spent in a given period
    _usageKey(userId, period) {
        return `spending:${userId}:${period}`;
    }

    // Get the start of the current period (day, week, or month)
    _getPeriodStart(period) {
        const now = new Date();

        if (period === "daily") {
            // Start of today (midnight)
            return new Date(now.getFullYear(), now.getMonth(), now.getDate());
        }

        if (period === "weekly") {
            // Start of this week (Monday)
            const day = now.getDay(); // 0 = Sunday
            const diff = day === 0 ? -6 : 1 - day; // adjust to Monday
            const monday = new Date(now);
            monday.setDate(now.getDate() + diff);
            monday.setHours(0, 0, 0, 0);
            return monday;
        }

        if (period === "monthly") {
            // Start of this month
            return new Date(now.getFullYear(), now.getMonth(), 1);
        }

        return now;
    }

    // How many seconds until the current period resets — used for Redis TTL
    _secondsUntilReset(period) {
        const now = new Date();
        let reset;

        if (period === "daily") {
            reset = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        } else if (period === "weekly") {
            const day = now.getDay();
            const daysUntilMonday = day === 0 ? 1 : 8 - day;
            reset = new Date(now);
            reset.setDate(now.getDate() + daysUntilMonday);
            reset.setHours(0, 0, 0, 0);
        } else {
            // monthly — first day of next month
            reset = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        }

        return Math.ceil((reset - now) / 1000);
    }

    // Get how much the user has spent in the current period.
    // Checks Redis first (fast), falls back to MongoDB (slower but accurate).
    async getCurrentUsage(userId, period) {
        const key = this._usageKey(userId, period);
        const cached = await this.redis.get(key);

        if (cached !== null) {
            return parseFloat(cached);
        }

        // Not in Redis — calculate from MongoDB transaction history
        const periodStart = this._getPeriodStart(period);

        const result = await Transaction.aggregate([
            {
                $match: {
                    userId,
                    status:    "completed",
                    createdAt: { $gte: periodStart },
                },
            },
            {
                $group: {
                    _id:   null,
                    total: { $sum: "$amount" },
                },
            },
        ]);

        const usage = result.length > 0 ? result[0].total : 0;

        // Cache it in Redis with a TTL so it auto-expires when the period resets
        const ttl = this._secondsUntilReset(period);
        await this.redis.setEx(key, ttl, usage.toString());

        return usage;
    }

    // Check if a payout amount would exceed any of the user's active spending limits.
    // Returns { allowed: true } or { allowed: false, reason, limit, used, period }
    async checkLimits(userId, amount) {
        // Get all active limits for this user
        const limits = await SpendingLimit.find({ userId, active: true });

        if (limits.length === 0) {
            return { allowed: true };
        }

        for (const limit of limits) {
            const currentUsage = await this.getCurrentUsage(userId, limit.period);
            const projectedUsage = currentUsage + amount;

            if (projectedUsage > limit.limitAmount) {
                logger.warn("Spending limit would be exceeded", {
                    userId,
                    period:    limit.period,
                    limit:     limit.limitAmount,
                    used:      currentUsage,
                    requested: amount,
                });

                return {
                    allowed: false,
                    reason:  `${limit.period} spending limit of ${limit.limitAmount} ${limit.currency} would be exceeded`,
                    period:  limit.period,
                    limit:   limit.limitAmount,
                    used:    currentUsage,
                    remaining: Math.max(0, limit.limitAmount - currentUsage),
                    currency: limit.currency,
                };
            }
        }

        return { allowed: true };
    }

    // Record a completed payout against the user's spending counters in Redis.
    // Called after a payout succeeds — updates all active period counters.
    async recordSpend(userId, amount) {
        const limits = await SpendingLimit.find({ userId, active: true });

        // If no limits are set, nothing to track
        if (limits.length === 0) return;

        // Get the unique periods this user has limits for
        const periods = [...new Set(limits.map((l) => l.period))];

        for (const period of periods) {
            const key = this._usageKey(userId, period);
            const ttl = this._secondsUntilReset(period);

            // Increment the counter — if it doesn't exist yet, Redis creates it at 0 first
            await this.redis.incrbyfloat(key, amount);

            // Make sure the TTL is set (incrbyfloat doesn't set TTL on new keys)
            const currentTtl = await this.redis.ttl(key);
            if (currentTtl < 0) {
                await this.redis.expire(key, ttl);
            }
        }
    }

    // Set or update a spending limit for a user
    async setLimit(userId, { period, limitAmount, currency = "USD", setBy = "user" }) {
        // upsert — update if exists, create if not
        const limit = await SpendingLimit.findOneAndUpdate(
            { userId, period },
            { limitAmount, currency, active: true, setBy },
            { upsert: true, new: true }
        );

        logger.info("Spending limit set", { userId, period, limitAmount, currency });
        return limit;
    }

    // Get all spending limits for a user, with current usage included
    async getLimitsWithUsage(userId) {
        const limits = await SpendingLimit.find({ userId }).lean();

        // Attach current usage to each limit so the user can see how close they are
        const withUsage = await Promise.all(
            limits.map(async (limit) => {
                const used = await this.getCurrentUsage(userId, limit.period);
                return {
                    ...limit,
                    used,
                    remaining: Math.max(0, limit.limitAmount - used),
                    percentUsed: limit.limitAmount > 0
                        ? Math.round((used / limit.limitAmount) * 100)
                        : 0,
                };
            })
        );

        return withUsage;
    }

    // Delete a spending limit
    async deleteLimit(userId, period) {
        const result = await SpendingLimit.findOneAndDelete({ userId, period });
        if (!result) {
            throw { statusCode: 404, message: `No ${period} spending limit found` };
        }

        // Clear the Redis usage counter too
        await this.redis.del(this._usageKey(userId, period));

        logger.info("Spending limit deleted", { userId, period });
    }
}

export default SpendingLimitService;
