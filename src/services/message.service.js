// Message service — send, edit, delete, react to, and thread messages.
// Every message creation publishes an event to RabbitMQ so workflows
// can be triggered and analytics can be tracked asynchronously.

import Message from "../models/message.model.js";
import Channel from "../models/channel.model.js";
import DirectMessage from "../models/direct-message.model.js";
import Notification from "../models/notification.model.js";
import { assertMember } from "./workspace.service.js";
import websocketServer from "../config/websocket.js";
import logger from "../utils/logger.js";
import { AppError } from "../utils/app-error.js";

// Extract @userId mentions from message content
// Format: @[username](userId) — similar to Slack's mention format
function extractMentions(content) {
    const mentionRegex = /@\[([^\]]+)\]\(([a-f0-9]{24})\)/g;
    const mentions = [];
    let match;
    while ((match = mentionRegex.exec(content)) !== null) {
        mentions.push(match[2]); // the userId part
    }
    return [...new Set(mentions)]; // deduplicate
}

// ── Send message to channel ───────────────────────────────────────────────────
export async function sendMessage(workspaceId, channelId, senderId, { content, parentId }) {
    await assertMember(workspaceId, senderId);

    const channel = await Channel.findOne({ _id: channelId, workspaceId, isArchived: false });
    if (!channel) throw new AppError("Channel not found", 404, "CHANNEL_NOT_FOUND");

    const mentions = extractMentions(content);

    const message = await Message.create({
        workspaceId,
        channelId,
        senderId,
        content,
        mentions,
        parentId: parentId || null,
    });

    // If this is a thread reply, increment the parent's thread count
    if (parentId) {
        await Message.findByIdAndUpdate(parentId, { $inc: { threadCount: 1 } });
    }

    // Update channel's last message preview
    await Channel.findByIdAndUpdate(channelId, {
        lastMessageAt:      new Date(),
        lastMessagePreview: content.slice(0, 100),
        $inc: { messageCount: 1 },
    });

    // Create mention notifications (fire and forget — don't block the response)
    if (mentions.length > 0) {
        createMentionNotifications(message, mentions, workspaceId, channelId).catch(err =>
            logger.error("Failed to create mention notifications:", err.message)
        );
    }

    const populated = await message.populate("senderId", "username email");

    // Emit WebSocket event for real-time UI updates
    websocketServer.emitMessageCreated(workspaceId, channelId, populated);

    return populated;
}

// ── Get messages in channel (paginated) ───────────────────────────────────────
export async function getMessages(workspaceId, channelId, userId, { before, limit = 50 } = {}) {
    await assertMember(workspaceId, userId);

    const query = {
        channelId,
        workspaceId,
        parentId:  null, // only root messages — threads are fetched separately
        isDeleted: false,
    };

    // Cursor-based pagination — "give me messages before this ID"
    if (before) {
        const cursor = await Message.findById(before).select("createdAt").lean();
        if (cursor) query.createdAt = { $lt: cursor.createdAt };
    }

    const messages = await Message.find(query)
        .sort({ createdAt: -1 })
        .limit(Math.min(limit, 100))
        .populate("senderId", "username email")
        .lean();

    return messages.reverse(); // return oldest first
}

// ── Get thread replies ────────────────────────────────────────────────────────
export async function getThread(workspaceId, channelId, messageId, userId) {
    await assertMember(workspaceId, userId);

    const [root, replies] = await Promise.all([
        Message.findOne({ _id: messageId, channelId, isDeleted: false })
            .populate("senderId", "username email")
            .lean(),
        Message.find({ parentId: messageId, isDeleted: false })
            .sort({ createdAt: 1 })
            .populate("senderId", "username email")
            .lean(),
    ]);

    if (!root) throw new AppError("Message not found", 404, "MESSAGE_NOT_FOUND");
    return { root, replies };
}

// ── Edit message ──────────────────────────────────────────────────────────────
export async function editMessage(workspaceId, channelId, messageId, userId, newContent) {
    const message = await Message.findOne({ _id: messageId, channelId, isDeleted: false });
    if (!message) throw new AppError("Message not found", 404, "MESSAGE_NOT_FOUND");
    if (message.senderId.toString() !== userId.toString()) {
        throw new AppError("You can only edit your own messages", 403, "FORBIDDEN");
    }

    // Keep edit history (last 5 edits)
    if (message.editHistory.length >= 5) message.editHistory.shift();
    message.editHistory.push({ content: message.content, editedAt: new Date() });

    message.content  = newContent;
    message.isEdited = true;
    message.mentions = extractMentions(newContent);

    await message.save();
    const populated = await message.populate("senderId", "username email");

    websocketServer.emitMessageUpdated(workspaceId, channelId, populated);

    return populated;
}

