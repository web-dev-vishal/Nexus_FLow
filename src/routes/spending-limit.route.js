// Spending limit routes — set and manage payout caps.
// All routes require authentication.

import express from "express";
import { isAuthenticated } from "../middleware/auth.middleware.js";

const createSpendingLimitRouter = (spendingLimitController) => {
    const router = express.Router();

    router.use(isAuthenticated);

    router.get("/",             spendingLimitController.list);
    router.post("/",            spendingLimitController.set);
    router.delete("/:period",   spendingLimitController.delete);

    return router;
};

export default createSpendingLimitRouter;
