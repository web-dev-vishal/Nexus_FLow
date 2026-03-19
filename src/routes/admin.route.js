// Admin routes — platform management endpoints.
// Requires both authentication AND admin role.

import express from "express";
import { isAuthenticated, adminOnly } from "../middleware/auth.middleware.js";

const createAdminRouter = (adminController) => {
    const router = express.Router();

    // Every admin route needs a valid JWT AND admin role
    router.use(isAuthenticated, adminOnly);

    // System overview
    router.get("/stats",                                    adminController.getStats);

    // Transaction management
    router.get("/transactions",                             adminController.getTransactions);

    // User management
    router.get("/users",                                    adminController.getUsers);
    router.get("/users/:userId",                            adminController.getUserDetail);
    router.patch("/users/:userId/status",                   adminController.updateUserStatus);
    router.post("/users/:userId/balance",                   adminController.adjustBalance);
    router.post("/users/:userId/spending-limits",           adminController.setSpendingLimit);

    // Audit and reporting
    router.get("/audit-logs",                               adminController.getAuditLogs);
    router.get("/reports/volume",                           adminController.getVolumeReport);

    return router;
};

export default createAdminRouter;
