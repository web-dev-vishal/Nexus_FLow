import authRoutes from "../routes/auth.route.js";
import metricsRouter from "../routes/metrics.route.js";
import createPayoutRouter from "../routes/payout.route.js";
import createAIRouter from "../routes/ai.route.js";
import createHealthRouter from "../routes/health.route.js";
import createPublicApiRouter from "../routes/public-api.route.js";
import createWebhookRouter from "../routes/webhook.route.js";
import createSchedulerRouter from "../routes/scheduler.route.js";
import createSpendingLimitRouter from "../routes/spending-limit.route.js";
import createAdminRouter from "../routes/admin.route.js";

// NexusFlow routes
import workspaceRoutes from "../routes/workspace.route.js";
import channelRoutes from "../routes/channel.route.js";
import workflowRoutes from "../routes/workflow.route.js";
import dmRoutes from "../routes/dm.route.js";
import notificationRoutes from "../routes/notification.route.js";

export default function setupRoutes(app, { payoutController, aiController, aiAgentController, publicApiController, webhookController, schedulerController, spendingLimitController, adminController, userRateLimiter, messagePublisher, healthDependencies }) {
    app.use("/metrics", metricsRouter);

    app.use("/api/auth",               authRoutes);
    app.use("/api/payout",             createPayoutRouter(payoutController, userRateLimiter));
    app.use("/api/ai",                 createAIRouter(aiController, aiAgentController));
    app.use("/api/public",             createPublicApiRouter(publicApiController));
    app.use("/api/health",             createHealthRouter(healthDependencies));
    app.use("/api/webhooks",           createWebhookRouter(webhookController));
    app.use("/api/scheduled-payouts",  createSchedulerRouter(schedulerController));
    app.use("/api/spending-limits",    createSpendingLimitRouter(spendingLimitController));
    app.use("/api/admin",              createAdminRouter(adminController));

    // ── NexusFlow routes ──────────────────────────────────────────────────
    // Inject messagePublisher into requests so workflow/DM controllers can publish jobs
    app.use("/api/workspaces", (req, _res, next) => {
        req.messagePublisher = messagePublisher;
        next();
    });

    app.use("/api/workspaces",                                workspaceRoutes);
    app.use("/api/workspaces/:workspaceId/channels",          channelRoutes);
    app.use("/api/workspaces/:workspaceId/workflows",         workflowRoutes);
    app.use("/api/workspaces/:workspaceId/dms",               dmRoutes);
    app.use("/api/notifications",                             notificationRoutes);

    // Simple info endpoint — useful for a quick sanity check
    app.get("/api", (_req, res) => {
        res.json({
            success:  true,
            service:  "NexusFlow",
            version:  "1.0.0",
            features: {
                aiPowered:          process.env.ENABLE_AI_FEATURES === "true",
                ipValidation:       process.env.ENABLE_IP_VALIDATION === "true",
                currencyValidation: process.env.ENABLE_CURRENCY_VALIDATION === "true",
                webhooks:           true,
                scheduledPayouts:   true,
                spendingLimits:     true,
                adminDashboard:     true,
                notifications:      !!(process.env.MAIL_USER),
            },
            endpoints: {
                auth:             "/api/auth",
                payout:           "/api/payout",
                webhooks:         "/api/webhooks",
                scheduledPayouts: "/api/scheduled-payouts",
                spendingLimits:   "/api/spending-limits",
                admin:            "/api/admin",
                publicApis:       "/api/public",
                ai:               "/api/ai",
                aiAgents: {
                    riskAssessment:  "/api/ai/assess/:transactionId",
                    investigation:   "/api/ai/investigate/:transactionId",
                    financialCoach:  "/api/ai/insights/:userId",
                },
                health:           "/api/health",
            },
        });
    });
}
