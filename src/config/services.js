import rabbitmq from "./rabbitmq.js";
import websocketServer from "./websocket.js";

import DistributedLock from "../services/distributed-lock.service.js";
import BalanceService from "../services/balance.service.js";
import MessagePublisher from "../services/message-publisher.service.js";
import PayoutService from "../services/payout.service.js";
import PublicApiService from "../services/public-api.service.js";
import GroqClient from "../services/groq.service.js";
import IPValidator from "../services/ip-validator.service.js";
import CurrencyValidator from "../services/currency-validator.service.js";
import WebhookService from "../services/webhook.service.js";
import SpendingLimitService from "../services/spending-limit.service.js";
import NotificationService from "../services/notification.service.js";
import AdminService from "../services/admin.service.js";
import SchedulerService from "../services/scheduler.service.js";
import AIAgentService from "../services/ai-agent.service.js";

import PayoutController from "../controllers/payout.controller.js";
import AIController from "../controllers/ai.controller.js";
import AIAgentController from "../controllers/ai-agent.controller.js";
import PublicApiController from "../controllers/public-api.controller.js";
import WebhookController from "../controllers/webhook.controller.js";
import SchedulerController from "../controllers/scheduler.controller.js";
import SpendingLimitController from "../controllers/spending-limit.controller.js";
import AdminController from "../controllers/admin.controller.js";

import { payoutUserLimiter } from "../middleware/rate-limit.middleware.js";
import { setGroqClient } from "../middleware/error.middleware.js";

import database from "./database.js";
import redisConnection from "./redis.js";

export default function initServices(redis) {
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
