// Workspace service — create, manage, and query workspaces.
// Handles membership, invites, and workspace-level settings.

import Workspace from "../models/workspace.model.js";
import WorkspaceMember from "../models/workspace-member.model.js";
import Channel from "../models/channel.model.js";
import User from "../models/user.model.js";
import { getRedis } from "../lib/redis.js";
import logger from "../utils/logger.js";
import { AppError } from "../utils/app-error.js";

// Cache TTL for workspace data — 5 minutes
const WORKSPACE_CACHE_TTL = 5 * 60;

// ── Create workspace ──────────────────────────────────────────────────────────
export async function createWorkspace(ownerId, { name, description, icon }) {
    // Generate a unique slug from the name
    let slug = Workspace.generateSlug(name);

    // If slug is taken, append a short random suffix
    const existing = await Workspace.findOne({ slug });
    if (existing) {
        slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
    }

    const workspace = await Workspace.create({
        name,
        slug,
        description: description || "",
        icon:        icon || "🚀",
        ownerId,
    });

    // Add the creator as owner member
    await WorkspaceMember.create({
        workspaceId: workspace._id,
        userId:      ownerId,
        role:        "owner",
        joinedAt:    new Date(),
    });

    // Create the default #general channel every workspace starts with
    await Channel.create({
        workspaceId: workspace._id,
        name:        "general",
        description: "Company-wide announcements and work-based matters",
        type:        "public",
        createdBy:   ownerId,
        isDefault:   true,
        members:     [ownerId],
    });

    // Create a #random channel too — people need somewhere to be human
    await Channel.create({
        workspaceId: workspace._id,
        name:        "random",
        description: "Non-work banter and water cooler conversation",
        type:        "public",
        createdBy:   ownerId,
        isDefault:   true,
        members:     [ownerId],
    });

    logger.info("Workspace created", { workspaceId: workspace._id, ownerId, name });
    return workspace;
}

// ── Get workspace (with cache) ────────────────────────────────────────────────
export async function getWorkspace(workspaceId) {
    const redis = getRedis();
    const cacheKey = `workspace:${workspaceId}`;

    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const workspace = await Workspace.findById(workspaceId).lean();
    if (!workspace) throw new AppError("Workspace not found", 404, "WORKSPACE_NOT_FOUND");

    await redis.set(cacheKey, JSON.stringify(workspace), "EX", WORKSPACE_CACHE_TTL);
    return workspace;
}

// ── List workspaces for a user ────────────────────────────────────────────────
export async function getUserWorkspaces(userId) {
    const memberships = await WorkspaceMember.find({ userId, isActive: true })
        .select("workspaceId role joinedAt")
        .lean();

    if (memberships.length === 0) return [];

    const workspaceIds = memberships.map(m => m.workspaceId);
    const workspaces = await Workspace.find({
        _id:      { $in: workspaceIds },
        isActive: true,
    }).lean();

    // Merge role info into each workspace
    const roleMap = Object.fromEntries(memberships.map(m => [m.workspaceId.toString(), m.role]));
    return workspaces.map(ws => ({
        ...ws,
        role: roleMap[ws._id.toString()] || "member",
    }));
}

// ── Update workspace ──────────────────────────────────────────────────────────
export async function updateWorkspace(workspaceId, userId, updates) {
    await assertRole(workspaceId, userId, ["owner", "admin"]);

    const allowed = ["name", "description", "icon", "settings", "aiSettings"];
    const filtered = Object.fromEntries(
        Object.entries(updates).filter(([k]) => allowed.includes(k))
    );

    const workspace = await Workspace.findByIdAndUpdate(
        workspaceId,
        { $set: filtered },
        { new: true, runValidators: true }
    );

    if (!workspace) throw new AppError("Workspace not found", 404, "WORKSPACE_NOT_FOUND");

    // Bust the cache
    await getRedis().del(`workspace:${workspaceId}`);
    return workspace;
}

// ── Delete workspace ──────────────────────────────────────────────────────────
export async function deleteWorkspace(workspaceId, userId) {
    await assertRole(workspaceId, userId, ["owner"]);

    // Soft delete — keeps data for potential recovery
    await Workspace.findByIdAndUpdate(workspaceId, { isActive: false });
    await getRedis().del(`workspace:${workspaceId}`);

    logger.info("Workspace deleted", { workspaceId, deletedBy: userId });
}

