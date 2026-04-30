// Channel service — create, manage, and query channels within a workspace.

import Channel from "../models/channel.model.js";
import Message from "../models/message.model.js";
import { assertMember, assertRole } from "./workspace.service.js";
import logger from "../utils/logger.js";
import { AppError } from "../utils/app-error.js";

// ── Create channel ────────────────────────────────────────────────────────────
export async function createChannel(workspaceId, userId, { name, description, type }) {
    await assertMember(workspaceId, userId);

    // Only admins/owners can create private channels
    if (type === "private") {
        await assertRole(workspaceId, userId, ["owner", "admin", "member"]);
    }

    const existing = await Channel.findOne({ workspaceId, name: name.toLowerCase() });
    if (existing) throw new AppError(`A channel named #${name} already exists`, 409, "CHANNEL_EXISTS");

    const channel = await Channel.create({
        workspaceId,
        name:        name.toLowerCase(),
        description: description || "",
        type:        type || "public",
        createdBy:   userId,
        members:     [userId],
    });

    logger.info("Channel created", { workspaceId, channelId: channel._id, name });
    return channel;
}

// ── List channels ─────────────────────────────────────────────────────────────
export async function listChannels(workspaceId, userId) {
    await assertMember(workspaceId, userId);

    // Return public channels + private channels the user is a member of
    const channels = await Channel.find({
        workspaceId,
        isArchived: false,
        $or: [
            { type: "public" },
            { type: "private", members: userId },
        ],
    })
        .sort({ isDefault: -1, name: 1 })
        .lean();

    return channels;
}

// ── Get single channel ────────────────────────────────────────────────────────
export async function getChannel(workspaceId, channelId, userId) {
    await assertMember(workspaceId, userId);

    const channel = await Channel.findOne({ _id: channelId, workspaceId }).lean();
    if (!channel) throw new AppError("Channel not found", 404, "CHANNEL_NOT_FOUND");

    // Private channel — only members can see it
    if (channel.type === "private") {
        const isMember = channel.members.some(m => m.toString() === userId.toString());
        if (!isMember) throw new AppError("You are not a member of this private channel", 403, "FORBIDDEN");
    }

    return channel;
}

// ── Update channel ────────────────────────────────────────────────────────────
export async function updateChannel(workspaceId, channelId, userId, updates) {
    const channel = await getChannel(workspaceId, channelId, userId);
    await assertRole(workspaceId, userId, ["owner", "admin"]);

    if (channel.isDefault && updates.name) {
        throw new AppError("Cannot rename a default channel", 400, "CANNOT_MODIFY_DEFAULT");
    }

    const allowed = ["name", "description", "topic"];
    const filtered = Object.fromEntries(
        Object.entries(updates).filter(([k]) => allowed.includes(k))
    );

    if (filtered.name) {
        const existing = await Channel.findOne({
            workspaceId,
            name: filtered.name.toLowerCase(),
            _id:  { $ne: channelId },
        });
        if (existing) throw new AppError(`A channel named #${filtered.name} already exists`, 409, "CHANNEL_EXISTS");
        filtered.name = filtered.name.toLowerCase();
    }

    return Channel.findByIdAndUpdate(channelId, { $set: filtered }, { new: true });
}

// ── Delete channel ────────────────────────────────────────────────────────────
export async function deleteChannel(workspaceId, channelId, userId) {
    const channel = await getChannel(workspaceId, channelId, userId);
    await assertRole(workspaceId, userId, ["owner", "admin"]);

    if (channel.isDefault) throw new AppError("Cannot delete a default channel", 400, "CANNOT_MODIFY_DEFAULT");

    await Channel.findByIdAndUpdate(channelId, { isArchived: true });
    logger.info("Channel archived", { workspaceId, channelId });
}

// ── Join channel ──────────────────────────────────────────────────────────────
export async function joinChannel(workspaceId, channelId, userId) {
    await assertMember(workspaceId, userId);

    const channel = await Channel.findOne({ _id: channelId, workspaceId });
    if (!channel) throw new AppError("Channel not found", 404, "CHANNEL_NOT_FOUND");
    if (channel.type === "private") throw new AppError("Cannot join a private channel", 403, "FORBIDDEN");

    const alreadyMember = channel.members.some(m => m.toString() === userId.toString());
    if (alreadyMember) return channel;

    channel.members.push(userId);
    await channel.save();
    return channel;
}

// ── Leave channel ─────────────────────────────────────────────────────────────
export async function leaveChannel(workspaceId, channelId, userId) {
    const channel = await Channel.findOne({ _id: channelId, workspaceId });
    if (!channel) throw new AppError("Channel not found", 404, "CHANNEL_NOT_FOUND");
    if (channel.isDefault) throw new AppError("Cannot leave a default channel", 400, "CANNOT_MODIFY_DEFAULT");

    channel.members = channel.members.filter(m => m.toString() !== userId.toString());
    await channel.save();
}

// ── Pin message ───────────────────────────────────────────────────────────────
export async function pinMessage(workspaceId, channelId, messageId, userId) {
    await assertMember(workspaceId, userId);

    const channel = await Channel.findOne({ _id: channelId, workspaceId });
    if (!channel) throw new AppError("Channel not found", 404, "CHANNEL_NOT_FOUND");

    const alreadyPinned = channel.pinnedMessages.some(
        p => p.messageId.toString() === messageId.toString()
    );
    if (alreadyPinned) throw new AppError("Message is already pinned", 409, "ALREADY_PINNED");
    if (channel.pinnedMessages.length >= 10) throw new AppError("Cannot pin more than 10 messages", 400, "PIN_LIMIT_REACHED");

    channel.pinnedMessages.push({ messageId, pinnedBy: userId });
    await channel.save();
    return channel.pinnedMessages;
}

// ── Unpin message ─────────────────────────────────────────────────────────────
export async function unpinMessage(workspaceId, channelId, messageId, userId) {
    await assertMember(workspaceId, userId);

    const channel = await Channel.findOne({ _id: channelId, workspaceId });
    if (!channel) throw new AppError("Channel not found", 404, "CHANNEL_NOT_FOUND");

    channel.pinnedMessages = channel.pinnedMessages.filter(
        p => p.messageId.toString() !== messageId.toString()
    );
    await channel.save();
}

// ── Search messages in channel ────────────────────────────────────────────────
export async function searchMessages(workspaceId, channelId, userId, query, { limit = 20 } = {}) {
    await getChannel(workspaceId, channelId, userId);

    const results = await Message.find({
        channelId,
        isDeleted: false,
        $text: { $search: query },
    })
        .sort({ score: { $meta: "textScore" } })
        .limit(Math.min(limit, 50))
        .populate("senderId", "username")
        .lean();

    return results;
}
