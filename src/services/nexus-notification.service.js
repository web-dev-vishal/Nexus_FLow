// NexusFlow in-app notification service.
// Handles reading, marking as read, and deleting notifications from MongoDB.
// Notifications are created by message.service.js and dm.service.js.

import Notification from "../models/notification.model.js";
import { AppError } from "../utils/app-error.js";

// ── Get notifications for a user ──────────────────────────────────────────────
export async function getNotifications(userId, { page = 1, limit = 20, unreadOnly = false } = {}) {
    const skip = (page - 1) * limit;
    const query = { userId };
    if (unreadOnly) query.isRead = false;

    const [notifications, total, unreadCount] = await Promise.all([
        Notification.find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(Math.min(limit, 50))
            .populate("actorId", "username")
            .lean(),
        Notification.countDocuments(query),
        Notification.countDocuments({ userId, isRead: false }),
    ]);

    return { notifications, total, unreadCount, page, pages: Math.ceil(total / limit) };
}

// ── Mark notifications as read ────────────────────────────────────────────────
export async function markAsRead(userId, notificationIds) {
    // If no IDs provided, mark ALL as read
    const query = { userId };
    if (notificationIds && notificationIds.length > 0) {
        query._id = { $in: notificationIds };
    }

    await Notification.updateMany(query, {
        isRead: true,
        readAt: new Date(),
    });
}

// ── Delete a notification ─────────────────────────────────────────────────────
export async function deleteNotification(userId, notificationId) {
    const result = await Notification.findOneAndDelete({ _id: notificationId, userId });
    if (!result) throw new AppError("Notification not found", 404, "NOTIFICATION_NOT_FOUND");
}

// ── Get unread count ──────────────────────────────────────────────────────────
export async function getUnreadCount(userId) {
    const count = await Notification.countDocuments({ userId, isRead: false });
    return count;
}

// ── Get notification preferences ─────────────────────────────────────────────
// Preferences are stored on the WorkspaceMember model.
// This is a convenience wrapper that reads from there.
export async function getPreferences(userId, workspaceId) {
    const { default: WorkspaceMember } = await import("../models/workspace-member.model.js");
    const member = await WorkspaceMember.findOne({ userId, workspaceId, isActive: true })
        .select("notifications")
        .lean();

    if (!member) throw new AppError("Not a member of this workspace", 404, "NOT_A_MEMBER");
    return member.notifications;
}

// ── Update notification preferences ──────────────────────────────────────────
export async function updatePreferences(userId, workspaceId, prefs) {
    const { default: WorkspaceMember } = await import("../models/workspace-member.model.js");

    const allowed = ["allMessages", "mentions", "directMessages", "email"];
    const filtered = Object.fromEntries(
        Object.entries(prefs)
            .filter(([k]) => allowed.includes(k))
            .map(([k, v]) => [`notifications.${k}`, v])
    );

    const member = await WorkspaceMember.findOneAndUpdate(
        { userId, workspaceId, isActive: true },
        { $set: filtered },
        { new: true }
    ).select("notifications");

    if (!member) throw new AppError("Not a member of this workspace", 404, "NOT_A_MEMBER");
    return member.notifications;
}
