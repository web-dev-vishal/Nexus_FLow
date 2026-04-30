import websocketServer from "./websocket.js";
import logger from "../utils/logger.js";

export default function setupWebSocketBridge(redis) {
    // The worker process can't talk to Socket.IO directly (different process).
    // Instead it publishes events to Redis, and we forward them to the right user here.
    // We use a dedicated subscriber connection — never share the main client for pub/sub.
    const subscriber = redis.duplicate();

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
