// Groq AI Service — handles all LLM-powered features in the platform.
//
// We use a multi-agent pattern where different "specialists" handle specific tasks
// like fraud scoring, anomaly detection, and conversational investigations.
//
// Specialist Agents:
//   - Fraud Scoring: Real-time risk assessment for payouts.
//   - Anomaly Detection: Post-processing to find unusual patterns.
//   - Investigation: Interactive chat for manual risk reviews.
//   - Financial Coach: User-facing spending insights.
//   - Error Explainer: User-friendly error messaging.

import logger from "../utils/logger.js";
import { retryWithBackoff } from "../utils/helpers.js";

const MODEL = "llama-3.3-70b-versatile";

// Per-agent timeouts — fraud scoring is in the critical payout path so it's tightest
const TIMEOUTS = {
    fraud:       4000,
    anomaly:     5000,
    investigate: 10000,
    coach:       8000,
    error:       2000,
};

class GroqClient {
    constructor() {
        this.apiKey  = process.env.GROQ_API_KEY;
        this.baseUrl = "https://api.groq.com/openai/v1/chat/completions";

        // AI features can be toggled off without restarting — just flip the env var
        this.enabled = process.env.ENABLE_AI_FEATURES === "true";

        // In-memory conversation store for the investigation agent.
        // Key: sessionId, Value: array of { role, content } messages.
        // Capped at 20 messages per session to avoid token overflow.
        this._conversations = new Map();
    }

