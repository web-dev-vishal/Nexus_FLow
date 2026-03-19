// Groq AI client — used for two things:
//   1. Fraud risk scoring before a payout is initiated
//   2. Anomaly detection after a payout completes (runs in the background)
//
// If AI is disabled or the API key is missing, all methods return safe defaults
// so the rest of the system keeps working without AI.

import logger from "../utils/logger.js";
import { retryWithBackoff } from "../utils/helpers.js";

class GroqClient {
    constructor() {
        this.apiKey  = process.env.GROQ_API_KEY;
        this.baseUrl = "https://api.groq.com/openai/v1/chat/completions";
        this.model   = "llama-3.3-70b-versatile";

        // AI features can be toggled off without restarting — just change the env var
        this.enabled = process.env.ENABLE_AI_FEATURES === "true";
    }

    // Internal method — sends a chat completion request to Groq.
    // Returns the raw text response, or null if AI is off / request fails.
    async _request(messages, timeoutMs = 3000, temperature = 0.3) {
        // If AI is disabled or no API key, skip the call entirely
        if (!this.enabled || !this.apiKey) return null;

        // Abort the request if it takes too long — we can't hold up a payout for AI
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await fetch(this.baseUrl, {
                method: "POST",
                headers: {
                    Authorization:  `Bearer ${this.apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model:      this.model,
                    messages,
                    temperature,
                    max_tokens: 500,
                }),
                signal: controller.signal,
            });

            clearTimeout(timeout);

            if (!response.ok) {
                throw new Error(`Groq API ${response.status}`);
            }

            const data = await response.json();
            return data.choices[0]?.message?.content ?? null;
        } catch (error) {
            clearTimeout(timeout);
            if (error.name === "AbortError") {
                logger.warn("Groq request timed out");
            } else {
                logger.error("Groq request failed:", error.message);
            }
            // Return null so callers can fall back to safe defaults
            return null;
        }
    }

    // Ask the AI to score how risky a payout looks.
    // Returns a score from 0 (safe) to 100 (very risky), plus a short explanation.
    // If AI is unavailable, returns a neutral score of 50 so we don't block all payouts.
    async scoreFraudRisk({ userId, amount, currency, ipCountry, userCountry, transactionCount }) {
        const prompt = `You are a fraud detection system. Analyze this payout and return ONLY valid JSON.

Transaction:
- User: ${userId}
- Amount: ${amount} ${currency}
- User country: ${userCountry || "Unknown"}
- Request IP country: ${ipCountry || "Unknown"}
- Prior transactions: ${transactionCount || 0}

Return: {"riskScore": <0-100>, "reasoning": "<brief>", "recommendation": "approve|review|reject"}`;

        try {
            // Retry once on failure — Groq can occasionally return a 503
            const raw = await retryWithBackoff(
                () => this._request(
                    [
                        { role: "system", content: "You are a fraud detection AI. Respond with valid JSON only." },
                        { role: "user",   content: prompt },
                    ],
                    3000,
                    0.2
                ),
                2,
                500
            );

            // If AI is unavailable, default to a neutral score so we don't block all payouts
            if (!raw) {
                return { riskScore: 50, reasoning: "AI unavailable", recommendation: "review", aiAvailable: false };
            }

            return { ...this._parseFraudScore(raw), aiAvailable: true };
        } catch (error) {
            logger.error("Fraud scoring failed:", error.message);
            return { riskScore: 50, reasoning: "Scoring error", recommendation: "review", aiAvailable: false };
        }
    }

    // Parse the AI's JSON response for fraud scoring.
    // If the response is malformed, return a safe default instead of crashing.
    _parseFraudScore(raw) {
        try {
            // Extract the JSON object from the response — the AI sometimes adds extra text
            const match = raw.match(/\{[\s\S]*\}/);
            if (!match) throw new Error("No JSON in response");

            const parsed = JSON.parse(match[0]);

            if (typeof parsed.riskScore !== "number" || parsed.riskScore < 0 || parsed.riskScore > 100) {
                throw new Error("Invalid riskScore");
            }

            return {
                riskScore:      Math.round(parsed.riskScore),
                reasoning:      parsed.reasoning || "No reasoning",
                recommendation: parsed.recommendation || "review",
            };
        } catch {
            // If parsing fails, return a neutral score — don't crash the payout
            return { riskScore: 50, reasoning: "Parse error", recommendation: "review" };
        }
    }

    // Check if a completed transaction looks unusual compared to the user's history.
    // This runs after the payout completes — it's non-blocking and won't affect the result.
    async detectAnomaly(currentTx, history) {
        // Can't detect anomalies without any history to compare against
        if (history.length === 0) {
            return { isAnomaly: false, confidence: 0, explanation: "No history", aiAvailable: false };
        }

        // Calculate the average transaction amount for context
        const avg = history.reduce((s, t) => s + t.amount, 0) / history.length;

        const prompt = `Analyze this transaction for anomalies. Return ONLY valid JSON.

Current: ${currentTx.amount} ${currentTx.currency}
History (${history.length} txns, avg ${avg.toFixed(2)}):
${history.slice(0, 10).map((t, i) => `${i + 1}. ${t.amount} ${t.currency}`).join("\n")}

Return: {"isAnomaly": <bool>, "confidence": <0-1>, "explanation": "<brief>"}`;

        try {
            const raw = await retryWithBackoff(
                () => this._request(
                    [
                        { role: "system", content: "You are an anomaly detection AI. Respond with valid JSON only." },
                        { role: "user",   content: prompt },
                    ],
                    3000,
                    0.2
                ),
                2,
                500
            );

            if (!raw) {
                return { isAnomaly: false, confidence: 0, explanation: "AI unavailable", aiAvailable: false };
            }

            return { ...this._parseAnomaly(raw), aiAvailable: true };
        } catch (error) {
            logger.error("Anomaly detection failed:", error.message);
            return { isAnomaly: false, confidence: 0, explanation: "Detection error", aiAvailable: false };
        }
    }

    // Parse the AI's JSON response for anomaly detection.
    _parseAnomaly(raw) {
        try {
            const match = raw.match(/\{[\s\S]*\}/);
            if (!match) throw new Error("No JSON");

            const parsed = JSON.parse(match[0]);

            if (typeof parsed.isAnomaly !== "boolean") throw new Error("Invalid isAnomaly");
            if (typeof parsed.confidence !== "number")  throw new Error("Invalid confidence");

            return {
                isAnomaly:   parsed.isAnomaly,
                // Clamp confidence to 0-1 range in case the AI goes out of bounds
                confidence:  Math.min(1, Math.max(0, parsed.confidence)),
                explanation: parsed.explanation || "No explanation",
            };
        } catch {
            return { isAnomaly: false, confidence: 0, explanation: "Parse error" };
        }
    }

    // Generate a short, friendly explanation of a payment error.
    // Used by the error handler to give users a human-readable message.
    async generateErrorExplanation(errorCode, context) {
        const prompt = `Explain this payment error in simple, friendly language (under 200 chars).
Error: ${errorCode}, Amount: ${context.amount} ${context.currency}`;

        try {
            const raw = await this._request(
                [
                    { role: "system", content: "You are a helpful payment assistant." },
                    { role: "user",   content: prompt },
                ],
                2000,
                0.5
            );

            return raw ? raw.trim().substring(0, 200) : null;
        } catch {
            return null;
        }
    }
}

export default GroqClient;
