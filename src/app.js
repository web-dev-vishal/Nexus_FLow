import express from "express";
import http from "http";
import helmet from "helmet";
import cors from "cors";
import compression from "compression";
import cookieParser from "cookie-parser";
import mongoSanitize from "express-mongo-sanitize";
import hpp from "hpp";
import { v4 as uuidv4 } from "uuid";

import database from "./config/database.js";
import redisConnection from "./config/redis.js";
import rabbitmq from "./config/rabbitmq.js";
import websocketServer from "./config/websocket.js";

import DistributedLock from "./services/distributed-lock.service.js";
import BalanceService from "./services/balance.service.js";
import MessagePublisher from "./services/message-publisher.service.js";
import PayoutService from "./services/payout.service.js";
import PublicApiService from "./services/public-api.service.js";
import GroqClient from "./services/groq.service.js";
import IPValidator from "./services/ip-validator.service.js";
import CurrencyValidator from "./services/currency-validator.service.js";
import WebhookService from "./services/webhook.service.js";
import SpendingLimitService from "./services/spending-limit.service.js";
import NotificationService from "./services/notification.service.js";
import AdminService from "./services/admin.service.js";
import SchedulerService from "./services/scheduler.service.js";
import AIAgentService from "./services/ai-agent.service.js";

import PayoutController from "./controllers/payout.controller.js";
import AIController from "./controllers/ai.controller.js";
import AIAgentController from "./controllers/ai-agent.controller.js";
import PublicApiController from "./controllers/public-api.controller.js";
import WebhookController from "./controllers/webhook.controller.js";
import SchedulerController from "./controllers/scheduler.controller.js";
import SpendingLimitController from "./controllers/spending-limit.controller.js";
import AdminController from "./controllers/admin.controller.js";

import { globalLimiter, payoutUserLimiter } from "./middleware/rate-limit.middleware.js";
import { xssSanitizer } from "./middleware/sanitize.middleware.js";
import { errorHandler, notFoundHandler, setGroqClient } from "./middleware/error.middleware.js";

import authRoutes from "./routes/auth.route.js";
import createPayoutRouter from "./routes/payout.route.js";
import createAIRouter from "./routes/ai.route.js";
import createHealthRouter from "./routes/health.route.js";
import createPublicApiRouter from "./routes/public-api.route.js";
import createWebhookRouter from "./routes/webhook.route.js";
import createSchedulerRouter from "./routes/scheduler.route.js";
import createSpendingLimitRouter from "./routes/spending-limit.route.js";
import createAdminRouter from "./routes/admin.route.js";

// NexusFlow routes
import workspaceRoutes from "./routes/workspace.route.js";
import channelRoutes from "./routes/channel.route.js";
import workflowRoutes from "./routes/workflow.route.js";
import dmRoutes from "./routes/dm.route.js";
import notificationRoutes from "./routes/notification.route.js";

import logger from "./utils/logger.js";

class Application {
    constructor() {
        this.app       = express();
        this.server    = null; // HTTP server (created later so Socket.IO can attach)
        this.redis     = null;
        this.io        = null;
        this.scheduler = null; // background job for scheduled payouts
    }

    async initialize() {
        logger.info("Initializing application...");

        // Connect to all infrastructure in order — if any of these fail, we bail early
        await database.connect();

        await redisConnection.connect();
        this.redis = redisConnection.getClient();

        await rabbitmq.connect();

        this._setupMiddleware();

        // Wire up services and pass them into routes
        const services = this._initServices();
        this._setupRoutes(services);
        this._setupErrorHandling();

        // HTTP server must be created before Socket.IO so they share the same port
        this.server = http.createServer(this.app);
        this.io = websocketServer.initialize(this.server);

        // Bridge Redis pub/sub → Socket.IO so the worker can push real-time events
        this._setupWebSocketBridge();

        // Start the scheduler — polls every minute for due scheduled payouts
        this.scheduler = services.scheduler;
        this.scheduler.start();

        logger.info("Application initialized successfully");
        return this;
    }

