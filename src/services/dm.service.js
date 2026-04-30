// DM service — direct messages between workspace members.
// Supports 1:1 and group DMs (up to 8 participants).
// Messages in DMs use the same Message model as channels, with dmId set.

import DirectMessage from "../models/direct-message.model.js";
import Message from "../models/message.model.js";
import Notification from "../models/notification.model.js";
import { assertMember } from "./workspace.service.js";
import websocketServer from "../config/websocket.js";
import logger from "../utils/logger.js";
import { AppError } from "../utils/app-error.js";

// ── Start or get a DM conversation ───────────────────────────────────────────
// If a DM between these exact participants already exists, return it.
// Otherwise create a new one. This is idempotent — calling it twice is safe.
export async function getOrCreateDM(workspaceId, initiatorId, participantIds) {
    // Always include the initiator in the participants list
    const allParticipants = [...new Set([initiatorId.toString(), ...participantIds.map(String)])];

    if (allParticipants.length < 2) {
        throw new AppError("A DM requires at least 2 participants", 400, "INVALID_PARTICIPANTS");
    }
    if (allParticipants.length > 8) {
        throw new AppError("Group DMs are limited to 8 participants", 400, "INVALID_PARTICIPANTS");
    }

    // Verify all participants are workspace members
    for (const userId of allParticipants) {
        await assertMember(workspaceId, userId);
    }

    // Sort participant IDs for consistent deduplication
    const sorted = [...allParticipants].sort();

    // Check if this exact DM already exists
    const existing = await DirectMessage.findOne({
        workspaceId,
        participants: { $all: sorted, $size: sorted.length },
    });

    if (existing) {
        // Re-open if the initiator had closed it
        if (existing.closedBy.some(id => id.toString() === initiatorId.toString())) {
            existing.closedBy = existing.closedBy.filter(id => id.toString() !== initiatorId.toString());
            await existing.save();
        }
        return existing;
    }

    const dm = await DirectMessage.create({
        workspaceId,
        participants: sorted,
        isGroup:      sorted.length > 2,
    });

    logger.info("DM created", { workspaceId, dmId: dm._id, participants: sorted.length });
    return dm;
}

// ── List DMs for a user ───────────────────────────────────────────────────────
export async function listDMs(workspaceId, userId) {
    await assertMember(workspaceId, userId);

    const dms = await DirectMessage.find({
        workspaceId,
        participants: userId,
        closedBy:     { $ne: userId }, // exclude DMs the user has closed
    })
        .sort({ lastMessageAt: -1 })
        .populate("participants", "username email")
        .lean();

    return dms;
}

// ── Get a single DM ───────────────────────────────────────────────────────────
export async function getDM(workspaceId, dmId, userId) {
    await assertMember(workspaceId, userId);

    const dm = await DirectMessage.findOne({ _id: dmId, workspaceId, participants: userId })
        .populate("participants", "username email")
        .lean();

    if (!dm) throw new AppError("DM not found or you are not a participant", 404, "DM_NOT_FOUND");
    return dm;
}

// ── Send a DM message ─────────────────────────────────────────────────────────
export async function sendDMMessage(workspaceId, dmId, senderId, { content }) {
    const dm = await getDM(workspaceId, dmId, senderId);

    const message = await Message.create({
        workspaceId,
        dmId,
        senderId,
        content,
    });

    // Update DM preview
    await DirectMessage.findByIdAndUpdate(dmId, {
        lastMessageAt:      new Date(),
        lastMessagePreview: content.slice(0, 100),
        $inc: { messageCount: 1 },
        // Re-open the DM for all participants who had closed it
        $pull: { closedBy: { $in: dm.participants.map(p => p._id || p) } },
    });

    // Notify other participants
    const otherParticipants = dm.participants
        .map(p => (p._id || p).toString())
        .filter(id => id !== senderId.toString());

    if (otherParticipants.length > 0) {
        const notifications = otherParticipants.map(userId => ({
            userId,
            workspaceId,
            type:     "dm",
            title:    "New direct message",
            body:     content.slice(0, 100),
            link:     `/workspace/${workspaceId}/dm/${dmId}`,
            actorId:  senderId,
            entityId: message._id,
            entityType: "Message",
        }));
        await Notification.insertMany(notifications).catch(err =>
            logger.error("Failed to create DM notifications:", err.message)
        );
    }

    const populated = await message.populate("senderId", "username email");

    // Emit WebSocket event
    websocketServer.emitMessageCreated(workspaceId, dmId, populated);

    return populated;
}

// ── Get DM messages (paginated) ───────────────────────────────────────────────
export async function getDMMessages(workspaceId, dmId, userId, { before, limit = 50 } = {}) {
    await getDM(workspaceId, dmId, userId);

    const query = { dmId, isDeleted: false };

    if (before) {
        const cursor = await Message.findById(before).select("createdAt").lean();
        if (cursor) query.createdAt = { $lt: cursor.createdAt };
    }

    const messages = await Message.find(query)
        .sort({ createdAt: -1 })
        .limit(Math.min(limit, 100))
        .populate("senderId", "username email")
        .lean();

    return messages.reverse();
}

// ── Close a DM (hide from sidebar) ───────────────────────────────────────────
export async function closeDM(workspaceId, dmId, userId) {
    const dm = await DirectMessage.findOne({ _id: dmId, workspaceId, participants: userId });
    if (!dm) throw new AppError("DM not found", 404, "DM_NOT_FOUND");

    if (!dm.closedBy.some(id => id.toString() === userId.toString())) {
        dm.closedBy.push(userId);
        await dm.save();
    }
}

// ── Get DM members ────────────────────────────────────────────────────────────
export async function getDMMembers(workspaceId, dmId, userId) {
    const dm = await getDM(workspaceId, dmId, userId);
    return dm.participants;
}
