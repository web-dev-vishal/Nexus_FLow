// Payout routes — endpoints for creating payouts and checking transaction status.
// This is a factory function because the controller and rate limiter are
// created in app.js after all dependencies are wired up.

import express from "express";
import { validatePayout } from "../validators/payout.validate.js";

const createPayoutRouter = (payoutController, userRateLimiter) => {
    const router = express.Router();

    // POST /api/payout — create a new payout request
    // Rate limiter → input validation → controller
    router.post(
        "/",
        userRateLimiter,
        validatePayout,
        payoutController.createPayout
    );

    // GET /api/payout/user/:userId/balance — get a user's current balance
    router.get("/user/:userId/balance",  payoutController.getUserBalance);

    // GET /api/payout/user/:userId/history — get a user's transaction history
    router.get("/user/:userId/history",  payoutController.getTransactionHistory);

    // GET /api/payout/:transactionId — get status of a specific transaction
    // Keep this last — :transactionId would match /user/:userId routes if registered first
    router.get("/:transactionId",        payoutController.getTransactionStatus);

    return router;
};

export default createPayoutRouter;
