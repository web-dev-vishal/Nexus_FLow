// Workflow worker — consumes jobs from workflow_queue and executes automation workflows.
// Each job contains a workflow execution ID and the list of nodes to run.
// Nodes are executed in sequence; the execution record is updated after each node.
// On failure, the execution is marked failed and the job is nacked to the DLQ.

import "dotenv/config";

import database from "../config/database.js";
import redisConnection from "../config/redis.js";
import rabbitmq from "../config/rabbitmq.js";

import WorkflowExecution from "../models/workflow-execution.model.js";
import Workflow from "../models/workflow.model.js";
import Channel from "../models/channel.model.js";
import Message from "../models/message.model.js";

import GroqClient from "../services/groq.service.js";
import OpenRouterService from "../services/openrouter.service.js";

import logger from "../utils/logger.js";

// ── Node Executors ───────────────────────────────────────────────────────────
// Individual logic for each node type. Returns output to be merged into context.

const nodeExecutors = {

    // ai_agent — call an AI model with a prompt
    async ai_agent(config, context) {
        const { provider = "groq", task, prompt, model } = config;
        const resolvedPrompt = interpolate(prompt || "", context);

        if (provider === "openrouter") {
            const or = new OpenRouterService();
            if (task === "summarise") return { output: await or.summarise(resolvedPrompt) };
            if (task === "sentiment") return { output: await or.analyseSentiment(resolvedPrompt) };
            if (task === "translate") return { output: await or.translate(resolvedPrompt, config.targetLanguage || "English") };
            if (task === "research")    return { output: await or.research(resolvedPrompt) };
            if (task === "document_qa") return { output: await or.documentQA(resolvedPrompt, context.document || "") };
            if (task === "smart_reply") return { output: await or.suggestReplies(resolvedPrompt) };
            if (task === "explain_code") return { output: await or.explainCode(resolvedPrompt) };
            if (task === "critique")    return { output: await or.critique(resolvedPrompt, config.originalTask || "") };
            return { output: await or.chat(resolvedPrompt, config.systemPrompt || "You are a helpful assistant.", { model }) };
        }

        // Default: Groq
        const groq = new GroqClient();
        
        // Specialist tasks (e.g. fraud scoring) have dedicated logic
        if (task === "score_fraud") {
            const result = await groq.scoreFraudRisk({ userId: "workflow", ...context.payload });
            return { output: result };
        }

        // Generic AI fallback
        const result = await groq.chat(resolvedPrompt, config.systemPrompt);
        return { output: result };
    },

    // send_message — post a message to a channel
    async send_message(config, context) {
        const { workspaceId, channelId, content } = config;
        const resolvedContent = interpolate(content || "", context);

        if (!workspaceId || !channelId || !resolvedContent) {
            throw new Error("send_message requires workspaceId, channelId, and content");
        }

        const channel = await Channel.findOne({ _id: channelId, workspaceId });
        if (!channel) throw new Error(`Channel ${channelId} not found`);

        const message = await Message.create({
            workspaceId,
            channelId,
            senderId: config.botUserId || null,
            content:  resolvedContent,
        });

        await Channel.findByIdAndUpdate(channelId, {
            lastMessageAt:      new Date(),
            lastMessagePreview: resolvedContent.slice(0, 100),
            $inc: { messageCount: 1 },
        });

        const populated = await message.populate("senderId", "username email");

        // Notify clients via Redis-to-WS bridge
        const redis = redisConnection.getClient();
        if (redis) {
            await redis.publish("websocket:events", JSON.stringify({
                event:       "MESSAGE_CREATED",
                workspaceId,
                sourceId:    channelId,
                message:     populated
            }));
        }

        return { messageId: message._id.toString(), content: resolvedContent };
    },

    // send_email — send an email via nodemailer
    async send_email(config, context) {
        const { to, subject, body } = config;
        const resolvedBody = interpolate(body || "", context);

        // Import dynamically to avoid loading nodemailer in every worker
        const { default: nodemailer } = await import("nodemailer");
        const transporter = nodemailer.createTransport({
            service: process.env.MAIL_SERVICE || "gmail",
            auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
        });

        await transporter.sendMail({
            from:    process.env.MAIL_USER,
            to,
            subject: interpolate(subject || "NexusFlow notification", context),
            text:    resolvedBody,
        });

        return { sent: true, to };
    },

    // http_request — call an external webhook or API
    async http_request(config, context) {
        const { url, method = "POST", headers = {}, body } = config;
        if (!url) throw new Error("http_request requires a url");

        const resolvedBody = body ? interpolate(JSON.stringify(body), context) : undefined;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);

        try {
            const response = await fetch(url, {
                method,
                headers: { "Content-Type": "application/json", ...headers },
                body:    resolvedBody,
                signal:  controller.signal,
            });
            clearTimeout(timer);

            const responseBody = await response.text().catch(() => "");
            return { status: response.status, ok: response.ok, body: responseBody.slice(0, 500) };
        } catch (err) {
            clearTimeout(timer);
            throw new Error(`HTTP request failed: ${err.message}`);
        }
    },

    // condition — evaluate a condition and return which branch to take
    async condition(config, context) {
        const { field, operator, value } = config;
        const actual = getNestedValue(context, field);

        let result = false;
        switch (operator) {
            case "eq":       result = actual == value; break;
            case "neq":      result = actual != value; break;
            case "gt":       result = Number(actual) > Number(value); break;
            case "lt":       result = Number(actual) < Number(value); break;
            case "contains": result = String(actual).includes(String(value)); break;
            case "exists":   result = actual !== undefined && actual !== null; break;
            default:         result = false;
        }

        return { conditionResult: result };
    },

    // delay — wait N seconds before continuing
    async delay(config) {
        const seconds = Math.min(config.seconds || 1, 60); // cap at 60s
        await new Promise(r => setTimeout(r, seconds * 1000));
        return { delayed: seconds };
    },
};

