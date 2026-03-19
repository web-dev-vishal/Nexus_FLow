// Health check routes — used by Docker, load balancers, and monitoring tools
// to check if the service is running and all its dependencies are healthy.
//
// Three levels of detail:
//   GET /api/health       — basic "is the server up?" check
//   GET /api/health/live  — liveness probe (is the process alive?)
//   GET /api/health/ready — readiness probe (are all dependencies connected?)
//   GET /api/health/detailed — full breakdown of each dependency's status

import express from "express";

const createHealthRouter = ({ database, redis, rabbitmq, websocket }) => {
    const router = express.Router();

    // Basic health check — just confirms the server is responding
    router.get("/", (req, res) => {
        res.status(200).json({
            success:   true,
            status:    "healthy",
            timestamp: new Date().toISOString(),
            service:   "swiftpay",
        });
    });

    // Liveness probe — used by Kubernetes/Docker to know if the container should be restarted.
    // If this returns 200, the process is alive. No dependency checks here.
    router.get("/live", (req, res) => {
        res.status(200).json({ success: true, alive: true });
    });

    // Readiness probe — used by load balancers to know if this instance can accept traffic.
    // Returns 503 if any critical dependency (MongoDB, Redis, RabbitMQ) is down.
    router.get("/ready", async (req, res) => {
        try {
            const [mongoOk, redisOk, rabbitOk] = await Promise.all([
                Promise.resolve(database.isHealthy()),
                redis.isHealthy(),
                Promise.resolve(rabbitmq.isHealthy()),
            ]);

            const ready = mongoOk && redisOk && rabbitOk;
            res.status(ready ? 200 : 503).json({ success: ready, ready });
        } catch (error) {
            res.status(503).json({ success: false, ready: false, error: error.message });
        }
    });

    // Detailed health check — returns the status of each dependency individually.
    // Returns 503 if any dependency is unhealthy, but still includes all the details.
    router.get("/detailed", async (req, res) => {
        const deps = {};
        let degraded = false;

        // Check MongoDB
        try {
            deps.mongodb = { status: database.isHealthy() ? "healthy" : "unhealthy" };
            if (!database.isHealthy()) degraded = true;
        } catch (e) {
            deps.mongodb = { status: "unhealthy", error: e.message };
            degraded = true;
        }

        // Check Redis
        try {
            const ok = await redis.isHealthy();
            deps.redis = { status: ok ? "healthy" : "unhealthy" };
            if (!ok) degraded = true;
        } catch (e) {
            deps.redis = { status: "unhealthy", error: e.message };
            degraded = true;
        }

        // Check RabbitMQ
        try {
            deps.rabbitmq = { status: rabbitmq.isHealthy() ? "healthy" : "unhealthy" };
            if (!rabbitmq.isHealthy()) degraded = true;
        } catch (e) {
            deps.rabbitmq = { status: "unhealthy", error: e.message };
            degraded = true;
        }

        // Check WebSocket server — not critical, so we don't set degraded on failure
        try {
            deps.websocket = {
                status:            "healthy",
                activeConnections: websocket.getConnectedClientsCount(),
            };
        } catch (e) {
            deps.websocket = { status: "unhealthy", error: e.message };
        }

        const status = degraded ? "degraded" : "healthy";
        res.status(degraded ? 503 : 200).json({
            success:      !degraded,
            status,
            timestamp:    new Date().toISOString(),
            service:      "swiftpay",
            dependencies: deps,
        });
    });

    return router;
};

export default createHealthRouter;
