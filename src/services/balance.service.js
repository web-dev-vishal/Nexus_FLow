// This service manages user balances stored in Redis.
// We keep balances in Redis (not just MongoDB) because Redis is much faster for
// frequent reads and writes. The MongoDB balance is synced after each completed payout.
//
// The most important thing here is that balance changes are ATOMIC — meaning
// no two operations can run at the same time and cause a race condition.
// We use Lua scripts for this, which Redis runs as a single uninterruptible operation.

import logger from "../utils/logger.js";

class BalanceService {
    constructor(redisClient) {
        this.redis = redisClient;
    }

    // Returns the Redis key for a user's balance
    // Keeping key names in one place avoids typos scattered across files
    _key(userId) {
        return `balance:${userId}`;
    }

    // Get the current balance for a user from Redis.
    // Returns null if no balance exists yet (user hasn't been synced yet).
    async getBalance(userId) {
        const raw = await this.redis.get(this._key(userId));

        // Redis returns strings — convert to a number, or null if the key doesn't exist
        return raw === null ? null : parseFloat(raw);
    }

    // Copy the balance from MongoDB into Redis.
    // Called the first time we need a user's balance and it's not in Redis yet.
    async syncBalance(userId, balance) {
        await this.redis.set(this._key(userId), balance.toString());
        logger.debug("Balance synced to Redis", { userId, balance });
    }

    // Quick check: does the user have enough money for this payout?
    async hasSufficientBalance(userId, amount) {
        const balance = await this.getBalance(userId);

        // If balance is null, the user hasn't been synced — treat as insufficient
        return balance !== null && balance >= amount;
    }

    // Deduct an amount from the user's balance atomically.
    // Uses a Lua script so the read-check-write happens as one operation in Redis.
    // This prevents two simultaneous payouts from both passing the balance check.
    async deductBalance(userId, amount) {
        // This Lua script runs entirely inside Redis — nothing can interrupt it
        const lua = `
            local current = redis.call("get", KEYS[1])
            if not current then return nil end
            current = tonumber(current)
            local amt = tonumber(ARGV[1])
            if current < amt then return -1 end
            local newBal = current - amt
            redis.call("set", KEYS[1], tostring(newBal))
            return newBal
        `;

        // KEYS[1] = the balance key, ARGV[1] = the amount to deduct
        const result = await this.redis.eval(lua, 1, this._key(userId), amount.toString());

        // null means the key didn't exist — user balance not found
        if (result === null) throw new Error("BALANCE_NOT_FOUND");

        // -1 is our signal from the Lua script that the balance was too low
        if (result === -1) throw new Error("INSUFFICIENT_BALANCE");

        logger.debug("Balance deducted", { userId, amount, newBalance: result });
        return parseFloat(result);
    }

    // Add an amount back to the user's balance — used when rolling back a failed payout.
    // Also atomic via Lua script for the same reason as deductBalance.
    async addBalance(userId, amount) {
        const lua = `
            local current = redis.call("get", KEYS[1])
            if not current then return nil end
            local newBal = tonumber(current) + tonumber(ARGV[1])
            redis.call("set", KEYS[1], tostring(newBal))
            return newBal
        `;

        const result = await this.redis.eval(lua, 1, this._key(userId), amount.toString());

        if (result === null) throw new Error("BALANCE_NOT_FOUND");

        logger.debug("Balance added", { userId, amount, newBalance: result });
        return parseFloat(result);
    }

    // Remove the balance key from Redis entirely.
    // Used when a user account is closed or during testing cleanup.
    async deleteBalance(userId) {
        await this.redis.del(this._key(userId));
    }
}

export default BalanceService;