// ── String interpolation ──────────────────────────────────────────────────────
// Replace {{variable}} placeholders in strings with values from context.
// e.g. "Hello {{message.content}}" → "Hello world"
function interpolate(template, context) {
    return template.replace(/\{\{([^}]+)\}\}/g, (_, path) => {
        const value = getNestedValue(context, path.trim());
        return value !== undefined ? String(value) : `{{${path}}}`;
    });
}

function getNestedValue(obj, path) {
    return path.split(".").reduce((acc, key) => acc?.[key], obj);
}

// ── Execute a single workflow job ─────────────────────────────────────────────
async function executeWorkflow(job) {
    const { executionId, workflowId, workspaceId, nodes, payload } = job;

    logger.info("Workflow execution started", { executionId, workflowId });

    // Mark execution as running
    await WorkflowExecution.findByIdAndUpdate(executionId, {
        status:    "running",
        startedAt: new Date(),
    });

    const startTime = Date.now();
    // Context accumulates outputs from each node — later nodes can reference earlier outputs
    const context = { payload, workspaceId, workflowId };

    let currentNodeId = nodes[0]?.id;
    const nodeResults = [];

    try {
        while (currentNodeId) {
            const node = nodes.find(n => n.id === currentNodeId);
            if (!node) break;

            const nodeStart = Date.now();
            logger.info("Executing workflow node", { executionId, nodeId: node.id, type: node.type });

            // Update node status to running
            await WorkflowExecution.findByIdAndUpdate(executionId, {
                $push: {
                    nodeResults: {
                        nodeId:    node.id,
                        nodeName:  node.name,
                        nodeType:  node.type,
                        status:    "running",
                        startedAt: new Date(),
                    },
                },
            });

            let output;
            let error;
            let status = "success";

            try {
                const executor = nodeExecutors[node.type];
                if (!executor) throw new Error(`Unknown node type: ${node.type}`);

                output = await executor(node.config || {}, context);

                // Add this node's output to context so subsequent nodes can use it
                context[node.id] = output;

            } catch (err) {
                error  = err.message;
                status = "failed";
                logger.error("Workflow node failed", { executionId, nodeId: node.id, error: err.message });
            }

            const nodeResult = {
                nodeId:     node.id,
                nodeName:   node.name,
                nodeType:   node.type,
                status,
                startedAt:  new Date(nodeStart),
                finishedAt: new Date(),
                durationMs: Date.now() - nodeStart,
                output,
                error,
            };
            nodeResults.push(nodeResult);

            // Update the node result in the execution record
            await WorkflowExecution.findByIdAndUpdate(executionId, {
                $set: { [`nodeResults.${nodeResults.length - 1}`]: nodeResult },
            });

            if (status === "failed") {
                throw new Error(`Node "${node.name}" failed: ${error}`);
            }

            // Determine next node
            if (node.type === "condition") {
                currentNodeId = output.conditionResult ? node.trueBranchId : node.falseBranchId;
            } else {
                currentNodeId = node.nextId || null;
            }
        }

        // All nodes completed successfully
        const durationMs = Date.now() - startTime;
        await WorkflowExecution.findByIdAndUpdate(executionId, {
            status:     "success",
            finishedAt: new Date(),
            durationMs,
            nodeResults,
        });

        // Update workflow stats
        await Workflow.findByIdAndUpdate(workflowId, {
            $inc:  { executionCount: 1 },
            $set:  { lastExecutedAt: new Date(), lastExecutionStatus: "success" },
        });

        logger.info("Workflow execution completed", { executionId, durationMs });

    } catch (err) {
        const durationMs = Date.now() - startTime;
        await WorkflowExecution.findByIdAndUpdate(executionId, {
            status:     "failed",
            finishedAt: new Date(),
            durationMs,
            error:      err.message,
            nodeResults,
        });

        await Workflow.findByIdAndUpdate(workflowId, {
            $set: { lastExecutedAt: new Date(), lastExecutionStatus: "failed" },
        });

        logger.error("Workflow execution failed", { executionId, error: err.message });
        throw err; // re-throw so the consumer nacks the message
    }
}

