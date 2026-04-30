import express from "express";
import http from "http";

import database from "./config/database.js";
import redisConnection from "./config/redis.js";
import rabbitmq from "./config/rabbitmq.js";
import websocketServer from "./config/websocket.js";

import setupMiddleware from "./config/middleware.js";
import initServices from "./config/services.js";
import setupRoutes from "./config/routes.js";
import setupWebSocketBridge from "./config/websocket-bridge.js";

import { errorHandler, notFoundHandler } from "./middleware/error.middleware.js";
import { startQueueDepthPolling } from "./utils/metrics.js";

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

        setupMiddleware(this.app);

        // Wire up services and pass them into routes
        const services = initServices(this.redis);
        setupRoutes(this.app, services);
        this._setupErrorHandling();

        // HTTP server must be created before Socket.IO so they share the same port
        this.server = http.createServer(this.app);
        // Pass the Redis client so Socket.IO can use the Redis adapter for multi-instance support
        this.io = websocketServer.initialize(this.server, this.redis);

        // Bridge Redis pub/sub → Socket.IO so the worker can push real-time events
        setupWebSocketBridge(this.redis);

        // Start polling RabbitMQ queue depths for Prometheus metrics (every 30s)
        this.queueDepthPoller = startQueueDepthPolling(() => rabbitmq.getChannel());

        // Start the scheduler — polls every minute for due scheduled payouts
        this.scheduler = services.scheduler;
        this.scheduler.start();

        logger.info("Application initialized successfully");
        return this;
    }

    _setupErrorHandling() {
        // 404 handler must come after all routes
        this.app.use(notFoundHandler);
        // Global error handler catches anything passed to next(err)
        this.app.use(errorHandler);
    }

    getServer() { return this.server; }
    getApp()    { return this.app; }

    async shutdown() {
        logger.info("Shutting down...");

        // Stop the scheduler first so no new payouts are kicked off during shutdown
        if (this.scheduler) this.scheduler.stop();

        // Stop the queue depth poller
        if (this.queueDepthPoller) clearInterval(this.queueDepthPoller);

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