    _setupMiddleware() {
        // Security headers — sets X-Content-Type-Options, X-Frame-Options, CSP, etc.
        this.app.use(helmet({
            contentSecurityPolicy: {
                directives: {
                    defaultSrc: ["'self'"],
                    scriptSrc:  ["'self'"],
                    styleSrc:   ["'self'", "'unsafe-inline'"],
                    imgSrc:     ["'self'", "data:", "https:"],
                    connectSrc: ["'self'"],
                    fontSrc:    ["'self'"],
                    objectSrc:  ["'none'"],
                    frameSrc:   ["'none'"],
                },
            },
        }));

        // Allow cross-origin requests from the configured frontend origin only
        // Never fall back to "*" — that would allow any site to make credentialed requests
        const allowedOrigin = process.env.CLIENT_URL || process.env.CORS_ORIGIN;
        this.app.use(cors({
            origin:         allowedOrigin || (process.env.NODE_ENV === "production" ? false : "*"),
            credentials:    true,
            methods:        ["GET", "POST", "PUT", "DELETE", "PATCH"],
            allowedHeaders: ["Content-Type", "Authorization", "X-Correlation-ID"],
        }));

        // Compress all responses — reduces bandwidth significantly for JSON payloads
        this.app.use(compression());

        // Attach a unique correlation ID to every request for distributed tracing.
        // Clients can pass their own via X-Correlation-ID header, or we generate one.
        this.app.use((req, _res, next) => {
            req.correlationId = req.headers["x-correlation-id"] || uuidv4();
            next();
        });

        // Parse JSON and URL-encoded bodies, cap at 10kb to prevent large payload attacks
        this.app.use(express.json({ limit: "10kb" }));
        this.app.use(express.urlencoded({ extended: true, limit: "10kb" }));
        this.app.use(cookieParser());

        // Strip MongoDB operators from user input (prevents NoSQL injection)
        this.app.use(mongoSanitize());

        // Prevent HTTP parameter pollution (e.g. ?status=active&status=suspended)
        this.app.use(hpp());

        // Sanitize all string values in body/query/params against XSS
        this.app.use(xssSanitizer);

        // Global rate limiter — 100 requests per 15 minutes per IP
        this.app.use(globalLimiter);
    }

    _initServices() {
        const redis = this.redis;

        // Each service gets the Redis client injected — no global state
        const distributedLock    = new DistributedLock(redis);
        const balanceService     = new BalanceService(redis);
        const messagePublisher   = new MessagePublisher(rabbitmq.getChannel());
        const groqClient         = new GroqClient();
        const ipValidator        = new IPValidator(redis);
        const currencyValidator  = new CurrencyValidator(redis);
        const webhookService     = new WebhookService();
        const spendingLimitService = new SpendingLimitService(redis);
        const notificationService  = new NotificationService();
        const adminService       = new AdminService(balanceService);

        // Give the error handler access to Groq so it can generate friendly error messages
        setGroqClient(groqClient);

        // PayoutService orchestrates the full payout flow — it needs everything
        const payoutService = new PayoutService({
            balanceService,
            distributedLock,
            messagePublisher,
            websocketServer,
            ipValidator,
            currencyValidator,
            groqClient,
            webhookService,
            spendingLimitService,
            notificationService,
        });

        // Scheduler needs the payout service to execute due payouts
        const schedulerService = new SchedulerService(payoutService);

        // AI Agent Service — orchestrates the multi-agent system
        const aiAgentService = new AIAgentService(groqClient);

        // PublicApiService wraps free public APIs with Redis caching
        const publicApiService = new PublicApiService(redis);

        return {
            payoutController:        new PayoutController(payoutService),
            aiController:            new AIController(ipValidator, currencyValidator),
            aiAgentController:       new AIAgentController(aiAgentService),
            publicApiController:     new PublicApiController(publicApiService),
            webhookController:       new WebhookController(webhookService),
            schedulerController:     new SchedulerController(),
            spendingLimitController: new SpendingLimitController(spendingLimitService),
            adminController:         new AdminController(adminService),
            scheduler:               schedulerService,
            userRateLimiter:         payoutUserLimiter(redis),
            messagePublisher,
            healthDependencies:      { database, redis: redisConnection, rabbitmq, websocket: websocketServer },
        };
    }

