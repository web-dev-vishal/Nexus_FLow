// This file manages the MongoDB connection for the whole app.
// We use a class so we can track connection state and reuse one connection everywhere.

import mongoose from "mongoose";
import logger from "../utils/logger.js";

class DatabaseConnection {
    constructor() {
        // We start as not connected — this gets flipped to true once MongoDB responds
        this.isConnected = false;
    }

    async connect() {
        // These options control how Mongoose manages the connection pool.
        // A pool means we keep several connections open and reuse them instead of
        // opening a new one for every database query (which would be very slow).
        const options = {
            maxPoolSize:              parseInt(process.env.MONGO_MAX_POOL_SIZE) || 10,  // at most N connections open at the same time
            minPoolSize:              parseInt(process.env.MONGO_MIN_POOL_SIZE) || 2,   // always keep at least N warm so queries don't wait
            socketTimeoutMS:          45000, // if a query takes longer than 45s, give up
            serverSelectionTimeoutMS: 5000,  // if MongoDB isn't reachable in 5s, throw an error
            family:                   4,     // use IPv4 — avoids weird IPv6 DNS issues on some servers
        };

        try {
            // Actually connect to MongoDB using the URI from the .env file
            await mongoose.connect(process.env.MONGO_URI, options);

            // If we get here, the connection worked
            this.isConnected = true;

            logger.info("MongoDB connected", {
                host: mongoose.connection.host,
                db:   mongoose.connection.name,
            });
        } catch (error) {
            // Connection failed — log it and re-throw so the app knows to stop starting up
            logger.error("MongoDB connection failed:", error.message);
            throw error;
        }

        // Register event listeners AFTER the initial connect.
        // These fire if something goes wrong later while the app is running.

        // Something went wrong with the connection (network blip, auth error, etc.)
        mongoose.connection.on("error", (err) => {
            logger.error("MongoDB error:", err.message);
            this.isConnected = false;
        });

        // MongoDB dropped the connection — could be a restart or network issue
        mongoose.connection.on("disconnected", () => {
            logger.warn("MongoDB disconnected");
            this.isConnected = false;
        });

        // Mongoose automatically tries to reconnect — this fires when it succeeds
        mongoose.connection.on("reconnected", () => {
            logger.info("MongoDB reconnected");
            this.isConnected = true;
        });
    }

    // Call this during graceful shutdown to close the connection cleanly
    async disconnect() {
        await mongoose.disconnect();
        this.isConnected = false;
        logger.info("MongoDB disconnected gracefully");
    }

    // Used by the health check endpoint to report if the database is reachable.
    // readyState === 1 is Mongoose's way of saying "connected and ready"
    isHealthy() {
        return this.isConnected && mongoose.connection.readyState === 1;
    }
}

// Export a single shared instance — the whole app uses this one object
export default new DatabaseConnection();
