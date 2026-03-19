// Webhook routes — register and manage webhook endpoints.
// All routes require authentication.

import express from "express";
import { isAuthenticated } from "../middleware/auth.middleware.js";

const createWebhookRouter = (webhookController) => {
    const router = express.Router();

    // All webhook routes require a logged-in user
    router.use(isAuthenticated);

    router.post("/",                       webhookController.create);
    router.get("/",                        webhookController.list);
    router.patch("/:id",                   webhookController.update);
    router.delete("/:id",                  webhookController.delete);
    router.get("/:id/deliveries",          webhookController.deliveries);

    return router;
};

export default createWebhookRouter;
