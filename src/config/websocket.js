// This file sets up the Socket.IO server for real-time communication.
// When a payout is processed, we use this to instantly notify the user in their browser
// without them having to refresh or poll the API.
//
// Multi-instance support: the Redis adapter is wired so that events emitted on
// any gateway instance are forwarded to all connected clients, regardless of which
// instance they are connected to.

import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { verifyAccessToken } from "../services/token.service.js";
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
    // redisClient is the main ioredis client — we duplicate it for pub/sub so the
    // main client stays available for regular commands.
    initialize(httpServer, redisClient) {
        this.io = new Server(httpServer, {
            cors: {
                origin:      process.env.CORS_ORIGIN || (process.env.NODE_ENV === "production" ? false : "*"),
                methods:     ["GET", "POST"],
                credentials: true,
            },
            pingTimeout:  60000, // wait 60s for a pong before assuming the client is gone
            pingInterval: 25000, // send a ping every 25s to keep the connection alive
            transports:   ["websocket", "polling"], // try WebSocket first, fall back to HTTP polling
        });

        // Wire the Redis adapter so all gateway instances share Socket.IO state.
        // Each instance gets its own pub/sub connection — never share the main client
        // for pub/sub because it blocks all other commands while subscribed.
        if (redisClient) {
            const pubClient = redisClient.duplicate();
            const subClient = redisClient.duplicate();
            this.io.adapter(createAdapter(pubClient, subClient));
            logger.info("Socket.IO Redis adapter configured (multi-instance ready)");
        } else {
            logger.warn("Socket.IO Redis adapter NOT configured — single-instance mode only");
        }

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

    // When a client connects, they send an "authenticate" event with a JWT access token.
    // We verify the token, extract the userId, and put them in a targeted room.
    // This prevents unauthorized users from subscribing to another user's events.
    async _handleAuth(socket, data) {
        try {
            const { token } = data;
            if (!token) throw new Error("token is required");

            // Verify the PASETO token — reuse the same key as the HTTP auth middleware
            let decoded;
            try {
                decoded = await verifyAccessToken(token);
            } catch (err) {
                socket.emit("authenticated", { success: false, error: "Invalid or expired token" });
                return;
            }

            const userId = decoded.sub;
            if (!userId) throw new Error("Invalid token payload");

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

    // Clients can subscribe to additional channels (workspace, channel rooms).
    // We validate that the socket is authenticated and that the requested channels
    // follow the allowed naming patterns — prevents a client from subscribing to
    // another user's private room by guessing the channel name.
    _handleSubscribe(socket, data) {
        try {
            const { channels } = data;
            if (!Array.isArray(channels)) return;

            // Socket must be authenticated before subscribing to any room
            if (!socket.userId) {
                socket.emit("subscription_error", {
                    success: false,
                    error:   "Authenticate before subscribing to channels",
                });
                return;
            }

            // Allowed channel patterns:
            //   user:<own-userId>          — personal events (already joined on auth)
            //   workspace:<workspaceId>    — workspace-level events
            //   channel:<channelId>        — channel messages
            // Clients may NOT subscribe to another user's personal room.
            const ALLOWED_PREFIXES = ["workspace:", "channel:"];
            const ownUserRoom = `user:${socket.userId}`;

            const safe = channels.filter((ch) => {
                if (typeof ch !== "string" || ch.length > 200) return false;
                // Allow own user room
                if (ch === ownUserRoom) return true;
                // Allow workspace and channel rooms
                return ALLOWED_PREFIXES.some((prefix) => ch.startsWith(prefix));
            });

            const rejected = channels.filter((ch) => !safe.includes(ch));
            if (rejected.length > 0) {
                logger.warn("WebSocket subscription rejected — unauthorized channels", {
                    socketId:  socket.id,
                    userId:    socket.userId,
                    rejected,
                });
            }

            if (safe.length === 0) {
                socket.emit("subscription_error", {
                    success: false,
                    error:   "No valid channels to subscribe to",
                });
                return;
            }

            safe.forEach((ch) => socket.join(ch));
            socket.emit("subscribed", { success: true, channels: safe });
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
            this.io.to(`user:${userId}`).emit(event, {
                ...data,
                timestamp: new Date().toISOString(),
            });
        } catch (error) {
            logger.error("WebSocket emit error:", { userId, event, error: error.message });
        }
    }

    // Send an event to a specific room (workspace, channel, or DM)
    emitToRoom(roomId, event, data) {
        if (!this.io) return;
        try {
            this.io.to(roomId).emit(event, {
                ...data,
                timestamp: new Date().toISOString(),
            });
        } catch (error) {
            logger.error("WebSocket room emit error:", { roomId, event, error: error.message });
        }
    }

    // ── Payout Events ────────────────────────────────────────────────────────
    emitPayoutInitiated(userId, data) {
        this.emitToUser(userId, "PAYOUT_INITIATED", { status: "initiated", ...data });
    }

    emitPayoutProcessing(userId, data) {
        this.emitToUser(userId, "PAYOUT_PROCESSING", { status: "processing", ...data });
    }

    emitPayoutCompleted(userId, data) {
        this.emitToUser(userId, "PAYOUT_COMPLETED", { status: "completed", ...data });
    }

    emitPayoutFailed(userId, data) {
        this.emitToUser(userId, "PAYOUT_FAILED", { status: "failed", ...data });
    }

    // ── Chat Emissions ───────────────────────────────────────────────────────

    // New message created in a channel or DM
    emitMessageCreated(workspaceId, sourceId, message) {
        // sourceId is channelId or dmId
        this.emitToRoom(`workspace:${workspaceId}`, "MESSAGE_CREATED", { sourceId, message });
        this.emitToRoom(`channel:${sourceId}`, "MESSAGE_CREATED", { message });
    }

    // Message edited
    emitMessageUpdated(workspaceId, sourceId, message) {
        this.emitToRoom(`channel:${sourceId}`, "MESSAGE_UPDATED", { message });
    }

    // Message deleted
    emitMessageDeleted(workspaceId, sourceId, messageId) {
        this.emitToRoom(`channel:${sourceId}`, "MESSAGE_DELETED", { messageId });
    }

    // Reaction added or removed
    emitReactionUpdated(workspaceId, sourceId, messageId, reactions) {
        this.emitToRoom(`channel:${sourceId}`, "REACTION_UPDATED", { messageId, reactions });
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