// ── Invite member ─────────────────────────────────────────────────────────────
export async function inviteMember(workspaceId, inviterId, email, role = "member") {
    await assertRole(workspaceId, inviterId, ["owner", "admin"]);

    const workspace = await getWorkspace(workspaceId);

    // Find the user by email
    const user = await User.findOne({ email: email.toLowerCase() }).select("_id email username");
    if (!user) throw new AppError(`No account found for ${email}`, 404, "USER_NOT_FOUND");

    // Check if already a member
    const existing = await WorkspaceMember.findOne({ workspaceId, userId: user._id });
    if (existing && existing.isActive) {
        throw new AppError("User is already a member of this workspace", 409, "ALREADY_MEMBER");
    }

    if (existing && !existing.isActive) {
        // Re-activate a previously removed member
        existing.isActive = true;
        existing.role = role;
        existing.joinedAt = new Date();
        await existing.save();
    } else {
        await WorkspaceMember.create({
            workspaceId,
            userId:    user._id,
            role,
            invitedBy: inviterId,
            joinedAt:  new Date(),
        });
    }

    // Update member count
    await Workspace.findByIdAndUpdate(workspaceId, { $inc: { memberCount: 1 } });

    logger.info("Member invited to workspace", { workspaceId, userId: user._id, role });
    return { userId: user._id, email: user.email, role };
}

// ── List members ──────────────────────────────────────────────────────────────
export async function getMembers(workspaceId, { page = 1, limit = 50 } = {}) {
    const skip = (page - 1) * limit;

    const [members, total] = await Promise.all([
        WorkspaceMember.find({ workspaceId, isActive: true })
            .populate("userId", "username email")
            .sort({ joinedAt: 1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        WorkspaceMember.countDocuments({ workspaceId, isActive: true }),
    ]);

    return { members, total, page, pages: Math.ceil(total / limit) };
}

// ── Change member role ────────────────────────────────────────────────────────
export async function changeMemberRole(workspaceId, requesterId, targetUserId, newRole) {
    await assertRole(workspaceId, requesterId, ["owner", "admin"]);

    // Can't change the owner's role
    const workspace = await getWorkspace(workspaceId);
    if (workspace.ownerId.toString() === targetUserId.toString()) {
        throw new AppError("Cannot change the workspace owner's role", 403, "CANNOT_CHANGE_OWNER");
    }

    const member = await WorkspaceMember.findOneAndUpdate(
        { workspaceId, userId: targetUserId, isActive: true },
        { role: newRole },
        { new: true }
    );

    if (!member) throw new AppError("Member not found in this workspace", 404, "MEMBER_NOT_FOUND");
    return member;
}

// ── Remove member ─────────────────────────────────────────────────────────────
export async function removeMember(workspaceId, requesterId, targetUserId) {
    await assertRole(workspaceId, requesterId, ["owner", "admin"]);

    const workspace = await getWorkspace(workspaceId);
    if (workspace.ownerId.toString() === targetUserId.toString()) {
        throw new AppError("Cannot remove the workspace owner", 403, "CANNOT_REMOVE_OWNER");
    }

    await WorkspaceMember.findOneAndUpdate(
        { workspaceId, userId: targetUserId },
        { isActive: false }
    );

    await Workspace.findByIdAndUpdate(workspaceId, { $inc: { memberCount: -1 } });
}

// ── Get workspace stats ───────────────────────────────────────────────────────
export async function getWorkspaceStats(workspaceId) {
    const [memberCount, channelCount] = await Promise.all([
        WorkspaceMember.countDocuments({ workspaceId, isActive: true }),
        Channel.countDocuments({ workspaceId, isArchived: false }),
    ]);

    const workspace = await getWorkspace(workspaceId);

    return {
        memberCount,
        channelCount,
        aiTokensUsed:   workspace.aiTokensUsed,
        aiTokenBudget:  workspace.aiTokenBudget,
        aiUsagePercent: workspace.aiTokenBudget
            ? Math.round((workspace.aiTokensUsed / workspace.aiTokenBudget) * 100)
            : 0,
    };
}

// ── Helper: assert the user has one of the required roles ─────────────────────
export async function assertRole(workspaceId, userId, allowedRoles) {
    const member = await WorkspaceMember.findOne({
        workspaceId,
        userId,
        isActive: true,
    });

    if (!member) throw new AppError("You are not a member of this workspace", 403, "NOT_A_MEMBER");
    if (!allowedRoles.includes(member.role)) {
        throw new AppError(`This action requires one of these roles: ${allowedRoles.join(", ")}`, 403, "INSUFFICIENT_ROLE");
    }

    return member;
}

// ── Helper: check if user is a member (no role requirement) ──────────────────
export async function assertMember(workspaceId, userId) {
    return assertRole(workspaceId, userId, ["owner", "admin", "member", "guest"]);
}