    _setupRoutes({ payoutController, aiController, aiAgentController, publicApiController, webhookController, schedulerController, spendingLimitController, adminController, userRateLimiter, messagePublisher, healthDependencies }) {
        this.app.use("/api/auth",               authRoutes);
        this.app.use("/api/payout",             createPayoutRouter(payoutController, userRateLimiter));
        this.app.use("/api/ai",                 createAIRouter(aiController, aiAgentController));
        this.app.use("/api/public",             createPublicApiRouter(publicApiController));
        this.app.use("/api/health",             createHealthRouter(healthDependencies));
        this.app.use("/api/webhooks",           createWebhookRouter(webhookController));
        this.app.use("/api/scheduled-payouts",  createSchedulerRouter(schedulerController));
        this.app.use("/api/spending-limits",    createSpendingLimitRouter(spendingLimitController));
        this.app.use("/api/admin",              createAdminRouter(adminController));

        // ── NexusFlow routes ──────────────────────────────────────────────────
        // Inject messagePublisher into requests so workflow/DM controllers can publish jobs
        this.app.use("/api/workspaces", (req, _res, next) => {
            req.messagePublisher = messagePublisher;
            next();
        });

        this.app.use("/api/workspaces",                                workspaceRoutes);
        this.app.use("/api/workspaces/:workspaceId/channels",          channelRoutes);
        this.app.use("/api/workspaces/:workspaceId/workflows",         workflowRoutes);
        this.app.use("/api/workspaces/:workspaceId/dms",               dmRoutes);
        this.app.use("/api/notifications",                             notificationRoutes);

        // Simple info endpoint — useful for a quick sanity check
        this.app.get("/api", (_req, res) => {
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

    _setupErrorHandling() {
        // 404 handler must come after all routes
        this.app.use(notFoundHandler);
        // Global error handler catches anything passed to next(err)
        this.app.use(errorHandler);
    }

    _setupWebSocketBridge() {
        // The worker process can't talk to Socket.IO directly (different process).
        // Instead it publishes events to Redis, and we forward them to the right user here.
        // We use a dedicated subscriber connection — never share the main client for pub/sub.
        const subscriber = this.redis.duplicate();

        subscriber.subscribe("websocket:events").then(() => {
            logger.info("WebSocket bridge subscribed to Redis channel");
        }).catch((err) => {
            logger.error("WebSocket bridge subscribe failed:", err.message);
        });

        subscriber.on("message", (_channel, raw) => {
            try {
                const { userId, event, data, workspaceId, sourceId, message, messageId, reactions } = JSON.parse(raw);

                switch (event) {
                    case "PAYOUT_PROCESSING": websocketServer.emitPayoutProcessing(userId, data); break;
                    case "PAYOUT_COMPLETED":  websocketServer.emitPayoutCompleted(userId, data);  break;
                    case "PAYOUT_FAILED":     websocketServer.emitPayoutFailed(userId, data);     break;

                    // NexusFlow (Chat) events
                    case "MESSAGE_CREATED":   websocketServer.emitMessageCreated(workspaceId, sourceId, message);   break;
                    case "MESSAGE_UPDATED":   websocketServer.emitMessageUpdated(workspaceId, sourceId, message);   break;
                    case "MESSAGE_DELETED":   websocketServer.emitMessageDeleted(workspaceId, sourceId, messageId); break;
                    case "REACTION_UPDATED":  websocketServer.emitReactionUpdated(workspaceId, sourceId, messageId, reactions); break;

                    default: logger.warn("Unknown WebSocket event:", event);
                }
            } catch (error) {
                logger.error("WebSocket bridge error:", error.message);
            }
        });
    }

    getServer() { return this.server; }
    getApp()    { return this.app; }

    async shutdown() {
        logger.info("Shutting down...");

        // Stop the scheduler first so no new payouts are kicked off during shutdown
        if (this.scheduler) this.scheduler.stop();

        // Close in reverse order of initialization
        if (this.io)     await websocketServer.close();
        if (this.server) await new Promise((r) => this.server.close(r));

        await rabbitmq.disconnect();
        await redisConnection.disconnect();
        await database.disconnect();

        logger.info("Shutdown complete");
    }
}

export default Application;
