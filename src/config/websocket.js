// This file sets up the Socket.IO server for real-time communication.
// When a payout is processed, we use this to instantly notify the user in their browser
// without them having to refresh or poll the API.

import { Server } from "socket.io";
import logger from "../utils/logger.js";

class WebSocketServer {
    constructor() {
        this.io = null;

        // We keep a map of userId -> Set of socket IDs.
        // One user can have multiple browser tabs open, so they might have multiple sockets.
        // The Set makes it easy to track all of them and clean up when they disconnect.
        this.clients = new Map();
    }

    // Attach Socket.IO to the existing HTTP server.
    // Must be called after the HTTP server is created but before it starts listening.
    initialize(httpServer) {
        this.io = new Server(httpServer, {
            cors: {
                origin:      process.env.CORS_ORIGIN || "*",
                methods:     ["GET", "POST"],
                credentials: true,
            },
            pingTimeout:  60000, // wait 60s for a pong before assuming the client is gone
            pingInterval: 25000, // send a ping every 25s to keep the connection alive
            transports:   ["websocket", "polling"], // try WebSocket first, fall back to HTTP polling
        });

        // Register all the event handlers
        this._setupHandlers();

        logger.info("WebSocket server initialized");
        return this.io;
    }

    _setupHandlers() {
        // This fires every time a new client connects
        this.io.on("connection", (socket) => {
            logger.info("WebSocket client connected", {
                socketId:  socket.id,
                transport: socket.conn.transport.name,
            });

            // Listen for the events this socket might send us
            socket.on("authenticate", (data) => this._handleAuth(socket, data));
            socket.on("subscribe",    (data) => this._handleSubscribe(socket, data));
            socket.on("disconnect",   (reason) => this._handleDisconnect(socket, reason));
            socket.on("error",        (err) => {
                logger.error("Socket error", { socketId: socket.id, error: err.message });
            });
        });
    }

    // When a client connects, they send an "authenticate" event with their userId.
    // We use this to put them in a room named after their userId so we can send them
    // targeted events later (e.g. "your payout is done").
    _handleAuth(socket, data) {
        try {
            const { userId } = data;
            if (!userId) throw new Error("userId is required");

            // Save the userId on the socket object so we can find it on disconnect
            socket.userId = userId;

            // Join a room named "user:<userId>" — this lets us emit to just this user
            socket.join(`user:${userId}`);

            // Add this socket to our client map
            if (!this.clients.has(userId)) {
                this.clients.set(userId, new Set());
            }
            this.clients.get(userId).add(socket.id);

            // Tell the client they're authenticated
            socket.emit("authenticated", { success: true, userId, socketId: socket.id });

            logger.info("WebSocket client authenticated", { socketId: socket.id, userId });
        } catch (error) {
            logger.error("WebSocket auth error:", error.message);
            socket.emit("authentication_error", { success: false, error: error.message });
        }
    }

    // Clients can subscribe to additional channels (e.g. admin broadcast rooms)
    _handleSubscribe(socket, data) {
        try {
            const { channels } = data;
            if (!Array.isArray(channels)) return;

            // Join each requested room
            channels.forEach((ch) => socket.join(ch));
            socket.emit("subscribed", { success: true, channels });
        } catch (error) {
            logger.error("WebSocket subscribe error:", error.message);
            socket.emit("subscription_error", { success: false, error: error.message });
        }
    }

    // Clean up when a client disconnects (browser tab closed, network dropped, etc.)
    _handleDisconnect(socket, reason) {
        logger.info("WebSocket client disconnected", {
            socketId: socket.id,
            userId:   socket.userId,
            reason,
        });

        // Remove this socket from the client map
        // If this was the user's last socket (all tabs closed), remove the user entry entirely
        if (socket.userId && this.clients.has(socket.userId)) {
            const sockets = this.clients.get(socket.userId);
            sockets.delete(socket.id);
            if (sockets.size === 0) this.clients.delete(socket.userId);
        }
    }

    // Send an event to ALL sockets belonging to a specific user.
    // This works even if they have multiple tabs open — all of them get the message.
    emitToUser(userId, event, data) {
        if (!this.io) return;
        try {
            // io.to("user:<userId>") targets the room we put them in during auth
            this.io.to(`user:${userId}`).emit(event, {
                ...data,
                timestamp: new Date().toISOString(),
            });
        } catch (error) {
            logger.error("WebSocket emit error:", { userId, event, error: error.message });
        }
    }

    // These are shortcut methods for the four payout lifecycle events.
    // The API and worker call these instead of calling emitToUser directly.

    // Payout was accepted and queued — fires immediately when the API receives the request
    emitPayoutInitiated(userId, data) {
        this.emitToUser(userId, "PAYOUT_INITIATED", { status: "initiated", ...data });
    }

    // Worker picked up the message and started processing
    emitPayoutProcessing(userId, data) {
        this.emitToUser(userId, "PAYOUT_PROCESSING", { status: "processing", ...data });
    }

    // Payout finished successfully — balance was deducted
    emitPayoutCompleted(userId, data) {
        this.emitToUser(userId, "PAYOUT_COMPLETED", { status: "completed", ...data });
    }

    // Something went wrong — payout failed
    emitPayoutFailed(userId, data) {
        this.emitToUser(userId, "PAYOUT_FAILED", { status: "failed", ...data });
    }

    // Check if a user has at least one active socket connection right now
    isUserConnected(userId) {
        return this.clients.has(userId) && this.clients.get(userId).size > 0;
    }

    // Returns the total number of connected clients — used in the health check
    getConnectedClientsCount() {
        return this.io?.engine?.clientsCount ?? 0;
    }

    // Gracefully close the Socket.IO server during app shutdown
    async close() {
        return new Promise((resolve) => {
            if (this.io) {
                this.io.close(() => {
                    logger.info("WebSocket server closed");
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }
}

export default new WebSocketServer();
