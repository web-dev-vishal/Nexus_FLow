// Entry point for the API gateway process.
// Loads environment variables, initializes the app, and starts the HTTP server.
// Handles graceful shutdown on SIGTERM/SIGINT so in-flight requests can finish.

// Load environment variables first — everything else depends on them
import "dotenv/config";
import Application from "./src/app.js";
import logger from "./src/utils/logger.js";

const PORT = process.env.PORT || 5000;

// Keep a reference so the shutdown handler can call app.shutdown()
let app = null;

async function start() {
    try {
        app = new Application();

        // Connect to MongoDB, Redis, RabbitMQ, and set up all routes
        await app.initialize();

        app.getServer().listen(PORT, () => {
            logger.info(`Server listening on port ${PORT}`, {
                env:        process.env.NODE_ENV || "development",
                aiFeatures: process.env.ENABLE_AI_FEATURES === "true",
            });
        });
    } catch (error) {
        logger.error("Failed to start server:", error.message);
        process.exit(1);
    }
}

// Graceful shutdown — close connections cleanly instead of killing the process abruptly.
// This gives in-flight requests time to complete and prevents data corruption.
async function shutdown(signal) {
    logger.info(`${signal} received — shutting down gracefully`);
    try {
        if (app) await app.shutdown();
        process.exit(0);
    } catch (error) {
        logger.error("Error during shutdown:", error.message);
        process.exit(1);
    }
}

// Handle Docker stop (SIGTERM) and Ctrl+C (SIGINT)
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

// These two should never fire in a healthy app.
// If they do, log the error and shut down cleanly rather than leaving the process in a broken state.
process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception:", error);
    shutdown("uncaughtException");
});

process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled rejection:", reason);
    shutdown("unhandledRejection");
});

start();
