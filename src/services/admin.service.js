// Admin Service — provides data and management functions for admin users.
// These endpoints are protected by admin middleware — regular users can't access them.
// Covers: transaction search, user management, balance adjustments, and system stats.

import Transaction from "../models/transaction.model.js";
import PayoutUser from "../models/payout-user.model.js";
import AuditLog from "../models/audit-log.model.js";
import SpendingLimit from "../models/spending-limit.model.js";
import logger from "../utils/logger.js";

class AdminService {
    constructor(balanceService) {
        // We need the balance service to adjust user balances in Redis
        this.balance = balanceService;
    }

    // Get a high-level overview of the system — total users, transactions, volume, etc.
    async getSystemStats() {
        const [
            totalUsers,
            totalTransactions,
            completedTransactions,
            failedTransactions,
            volumeResult,
            recentTransactions,
        ] = await Promise.all([
            PayoutUser.countDocuments(),
            Transaction.countDocuments(),
            Transaction.countDocuments({ status: "completed" }),
            Transaction.countDocuments({ status: "failed" }),
            Transaction.aggregate([
                { $match: { status: "completed" } },
                { $group: { _id: null, total: { $sum: "$amount" } } },
            ]),
            Transaction.find()
                .sort({ createdAt: -1 })
                .limit(10)
                .select("transactionId userId amount currency status createdAt")
                .lean(),
        ]);

        const totalVolume = volumeResult.length > 0 ? volumeResult[0].total : 0;
        const successRate = totalTransactions > 0
            ? Math.round((completedTransactions / totalTransactions) * 100)
            : 0;

        return {
            users: {
                total: totalUsers,
            },
            transactions: {
                total:     totalTransactions,
                completed: completedTransactions,
                failed:    failedTransactions,
                successRate: `${successRate}%`,
            },
            volume: {
                totalUSD: totalVolume,
            },
            recentTransactions,
        };
    }

    // Search and filter transactions — supports pagination, status filter, date range, userId
    async getTransactions({ page = 1, limit = 20, status, userId, startDate, endDate, currency } = {}) {
        const query = {};

        if (status)    query.status   = status;
        if (userId)    query.userId   = userId;
        if (currency)  query.currency = currency;

        if (startDate || endDate) {
            query.createdAt = {};
            if (startDate) query.createdAt.$gte = new Date(startDate);
            if (endDate)   query.createdAt.$lte = new Date(endDate);
        }

        const skip = (page - 1) * Math.min(limit, 100);
        const safeLimit = Math.min(parseInt(limit), 100);

        const [transactions, total] = await Promise.all([
            Transaction.find(query)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(safeLimit)
                .lean(),
            Transaction.countDocuments(query),
        ]);

        return {
            transactions,
            pagination: {
                page:       parseInt(page),
                limit:      safeLimit,
                total,
                totalPages: Math.ceil(total / safeLimit),
            },
        };
    }

    // Get a list of all payout users with their balances and stats
    async getUsers({ page = 1, limit = 20, status, search } = {}) {
        const query = {};

        if (status) query.status = status;

        // Search by userId (partial match)
        if (search) query.userId = { $regex: search, $options: "i" };

        const skip = (page - 1) * Math.min(limit, 100);
        const safeLimit = Math.min(parseInt(limit), 100);

        const [users, total] = await Promise.all([
            PayoutUser.find(query)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(safeLimit)
                .lean(),
            PayoutUser.countDocuments(query),
        ]);

        return {
            users,
            pagination: {
                page:       parseInt(page),
                limit:      safeLimit,
                total,
                totalPages: Math.ceil(total / safeLimit),
            },
        };
    }

    // Get a single user's full profile — balance, limits, recent transactions
    async getUserDetail(userId) {
        const [user, recentTransactions, spendingLimits] = await Promise.all([
            PayoutUser.findByUserId(userId),
            Transaction.find({ userId })
                .sort({ createdAt: -1 })
                .limit(20)
                .lean(),
            SpendingLimit.find({ userId }).lean(),
        ]);

        if (!user) {
            throw { statusCode: 404, message: "User not found" };
        }

        return {
            user,
            recentTransactions,
            spendingLimits,
        };
    }

    // Suspend or reactivate a user account
    async updateUserStatus(userId, status, adminId) {
        const validStatuses = ["active", "suspended", "closed"];
        if (!validStatuses.includes(status)) {
            throw { statusCode: 400, message: `Invalid status. Must be one of: ${validStatuses.join(", ")}` };
        }

        const user = await PayoutUser.findOneAndUpdate(
            { userId },
            { $set: { status } },
            { new: true }
        );

        if (!user) {
            throw { statusCode: 404, message: "User not found" };
        }

        logger.info("Admin updated user status", { adminId, userId, newStatus: status });

        return user;
    }

