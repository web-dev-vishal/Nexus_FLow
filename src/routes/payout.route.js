// Payout routes — endpoints for creating payouts, managing payout user profiles,
// wallet operations, and transaction history/export.

import express from "express";
import { validatePayout } from "../validators/payout.validate.js";
import { validate } from "../validators/user.validate.js";
import { createPayoutUserSchema, updatePayoutUserSchema, transactionHistoryQuerySchema, exportQuerySchema } from "../validators/payout-user.validate.js";
import { walletOperationSchema } from "../validators/wallet.validate.js";
import { isAuthenticated } from "../middleware/auth.middleware.js";

const createPayoutRouter = (payoutController, userRateLimiter) => {
    const router = express.Router();

    // All payout routes require a valid JWT — apply auth middleware globally for this router
    router.use(isAuthenticated);

    // ── Payout user profile management ───────────────────────────────────────

    // POST /api/payout/user — register a new payout profile for a user
    router.post("/user",                              validate(createPayoutUserSchema),                    payoutController.createPayoutUser);

    // GET /api/payout/user/:userId — get a single payout user's profile
    router.get("/user/:userId",                       payoutController.getPayoutUser);

    // PUT /api/payout/user/:userId — update email, phone, country, or currency
    router.put("/user/:userId",                       validate(updatePayoutUserSchema),                    payoutController.updatePayoutUser);

    // DELETE /api/payout/user/:userId — remove a payout profile
    router.delete("/user/:userId",                    payoutController.deletePayoutUser);

    // ── Balance and wallet ────────────────────────────────────────────────────

    // GET /api/payout/user/:userId/balance — get primary balance (USD or user's currency)
    router.get("/user/:userId/balance",               payoutController.getUserBalance);

    // GET /api/payout/user/:userId/wallet — get all multi-currency wallet balances
    router.get("/user/:userId/wallet",                payoutController.getWallet);

    // POST /api/payout/user/:userId/wallet/credit — add funds to a currency wallet
    router.post("/user/:userId/wallet/credit",        validate(walletOperationSchema),                     payoutController.creditWallet);

    // POST /api/payout/user/:userId/wallet/debit — deduct funds from a currency wallet
    router.post("/user/:userId/wallet/debit",         validate(walletOperationSchema),                     payoutController.debitWallet);

    // ── Transaction history and export ────────────────────────────────────────

    // GET /api/payout/user/:userId/history — recent transactions (?limit, ?status)
    router.get("/user/:userId/history",               validate(transactionHistoryQuerySchema, "query"),    payoutController.getTransactionHistory);

    // GET /api/payout/user/:userId/export — download transactions (?format=csv|json)
    router.get("/user/:userId/export",                validate(exportQuerySchema, "query"),                payoutController.exportTransactions);

    // ── Create payout ─────────────────────────────────────────────────────────

    // POST /api/payout — create a new payout request
    // Rate limiter → input validation → controller
    router.post(
        "/",
        userRateLimiter,
        validatePayout,
        payoutController.createPayout
    );

    // GET /api/payout/:transactionId — get status of a specific transaction
    // Keep this last — :transactionId would match /user/:userId routes if registered first
    router.get("/:transactionId",                     payoutController.getTransactionStatus);

    return router;
};

export default createPayoutRouter;