    // ── Internal: send a chat completion request to Groq ─────────────────────
    async _request(messages, timeoutMs = 4000, temperature = 0.2, maxTokens = 600) {
        if (!this.enabled || !this.apiKey) return null;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await fetch(this.baseUrl, {
                method:  "POST",
                headers: {
                    Authorization:  `Bearer ${this.apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model:      MODEL,
                    messages,
                    temperature,
                    max_tokens: maxTokens,
                }),
                signal: controller.signal,
            });

            clearTimeout(timer);

            if (!response.ok) {
                throw new Error(`Groq API error: ${response.status}`);
            }

            const data = await response.json();
            return data.choices[0]?.message?.content ?? null;
        } catch (error) {
            clearTimeout(timer);
            if (error.name === "AbortError") {
                logger.warn("Groq request timed out", { timeoutMs });
            } else {
                logger.error("Groq request failed:", error.message);
            }
            return null;
        }
    }

    // Pull a JSON object out of a raw string response.
    // The model sometimes wraps JSON in markdown code blocks — this strips that.
    _extractJSON(raw) {
        if (!raw) return null;
        try {
            const match = raw.match(/\{[\s\S]*\}/);
            if (!match) return null;
            return JSON.parse(match[0]);
        } catch {
            return null;
        }
    }

    // ── Fraud Scoring ────────────────────────────────────────────────────────
    // Performs a RAG-based analysis by injecting the user's recent history
    // into the context to detect behavior shifts.
    async scoreFraudRisk({ userId, amount, currency, ipCountry, userCountry, transactionCount, recentHistory = [] }) {
        // Build the RAG context block — this is the "retrieval" step
        const historyContext = recentHistory.length > 0
            ? `Recent transactions (last ${recentHistory.length}):\n` +
              recentHistory.slice(0, 10).map((t, i) =>
                  `  ${i + 1}. ${t.amount} ${t.currency} — ${t.status} — ${new Date(t.createdAt).toLocaleDateString()}`
              ).join("\n")
            : "No prior transaction history (first-time user).";

        const systemPrompt = `You are a financial fraud detection agent for NexusFlow, a payout platform.
Analyze payout requests and assign a risk score using chain-of-thought reasoning.
Always respond with valid JSON only — no extra text.`;

        const userPrompt = `Analyze this payout request for fraud risk.

## Transaction Details
- User ID: ${userId}
- Amount: ${amount} ${currency}
- User's registered country: ${userCountry || "Unknown"}
- Request IP country: ${ipCountry || "Unknown"}
- Total prior transactions: ${transactionCount || 0}

## User History (RAG Context)
${historyContext}

## Risk Factors to Consider
1. IP country vs registered country mismatch
2. Amount relative to user's typical transaction size
3. First-time user with large amount
4. Unusual currency for this user

Think step by step, then return ONLY this JSON:
{
  "riskScore": <integer 0-100>,
  "reasoning": "<2-3 sentence explanation>",
  "recommendation": "approve|review|reject",
  "riskFactors": ["<factor1>", "<factor2>"]
}`;

        try {
            const raw = await retryWithBackoff(
                () => this._request(
                    [
                        { role: "system", content: systemPrompt },
                        { role: "user",   content: userPrompt },
                    ],
                    TIMEOUTS.fraud,
                    0.1
                ),
                2,
                500
            );

            if (!raw) {
                return { riskScore: 50, reasoning: "AI unavailable — defaulting to review", recommendation: "review", riskFactors: [], aiAvailable: false };
            }

            const parsed = this._extractJSON(raw);
            if (!parsed || typeof parsed.riskScore !== "number") {
                return { riskScore: 50, reasoning: "Parse error — defaulting to review", recommendation: "review", riskFactors: [], aiAvailable: false };
            }

            return {
                riskScore:      Math.min(100, Math.max(0, Math.round(parsed.riskScore))),
                reasoning:      parsed.reasoning || "No reasoning provided",
                recommendation: parsed.recommendation || "review",
                riskFactors:    Array.isArray(parsed.riskFactors) ? parsed.riskFactors : [],
                aiAvailable:    true,
            };
        } catch (error) {
            logger.error("Fraud scoring agent failed:", error.message);
            return { riskScore: 50, reasoning: "Agent error", recommendation: "review", riskFactors: [], aiAvailable: false };
        }
    }

    // ── Anomaly Detection ────────────────────────────────────────────────────
    // Background task to compare a completed transaction against historical stats.
    async detectAnomaly(currentTx, history) {
        if (history.length === 0) {
            return { isAnomaly: false, confidence: 0, explanation: "No history to compare against", aiAvailable: false };
        }

        // Calculate stats to give the model useful numerical context
        const amounts = history.map((t) => t.amount);
        const avg     = amounts.reduce((s, a) => s + a, 0) / amounts.length;
        const max     = Math.max(...amounts);
        const min     = Math.min(...amounts);
        const stdDev  = Math.sqrt(amounts.reduce((s, a) => s + Math.pow(a - avg, 2), 0) / amounts.length);

        const systemPrompt = `You are an anomaly detection agent for a payment platform.
Flag transactions that look unusual compared to the user's history.
Use statistical reasoning. Respond with valid JSON only.`;

        const userPrompt = `Analyze this transaction for anomalies.

## Current Transaction
- Amount: ${currentTx.amount} ${currentTx.currency}
- Date: ${new Date(currentTx.createdAt).toLocaleDateString()}

## User's Historical Stats (${history.length} transactions)
- Average amount: ${avg.toFixed(2)}
- Min: ${min.toFixed(2)}, Max: ${max.toFixed(2)}
- Std deviation: ${stdDev.toFixed(2)}

## Recent Transactions (RAG Context)
${history.slice(0, 8).map((t, i) => `  ${i + 1}. ${t.amount} ${t.currency} — ${new Date(t.createdAt).toLocaleDateString()}`).join("\n")}

Return ONLY this JSON:
{
  "isAnomaly": <boolean>,
  "confidence": <0.0-1.0>,
  "explanation": "<brief reason>",
  "deviationFromAvg": "<e.g. 3.2x above average>"
}`;

        try {
            const raw = await retryWithBackoff(
                () => this._request(
                    [
                        { role: "system", content: systemPrompt },
                        { role: "user",   content: userPrompt },
                    ],
                    TIMEOUTS.anomaly,
                    0.2
                ),
                2,
                500
            );

            if (!raw) {
                return { isAnomaly: false, confidence: 0, explanation: "AI unavailable", aiAvailable: false };
            }

            const parsed = this._extractJSON(raw);
            if (!parsed || typeof parsed.isAnomaly !== "boolean") {
                return { isAnomaly: false, confidence: 0, explanation: "Parse error", aiAvailable: false };
            }

            return {
                isAnomaly:        parsed.isAnomaly,
                confidence:       Math.min(1, Math.max(0, parsed.confidence || 0)),
                explanation:      parsed.explanation || "No explanation",
                deviationFromAvg: parsed.deviationFromAvg || null,
                aiAvailable:      true,
            };
        } catch (error) {
            logger.error("Anomaly detection agent failed:", error.message);
            return { isAnomaly: false, confidence: 0, explanation: "Agent error", aiAvailable: false };
        }
    }

    // ── Investigation ────────────────────────────────────────────────────────
    // Supports multi-turn conversations for deeper fraud analysis.
    async investigateTransaction(sessionId, userMessage, transactionContext = {}) {
        // First turn — initialize the conversation with the transaction as context
        if (!this._conversations.has(sessionId)) {
            const systemPrompt = `You are a fraud investigation agent for NexusFlow.
You are analyzing a specific transaction and answering questions about it.
Be concise, factual, and highlight any red flags you notice.
If you don't have enough information, say so clearly.

## Transaction Under Investigation
${JSON.stringify(transactionContext, null, 2)}`;

            this._conversations.set(sessionId, [
                { role: "system", content: systemPrompt },
            ]);
        }

        const history = this._conversations.get(sessionId);

        // Add the new user message to the conversation memory
        history.push({ role: "user", content: userMessage });

        // Trim old messages if the conversation gets too long — keep the system prompt
        if (history.length > 22) {
            const systemMsg = history[0];
            history.splice(1, 2); // drop the oldest user+assistant pair
            history[0] = systemMsg;
        }

        try {
            const raw = await this._request(
                history,
                TIMEOUTS.investigate,
                0.4,  // slightly higher temperature for natural conversation
                800
            );

            if (!raw) {
                return { response: "I'm unable to respond right now. Please try again.", aiAvailable: false };
            }

            // Store the response in memory so the next turn has full context
            history.push({ role: "assistant", content: raw });

            return {
                response:    raw.trim(),
                turnCount:   history.filter((m) => m.role === "user").length,
                aiAvailable: true,
            };
        } catch (error) {
            logger.error("Investigation agent failed:", error.message);
            return { response: "Investigation agent encountered an error.", aiAvailable: false };
        }
    }

    // End an investigation session and free the memory
    clearInvestigationSession(sessionId) {
        this._conversations.delete(sessionId);
    }

    // ── Spending Analysis ────────────────────────────────────────────────────
    // Analyzes the full transaction history to provide personalized financial insights.
    async analyzeSpendingPatterns(userId, transactions, spendingLimits = []) {
        if (!transactions || transactions.length === 0) {
            return { insights: "No transaction history available yet.", aiAvailable: false };
        }

        // Summarize the data so we don't blow the token limit
        const totalSpent  = transactions.reduce((s, t) => s + t.amount, 0);
        const avgAmount   = totalSpent / transactions.length;
        const currencies  = [...new Set(transactions.map((t) => t.currency))];
        const byMonth     = this._groupByMonth(transactions);
        const limitsText  = spendingLimits.length > 0
            ? spendingLimits.map((l) => `${l.period}: ${l.limitAmount} ${l.currency} (used: ${l.used || 0})`).join(", ")
            : "No spending limits set";

        const systemPrompt = `You are a financial coach agent for NexusFlow users.
Analyze payout patterns and give actionable, friendly insights.
Be specific with numbers. Keep your response under 300 words.`;

        const userPrompt = `Analyze this user's payout history and give insights.

## User: ${userId}
## Summary
- Total transactions: ${transactions.length}
- Total paid out: ${totalSpent.toFixed(2)} USD
- Average payout: ${avgAmount.toFixed(2)} USD
- Currencies used: ${currencies.join(", ")}
- Spending limits: ${limitsText}

## Monthly Breakdown (RAG Context)
${Object.entries(byMonth).slice(-6).map(([month, data]) =>
    `  ${month}: ${data.count} payouts, total ${data.total.toFixed(2)} USD`
).join("\n")}

## Recent Transactions
${transactions.slice(0, 10).map((t, i) =>
    `  ${i + 1}. ${t.amount} ${t.currency} — ${t.status} — ${new Date(t.createdAt).toLocaleDateString()}`
).join("\n")}

Provide:
1. Key spending patterns you notice
2. Any concerns or red flags
3. One actionable recommendation
4. Whether their spending limits are appropriate`;

        try {
            const raw = await this._request(
                [
                    { role: "system", content: systemPrompt },
                    { role: "user",   content: userPrompt },
                ],
                TIMEOUTS.coach,
                0.5,
                600
            );

            if (!raw) {
                return { insights: "Financial analysis unavailable right now.", aiAvailable: false };
            }

            return { insights: raw.trim(), aiAvailable: true };
        } catch (error) {
            logger.error("Financial coach agent failed:", error.message);
            return { insights: "Analysis failed.", aiAvailable: false };
        }
    }

    // ── Error Explanations ───────────────────────────────────────────────────
    // Translates technical error codes into friendly, human-readable messages.
    async generateErrorExplanation(errorCode, context = {}) {
        const prompt = `Explain this payment error in simple, friendly language. Under 150 characters.
Error: ${errorCode}
Amount: ${context.amount || "unknown"} ${context.currency || ""}
Give a helpful suggestion for what the user should do next.`;

        try {
            const raw = await this._request(
                [
                    { role: "system", content: "You are a helpful payment support assistant. Be brief and friendly." },
                    { role: "user",   content: prompt },
                ],
                TIMEOUTS.error,
                0.5,
                200
            );

            return raw ? raw.trim().substring(0, 200) : null;
        } catch {
            return null;
        }
    }

    // ── Generic Chat Method ──────────────────────────────────────────────────
    // Used by workflows and general AI queries.
    async chat(prompt, systemPrompt = "You are a helpful AI assistant.", temperature = 0.7, maxTokens = 1000) {
        try {
            return await this._request(
                [
                    { role: "system", content: systemPrompt },
                    { role: "user",   content: prompt },
                ],
                15000, // longer timeout for general tasks
                temperature,
                maxTokens
            );
        } catch (error) {
            logger.error("Groq chat failed:", error.message);
            return null;
        }
    }

    // ── Risk Assessment Override ─────────────────────────────────────────────
    // Combines fraud scoring and anomaly results using a "supervisor" pattern
    // to provide a single, high-confidence risk verdict.
    async runMultiAgentRiskAssessment(transactionData, history = []) {
        // Both agents run at the same time — no waiting
        const [fraudResult, anomalyResult] = await Promise.all([
            this.scoreFraudRisk({ ...transactionData, recentHistory: history }),
            history.length > 0
                ? this.detectAnomaly(
                    { amount: transactionData.amount, currency: transactionData.currency, createdAt: new Date() },
                    history
                )
                : Promise.resolve({ isAnomaly: false, confidence: 0, explanation: "No history", aiAvailable: false }),
        ]);

        // If AI is off, just return the fraud score as-is
        if (!fraudResult.aiAvailable && !anomalyResult.aiAvailable) {
            return { ...fraudResult, anomaly: anomalyResult, supervisorVerdict: null };
        }

        // Supervisor agent — reads both results and makes a final call
        const supervisorPrompt = `You are a risk supervisor agent. Two specialist agents analyzed a transaction.
Combine their findings into a final risk verdict.

## Fraud Scoring Agent
- Risk Score: ${fraudResult.riskScore}/100
- Recommendation: ${fraudResult.recommendation}
- Reasoning: ${fraudResult.reasoning}
- Risk Factors: ${(fraudResult.riskFactors || []).join(", ") || "none"}

## Anomaly Detection Agent
- Is Anomaly: ${anomalyResult.isAnomaly}
- Confidence: ${(anomalyResult.confidence * 100).toFixed(0)}%
- Explanation: ${anomalyResult.explanation}

Return ONLY this JSON:
{
  "finalRiskScore": <0-100>,
  "finalRecommendation": "approve|review|reject",
  "summary": "<one sentence combining both findings>",
  "escalate": <boolean>
}`;

        try {
            const raw = await this._request(
                [
                    { role: "system", content: "You are a risk supervisor. Respond with valid JSON only." },
                    { role: "user",   content: supervisorPrompt },
                ],
                4000,
                0.1,
                300
            );

            const supervisor = this._extractJSON(raw);

            return {
                ...fraudResult,
                anomaly:           anomalyResult,
                supervisorVerdict: supervisor || null,
                riskScore:         supervisor?.finalRiskScore      ?? fraudResult.riskScore,
                recommendation:    supervisor?.finalRecommendation ?? fraudResult.recommendation,
            };
        } catch (error) {
            logger.error("Supervisor agent failed:", error.message);
            return { ...fraudResult, anomaly: anomalyResult, supervisorVerdict: null };
        }
    }

    // ── Helper: group transactions by month ───────────────────────────────────
    _groupByMonth(transactions) {
        return transactions.reduce((acc, t) => {
            const d   = new Date(t.createdAt);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
            if (!acc[key]) acc[key] = { count: 0, total: 0 };
            acc[key].count++;
            acc[key].total += t.amount;
            return acc;
        }, {});
    }
}

export default GroqClient;