// ── Worker bootstrap ──────────────────────────────────────────────────────────
class WorkflowWorker {
    constructor() {
        this.stopping = false;
        this.channel  = null;
    }

    async initialize() {
        logger.info("Starting workflow worker...");

        await database.connect();
        await redisConnection.connect();
        await rabbitmq.connect();

        this.channel = rabbitmq.getChannel();
        await this.channel.prefetch(parseInt(process.env.WORKFLOW_CONCURRENCY) || 3);

        logger.info("Workflow worker initialized");
    }

    async start() {
        this.channel.consume("workflow_queue", async (msg) => {
            if (!msg) return;

            let job;
            try {
                job = JSON.parse(msg.content.toString());
            } catch {
                logger.error("Invalid workflow job payload — discarding");
                this.channel.nack(msg, false, false); // send to DLQ
                return;
            }

            try {
                await executeWorkflow(job);
                this.channel.ack(msg);
            } catch (err) {
                const retryCount = (msg.properties.headers?.["x-retry-count"] || 0) + 1;
                const maxRetries = parseInt(process.env.MAX_RETRY_ATTEMPTS) || 3;

                if (retryCount < maxRetries) {
                    // Republish with incremented retry count
                    this.channel.nack(msg, false, false);
                    logger.warn("Workflow job failed — will retry", {
                        executionId: job.executionId,
                        retryCount,
                        error: err.message,
                    });
                } else {
                    // Exhausted retries — send to DLQ
                    this.channel.nack(msg, false, false);
                    logger.error("Workflow job exhausted retries — sent to DLQ", {
                        executionId: job.executionId,
                        error: err.message,
                    });
                }
            }
        }, { noAck: false });

        logger.info("Workflow worker consuming from workflow_queue", {
            concurrency: parseInt(process.env.WORKFLOW_CONCURRENCY) || 3,
        });
    }

    async shutdown() {
        if (this.stopping) return;
        this.stopping = true;

        logger.info("Workflow worker shutting down...");

        // Give in-flight jobs 5 seconds to finish
        await new Promise(r => setTimeout(r, 5000));

        await rabbitmq.disconnect();
        await redisConnection.disconnect();
        await database.disconnect();

        logger.info("Workflow worker shutdown complete");
        process.exit(0);
    }
}

const worker = new WorkflowWorker();

(async () => {
    try {
        await worker.initialize();
        await worker.start();
    } catch (err) {
        logger.error("Workflow worker failed to start:", err.message);
        process.exit(1);
    }
})();

process.on("SIGTERM", () => worker.shutdown());
process.on("SIGINT",  () => worker.shutdown());

process.on("uncaughtException", (err) => {
    logger.error("Uncaught exception in workflow worker:", err);
    worker.shutdown();
});

process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled rejection in workflow worker:", reason);
    worker.shutdown();
});
