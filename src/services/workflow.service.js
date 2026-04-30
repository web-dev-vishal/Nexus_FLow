// Workflow service — create, manage, and execute automation workflows.
// Execution is async: the API creates a WorkflowExecution record and
// publishes a job to RabbitMQ. The workflow worker picks it up and runs
// each node in sequence, updating the execution record as it goes.

import Workflow from "../models/workflow.model.js";
import WorkflowExecution from "../models/workflow-execution.model.js";
import { assertMember, assertRole } from "./workspace.service.js";
import logger from "../utils/logger.js";
import { AppError } from "../utils/app-error.js";

// ── Create workflow ───────────────────────────────────────────────────────────
export async function createWorkflow(workspaceId, userId, data) {
    await assertMember(workspaceId, userId);

    const workflow = await Workflow.create({
        workspaceId,
        createdBy:   userId,
        name:        data.name,
        description: data.description || "",
        trigger:     data.trigger,
        nodes:       data.nodes || [],
        isEnabled:   data.isEnabled !== false,
        aiGenerated: data.aiGenerated || false,
    });

    logger.info("Workflow created", { workspaceId, workflowId: workflow._id, name: data.name });
    return workflow;
}

// ── List workflows ────────────────────────────────────────────────────────────
export async function listWorkflows(workspaceId, userId, { page = 1, limit = 20 } = {}) {
    await assertMember(workspaceId, userId);

    const skip = (page - 1) * limit;
    const [workflows, total] = await Promise.all([
        Workflow.find({ workspaceId })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate("createdBy", "username")
            .lean(),
        Workflow.countDocuments({ workspaceId }),
    ]);

    return { workflows, total, page, pages: Math.ceil(total / limit) };
}

// ── Get workflow ──────────────────────────────────────────────────────────────
export async function getWorkflow(workspaceId, workflowId, userId) {
    await assertMember(workspaceId, userId);

    const workflow = await Workflow.findOne({ _id: workflowId, workspaceId })
        .populate("createdBy", "username")
        .lean();

    if (!workflow) throw new AppError("Workflow not found", 404, "WORKFLOW_NOT_FOUND");
    return workflow;
}

// ── Update workflow ───────────────────────────────────────────────────────────
export async function updateWorkflow(workspaceId, workflowId, userId, updates) {
    await assertMember(workspaceId, userId);

    const allowed = ["name", "description", "trigger", "nodes", "isEnabled"];
    const filtered = Object.fromEntries(
        Object.entries(updates).filter(([k]) => allowed.includes(k))
    );

    const workflow = await Workflow.findOneAndUpdate(
        { _id: workflowId, workspaceId },
        { $set: filtered },
        { new: true, runValidators: true }
    );

    if (!workflow) throw new AppError("Workflow not found", 404, "WORKFLOW_NOT_FOUND");
    return workflow;
}

// ── Delete workflow ───────────────────────────────────────────────────────────
export async function deleteWorkflow(workspaceId, workflowId, userId) {
    await assertRole(workspaceId, userId, ["owner", "admin", "member"]);

    const workflow = await Workflow.findOne({ _id: workflowId, workspaceId });
    if (!workflow) throw new AppError("Workflow not found", 404, "WORKFLOW_NOT_FOUND");

    // Only the creator or an admin can delete
    const isCreator = workflow.createdBy.toString() === userId.toString();
    const member = await assertMember(workspaceId, userId);
    if (!isCreator && !["owner", "admin"].includes(member.role)) {
        throw new AppError("Only the workflow creator or an admin can delete this workflow", 403, "INSUFFICIENT_ROLE");
    }

    await Workflow.findByIdAndDelete(workflowId);
}

// ── Enable / disable workflow ─────────────────────────────────────────────────
export async function setWorkflowEnabled(workspaceId, workflowId, userId, enabled) {
    await assertMember(workspaceId, userId);

    const workflow = await Workflow.findOneAndUpdate(
        { _id: workflowId, workspaceId },
        { isEnabled: enabled },
        { new: true }
    );

    if (!workflow) throw new AppError("Workflow not found", 404, "WORKFLOW_NOT_FOUND");
    return workflow;
}