// ── Delete message ────────────────────────────────────────────────────────────
export async function deleteMessage(workspaceId, channelId, messageId, userId) {
    const message = await Message.findOne({ _id: messageId, channelId });
    if (!message) throw new AppError("Message not found", 404, "MESSAGE_NOT_FOUND");

    // Users can delete their own messages; admins can delete any message
    const member = await assertMember(workspaceId, userId);
    const isOwn = message.senderId.toString() === userId.toString();
    const isAdmin = ["owner", "admin"].includes(member.role);

    if (!isOwn && !isAdmin) {
        throw new AppError("You can only delete your own messages", 403, "FORBIDDEN");
    }

    // Soft delete — keep the record, hide the content
    message.isDeleted = true;
    message.content   = "[Message deleted]";
    message.deletedAt = new Date();
    await message.save();

    websocketServer.emitMessageDeleted(workspaceId, channelId, messageId);
}

// ── Add reaction ──────────────────────────────────────────────────────────────
export async function addReaction(workspaceId, channelId, messageId, userId, emoji) {
    await assertMember(workspaceId, userId);

    const message = await Message.findOne({ _id: messageId, channelId, isDeleted: false });
    if (!message) throw new AppError("Message not found", 404, "MESSAGE_NOT_FOUND");

    const existing = message.reactions.find(r => r.emoji === emoji);
    if (existing) {
        // Already reacted with this emoji — check if this user already reacted
        if (existing.userIds.some(id => id.toString() === userId.toString())) {
            throw new AppError("You already reacted with this emoji", 409, "ALREADY_REACTED");
        }
        existing.userIds.push(userId);
        existing.count++;
    } else {
        message.reactions.push({ emoji, userIds: [userId], count: 1 });
    }

    await message.save();

    websocketServer.emitReactionUpdated(workspaceId, channelId, messageId, message.reactions);

    return message.reactions;
}

// ── Remove reaction ───────────────────────────────────────────────────────────
export async function removeReaction(workspaceId, channelId, messageId, userId, emoji) {
    await assertMember(workspaceId, userId);

    const message = await Message.findOne({ _id: messageId, channelId, isDeleted: false });
    if (!message) throw new AppError("Message not found", 404, "MESSAGE_NOT_FOUND");

    const reaction = message.reactions.find(r => r.emoji === emoji);
    if (!reaction) throw new AppError("Reaction not found", 404, "REACTION_NOT_FOUND");

    reaction.userIds = reaction.userIds.filter(id => id.toString() !== userId.toString());
    reaction.count   = reaction.userIds.length;

    // Remove the reaction entry entirely if no one is using it
    if (reaction.count === 0) {
        message.reactions = message.reactions.filter(r => r.emoji !== emoji);
    }

    await message.save();

    websocketServer.emitReactionUpdated(workspaceId, channelId, messageId, message.reactions);

    return message.reactions;
}

// ── Bookmark message ──────────────────────────────────────────────────────────
export async function bookmarkMessage(workspaceId, messageId, userId) {
    await assertMember(workspaceId, userId);

    const message = await Message.findById(messageId);
    if (!message) throw new AppError("Message not found", 404, "MESSAGE_NOT_FOUND");

    const alreadyBookmarked = message.bookmarkedBy.some(id => id.toString() === userId.toString());
    if (alreadyBookmarked) throw new AppError("Already bookmarked", 409, "ALREADY_BOOKMARKED");

    message.bookmarkedBy.push(userId);
    await message.save();
}

// ── Remove bookmark ───────────────────────────────────────────────────────────
export async function removeBookmark(workspaceId, messageId, userId) {
    await assertMember(workspaceId, userId);

    await Message.findByIdAndUpdate(messageId, {
        $pull: { bookmarkedBy: userId },
    });
}

// ── Get bookmarks ─────────────────────────────────────────────────────────────
export async function getBookmarks(workspaceId, userId, { page = 1, limit = 20 } = {}) {
    await assertMember(workspaceId, userId);

    const skip = (page - 1) * limit;
    const messages = await Message.find({
        workspaceId,
        bookmarkedBy: userId,
        isDeleted:    false,
    })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("senderId", "username email")
        .lean();

    return messages;
}

// ── Global workspace search ───────────────────────────────────────────────────
export async function searchWorkspace(workspaceId, userId, query, { limit = 20 } = {}) {
    await assertMember(workspaceId, userId);

    const results = await Message.find({
        workspaceId,
        isDeleted: false,
        $text: { $search: query },
    })
        .sort({ score: { $meta: "textScore" } })
        .limit(Math.min(limit, 50))
        .populate("senderId", "username email")
        .populate("channelId", "name")
        .lean();

    return results;
}

// ── Internal: create mention notifications ────────────────────────────────────
async function createMentionNotifications(message, mentionedUserIds, workspaceId, channelId) {
    const notifications = mentionedUserIds.map(userId => ({
        userId,
        workspaceId,
        type:     "mention",
        title:    "You were mentioned",
        body:     message.content.slice(0, 100),
        link:     `/workspace/${workspaceId}/channel/${channelId}`,
        actorId:  message.senderId,
        entityId: message._id,
        entityType: "Message",
    }));

    await Notification.insertMany(notifications);
}