    // Manually adjust a user's balance — for corrections, refunds, etc.
    // Creates an audit trail so we know who did it and why.
    async adjustBalance(userId, { amount, type, reason, adminId }) {
        if (!["credit", "debit"].includes(type)) {
            throw { statusCode: 400, message: "type must be 'credit' or 'debit'" };
        }

        if (!reason || reason.trim().length < 5) {
            throw { statusCode: 400, message: "A reason is required for balance adjustments (min 5 chars)" };
        }

        const user = await PayoutUser.findByUserId(userId);
        if (!user) {
            throw { statusCode: 404, message: "User not found" };
        }

        const adjustmentAmount = parseFloat(amount);
        if (isNaN(adjustmentAmount) || adjustmentAmount <= 0) {
            throw { statusCode: 400, message: "Amount must be a positive number" };
        }

        const balanceBefore = user.balance;
        let newBalance;

        if (type === "credit") {
            newBalance = balanceBefore + adjustmentAmount;
        } else {
            if (balanceBefore < adjustmentAmount) {
                throw { statusCode: 400, message: "Debit amount exceeds current balance" };
            }
            newBalance = balanceBefore - adjustmentAmount;
        }

        // Update MongoDB
        await PayoutUser.updateOne({ userId }, { $set: { balance: newBalance } });

        // Update Redis so the live balance is correct
        try {
            if (type === "credit") {
                await this.balance.addBalance(userId, adjustmentAmount);
            } else {
                await this.balance.deductBalance(userId, adjustmentAmount);
            }
        } catch {
            // Redis might not have the key yet — sync it from the new MongoDB value
            await this.balance.syncBalance(userId, newBalance);
        }

        // Create a transaction record for the adjustment
        const { generateTransactionId } = await import("../utils/helpers.js");
        const transactionId = generateTransactionId();

        await Transaction.create({
            transactionId,
            userId,
            amount:        adjustmentAmount,
            currency:      user.currency || "USD",
            status:        "completed",
            type:          "adjustment",
            balanceBefore,
            balanceAfter:  newBalance,
            metadata: {
                source:      "admin",
                description: reason,
            },
            processingDetails: {
                initiatedAt: new Date(),
                completedAt: new Date(),
            },
        });

        // Log it in the audit trail
        await AuditLog.logAction(transactionId, userId, "BALANCE_DEDUCTED", {
            type,
            amount:        adjustmentAmount,
            balanceBefore,
            newBalance,
            adminId,
            reason,
        });

        logger.info("Admin balance adjustment", { adminId, userId, type, amount: adjustmentAmount, reason });

        return {
            userId,
            type,
            amount:        adjustmentAmount,
            balanceBefore,
            newBalance,
            transactionId,
        };
    }

    // Set a spending limit on behalf of a user (admin-imposed limit)
    async setUserSpendingLimit(userId, { period, limitAmount, currency = "USD" }, adminId) {
        const { default: SpendingLimitService } = await import("./spending-limit.service.js");

        // We need a SpendingLimitService instance — but we don't have Redis here.
        // Use the model directly for admin-imposed limits.
        const limit = await SpendingLimit.findOneAndUpdate(
            { userId, period },
            { limitAmount, currency, active: true, setBy: "admin" },
            { upsert: true, new: true }
        );

        logger.info("Admin set spending limit", { adminId, userId, period, limitAmount });
        return limit;
    }

    // Get audit logs for a specific transaction or user
    async getAuditLogs({ transactionId, userId, page = 1, limit = 50 } = {}) {
        const query = {};
        if (transactionId) query.transactionId = transactionId;
        if (userId)        query.userId        = userId;

        const skip = (page - 1) * Math.min(limit, 200);
        const safeLimit = Math.min(parseInt(limit), 200);

        const [logs, total] = await Promise.all([
            AuditLog.find(query)
                .sort({ timestamp: -1 })
                .skip(skip)
                .limit(safeLimit)
                .lean(),
            AuditLog.countDocuments(query),
        ]);

        return {
            logs,
            pagination: {
                page:       parseInt(page),
                limit:      safeLimit,
                total,
                totalPages: Math.ceil(total / safeLimit),
            },
        };
    }

    // Get a daily breakdown of transaction volume for the last N days
    async getVolumeReport(days = 30) {
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        const result = await Transaction.aggregate([
            {
                $match: {
                    status:    "completed",
                    createdAt: { $gte: since },
                },
            },
            {
                $group: {
                    _id: {
                        year:  { $year:  "$createdAt" },
                        month: { $month: "$createdAt" },
                        day:   { $dayOfMonth: "$createdAt" },
                    },
                    count:  { $sum: 1 },
                    volume: { $sum: "$amount" },
                },
            },
            { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } },
        ]);

        return result.map(({ _id, count, volume }) => ({
            date:   `${_id.year}-${String(_id.month).padStart(2, "0")}-${String(_id.day).padStart(2, "0")}`,
            count,
            volume: Math.round(volume * 100) / 100,
        }));
    }
}

export default AdminService;