// ── Trigger workflow manually ─────────────────────────────────────────────────
// Creates an execution record and publishes to RabbitMQ.
// The actual execution happens in the workflow worker.
export async function triggerWorkflow(workspaceId, workflowId, userId, payload = {}, publisher) {
    const workflow = await getWorkflow(workspaceId, workflowId, userId);

    if (!workflow.isEnabled) throw new AppError("Workflow is disabled", 400, "WORKFLOW_DISABLED");

    const execution = await WorkflowExecution.create({
        workflowId,
        workspaceId,
        triggeredBy:    "manual",
        triggerPayload: payload,
        status:         "queued",
    });

    // Publish to the workflow execution queue
    if (publisher) {
        await publisher.publishWorkflowJob({
            executionId: execution._id.toString(),
            workflowId:  workflowId.toString(),
            workspaceId: workspaceId.toString(),
            nodes:       workflow.nodes,
            payload,
        });
    }

    return execution;
}

// ── Get execution history ─────────────────────────────────────────────────────
export async function getExecutions(workspaceId, workflowId, userId, { page = 1, limit = 20 } = {}) {
    await assertMember(workspaceId, userId);

    const skip = (page - 1) * limit;
    const [executions, total] = await Promise.all([
        WorkflowExecution.find({ workflowId, workspaceId })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean(),
        WorkflowExecution.countDocuments({ workflowId, workspaceId }),
    ]);

    return { executions, total, page, pages: Math.ceil(total / limit) };
}

// ── Get single execution ──────────────────────────────────────────────────────
export async function getExecution(workspaceId, executionId, userId) {
    await assertMember(workspaceId, userId);

    const execution = await WorkflowExecution.findOne({ _id: executionId, workspaceId }).lean();
    if (!execution) throw new AppError("Execution not found", 404, "EXECUTION_NOT_FOUND");
    return execution;
}

// ── Retry failed execution ────────────────────────────────────────────────────
export async function retryExecution(workspaceId, executionId, userId, publisher) {
    const execution = await getExecution(workspaceId, executionId, userId);

    if (execution.status !== "failed") {
        throw new AppError("Only failed executions can be retried", 400, "INVALID_STATE");
    }
    if (execution.retryCount >= execution.maxRetries) {
        throw new AppError("Maximum retry attempts reached", 400, "MAX_RETRIES_REACHED");
    }

    const workflow = await Workflow.findById(execution.workflowId).lean();
    if (!workflow) throw new AppError("Workflow not found", 404, "WORKFLOW_NOT_FOUND");

    await WorkflowExecution.findByIdAndUpdate(executionId, {
        status:     "queued",
        $inc:       { retryCount: 1 },
        startedAt:  null,
        finishedAt: null,
        error:      null,
    });

    if (publisher) {
        await publisher.publishWorkflowJob({
            executionId: executionId.toString(),
            workflowId:  execution.workflowId.toString(),
            workspaceId: workspaceId.toString(),
            nodes:       workflow.nodes,
            payload:     execution.triggerPayload || {},
        });
    }

    return WorkflowExecution.findById(executionId).lean();
}

// ── Find workflows triggered by a message keyword ─────────────────────────────
// Called by the message event consumer to check if any workflow should fire.
export async function findTriggeredWorkflows(workspaceId, messageContent) {
    const workflows = await Workflow.find({
        workspaceId,
        isEnabled:    true,
        "trigger.type": "message_keyword",
    }).lean();

    return workflows.filter(wf => {
        const { keyword, regex, caseSensitive } = wf.trigger.config || {};
        if (!keyword && !regex) return false;

        if (regex) {
            try {
                const flags = caseSensitive ? "" : "i";
                return new RegExp(regex, flags).test(messageContent);
            } catch {
                return false;
            }
        }

        if (keyword) {
            return caseSensitive
                ? messageContent.includes(keyword)
                : messageContent.toLowerCase().includes(keyword.toLowerCase());
        }

        return false;
    });
}
