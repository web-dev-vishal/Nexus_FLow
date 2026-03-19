// Payout controller — handles HTTP requests for creating and checking payouts.
// Thin layer: extract request data, call the service, return the result.
// All the heavy lifting (fraud scoring, balance checks, locking) is in payout.service.js.

import logger from "../utils/logger.js";
import { getClientIP } from "../utils/helpers.js";

class PayoutController {
    constructor(payoutService) {
        this.payoutService = payoutService;
    }

    // POST /api/payout
    // Initiates a new payout request.
    // Returns 202 Accepted — the payout is queued, not yet completed.
    createPayout = async (req, res, next) => {
        try {
            const { userId, amount, currency, description } = req.body;

            // Collect metadata for fraud scoring and audit logging
            const metadata = {
                ipAddress: getClientIP(req),
                userAgent: req.get("user-agent"),
                source:    "api",
            };

            logger.info("Payout request received", { userId, amount, currency, ip: metadata.ipAddress });

            const result = await this.payoutService.initiatePayout(
                { userId, amount, currency, description },
                metadata
            );

            // 202 = accepted for processing, not yet completed
            res.status(202).json(result);
        } catch (error) {
            // Pass structured errors (from ERROR_MAP) to the error middleware
            next(error);
        }
    };

    // GET /api/payout/:transactionId
    // Returns the current status of a specific transaction.
    getTransactionStatus = async (req, res, next) => {
        try {
            const { transactionId } = req.params;
            const result = await this.payoutService.getTransactionStatus(transactionId);
            res.status(200).json(result);
        } catch (error) {
            next(error);
        }
    };

    // GET /api/payout/user/:userId/balance
    // Returns the user's current balance from Redis (or MongoDB if not cached).
    getUserBalance = async (req, res, next) => {
        try {
            const { userId } = req.params;
            const result = await this.payoutService.getUserBalance(userId);
            res.status(200).json(result);
        } catch (error) {
            next(error);
        }
    };

    // GET /api/payout/user/:userId/history
    // Returns recent transactions for a user.
    // Supports ?limit=N and ?status=completed|failed|initiated filtering.
    getTransactionHistory = async (req, res, next) => {
        try {
            const { userId } = req.params;

            // Cap at 200 to prevent huge responses — default is 50
            const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
            const status = req.query.status;

            // Dynamic import avoids a circular dependency issue at startup
            const Transaction = (await import("../models/transaction.model.js")).default;

            const query = { userId };
            if (status) query.status = status;

            const transactions = await Transaction.find(query)
                .sort({ createdAt: -1 })  // Newest first
                .limit(limit)
                .select("-__v")           // Don't expose the internal version field
                .lean();                  // Plain JS objects are faster than Mongoose documents

            res.status(200).json({
                success:      true,
                count:        transactions.length,
                transactions,
            });
        } catch (error) {
            next(error);
        }
    };
}

export default PayoutController;
