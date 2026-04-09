// OpenRouter Service — unified gateway to 25+ free AI models.
//
// OpenRouter aggregates models from Google, Meta, Mistral, DeepSeek, and more.
// This service now supports multiple OpenRouter API keys, key rotation, and a configurable default model.
//
// Default model:
//   MODEL_NAME=meta-llama/llama-3.3-70b-instruct:free
//
// Docs: https://openrouter.ai/docs

import logger from "../utils/logger.js";

const DEFAULT_MODEL_NAME = process.env.MODEL_NAME || "meta-llama/llama-3.3-70b-instruct:free";
const FREE_MODELS = {
    RESEARCH:      "deepseek/deepseek-chat-v3-0324:free",
    MULTILINGUAL:  "qwen/qwen3-235b-a22b:free",
    DOCUMENT_QA:   "google/gemma-3-27b-it:free",
    GENERAL:       "meta-llama/llama-4-scout:free",
    LIGHTWEIGHT:   "mistralai/mistral-7b-instruct:free",
};

const buildHeaders = (key) => ({
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
});

class OpenRouterService {
    constructor() {
        this.apiKeys = [];
        this.apiKeyLabels = [];

        [
            ["OPENROUTER_API_KEY_1", process.env.OPENROUTER_API_KEY_1],
            ["OPENROUTER_API_KEY_2", process.env.OPENROUTER_API_KEY_2],
            ["OPENROUTER_API_KEY_3", process.env.OPENROUTER_API_KEY_3],
            ["OPENROUTER_API_KEY", process.env.OPENROUTER_API_KEY],
        ].forEach(([label, key]) => {
            if (key) {
                this.apiKeys.push(key);
                this.apiKeyLabels.push(label);
            }
        });

        this.baseUrl = "https://openrouter.ai/api/v1/chat/completions";
        this.enabled = this.apiKeys.length > 0;
        this.defaultModel = DEFAULT_MODEL_NAME;

        this._rateLimitHit = false;
        this._rateLimitReset = 0;
        this._activeKeyIndex = 0;
    }

    _keyLabel(index) {
        return this.apiKeyLabels[index] || `OPENROUTER_API_KEY_${index + 1}`;
    }

    _rotateKey() {
        if (this.apiKeys.length > 1) {
            this._activeKeyIndex = (this._activeKeyIndex + 1) % this.apiKeys.length;
        }
    }

    async _request(model, messages, options = {}) {
        if (!this.enabled) {
            throw new Error("OpenRouter API key not configured. Set OPENROUTER_API_KEY_1, OPENROUTER_API_KEY_2, or OPENROUTER_API_KEY_3.");
        }

        if (this._rateLimitHit && Date.now() < this._rateLimitReset) {
            logger.warn("OpenRouter rate limit active — skipping request", { model });
            throw new Error("OpenRouter is temporarily rate limited. Retry after a short wait.");
        }

        const {
            temperature = 0.4,
            maxTokens = 800,
            timeoutMs = 12000,
        } = options;

        const modelName = model || this.defaultModel;
        const attempts = this.apiKeys.length;

        for (let attempt = 0; attempt < attempts; attempt += 1) {
            const keyIndex = (this._activeKeyIndex + attempt) % this.apiKeys.length;
            const apiKey = this.apiKeys[keyIndex];
            const keyLabel = this._keyLabel(keyIndex);
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);

            try {
                logger.info("OpenRouter request", { model: modelName, key: keyLabel });

                const response = await fetch(this.baseUrl, {
                    method: "POST",
                    headers: buildHeaders(apiKey),
                    body: JSON.stringify({
                        model: modelName,
                        messages,
                        temperature,
                        max_tokens: maxTokens,
                    }),
                    signal: controller.signal,
                });

                clearTimeout(timer);

                if (response.status === 429) {
                    this._rateLimitHit = true;
                    this._rateLimitReset = Date.now() + 60_000;
                    logger.warn("OpenRouter rate limit hit", { model: modelName, key: keyLabel });
                    this._rotateKey();
                    continue;
                }

                if (response.status === 401 || response.status === 403) {
                    logger.warn("OpenRouter invalid API key or unauthorized", { status: response.status, key: keyLabel });
                    this._rotateKey();
                    continue;
                }

                if (!response.ok) {
                    const body = await response.text().catch(() => "");
                    const message = `OpenRouter API ${response.status}: ${body.slice(0, 120)}`;
                    if (response.status >= 500) {
                        logger.warn("OpenRouter server error, rotating key", { model: modelName, key: keyLabel, status: response.status });
                        this._rotateKey();
                        continue;
                    }
                    throw new Error(message);
                }

                this._rateLimitHit = false;
                this._activeKeyIndex = keyIndex;

                const data = await response.json();
                const content = data?.choices?.[0]?.message?.content;
                if (!content) {
                    throw new Error("Unexpected OpenRouter response structure");
                }

                return content;
            } catch (err) {
                clearTimeout(timer);

                if (err.name === "AbortError") {
                    logger.warn("OpenRouter request timed out", { model: modelName, timeoutMs, key: keyLabel });
                } else {
                    logger.error("OpenRouter request failed", {
                        model: modelName,
                        key: keyLabel,
                        error: err.message,
                    });
                }

                if (attempt < attempts - 1) {
                    this._rotateKey();
                    continue;
                }
            }
        }

        throw new Error("OpenRouter request failed after exhausting all API keys.");
    }

    async chat(prompt, systemPrompt = "You are a helpful assistant.", options = {}) {
        const messages = [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt },
        ];

        return this._request(options.model || undefined, messages, options);
    }

    async summarise(text, { maxWords = 150, style = "concise" } = {}) {
        const styleGuide = {
            concise: "Write a concise summary in 2-3 sentences.",
            bullets: "Write a bullet-point summary with 3-5 key points.",
            detailed: "Write a detailed summary covering all main points.",
        };

        const messages = [
            {
                role: "system",
                content: `You are a summarisation assistant. ${styleGuide[style] || styleGuide.concise} Keep it under ${maxWords} words.`,
            },
            {
                role: "user",
                content: `Summarise the following:\n\n${text.slice(0, 8000)}`,
            },
        ];

        const result = await this._request(undefined, messages, {
            temperature: 0.2,
            maxTokens: 300,
            timeoutMs: 6000,
        });

        return result ? result.trim() : null;
    }

    async analyseSentiment(text) {
        const messages = [
            {
                role: "system",
                content: "You are a sentiment analysis model. Respond with valid JSON only.",
            },
            {
                role: "user",
                content: `Analyse the sentiment of this text and return JSON:\nText: "${text.slice(0, 2000)}"\n\nReturn ONLY:\n{\n  "sentiment": "positive|negative|neutral|mixed",\n  "score": <0.0 to 1.0 where 1.0 is most positive>,\n  "emotions": ["<emotion1>", "<emotion2>"],\n  "summary": "<one sentence>"\n}`,
            },
        ];

        const raw = await this._request(undefined, messages, {
            temperature: 0.1,
            maxTokens: 150,
            timeoutMs: 5000,
        });

        if (!raw) return { sentiment: "neutral", score: 0.5, emotions: [], summary: "Analysis unavailable" };

        try {
            const match = raw.match(/\{[\s\S]*\}/);
            if (!match) throw new Error("No JSON found");
            return JSON.parse(match[0]);
        } catch {
            return { sentiment: "neutral", score: 0.5, emotions: [], summary: "Parse error" };
        }
    }

    async translate(text, targetLanguage = "English") {
        const messages = [
            {
                role: "system",
                content: "You are a translation assistant. Translate the text accurately while preserving meaning and context.",
            },
            {
                role: "user",
                content: `Translate the following text into ${targetLanguage}:

${text.slice(0, 8000)}`,
            },
        ];

        const result = await this._request(undefined, messages, {
            temperature: 0.1,
            maxTokens: 800,
            timeoutMs: 10000,
        });

        return result ? result.trim() : null;
    }

    async suggestReplies(messageContent, conversationContext = "") {
        const contextBlock = conversationContext
            ? `\nRecent conversation:\n${conversationContext.slice(0, 1000)}\n`
            : "";

        const messages = [
            {
                role: "system",
                content: "You are a messaging assistant. Suggest 3 short, natural reply options. Each reply should be under 15 words. Return as a JSON array of strings.",
            },
            {
                role: "user",
                content: `${contextBlock}Message to reply to: "${messageContent}"\n\nReturn ONLY a JSON array: [\"reply1\", \"reply2\", \"reply3\"]`,
            },
        ];

        const raw = await this._request(FREE_MODELS.GENERAL, messages, {
            temperature: 0.7,
            maxTokens: 100,
            timeoutMs: 6000,
        });

        if (!raw) return ["Got it!", "Thanks!", "I'll look into this."];

        try {
            const match = raw.match(/\[[\s\S]*\]/);
            if (!match) throw new Error("No array found");
            const replies = JSON.parse(match[0]);
            return Array.isArray(replies) ? replies.slice(0, 3) : ["Got it!", "Thanks!", "I'll look into this."];
        } catch {
            return ["Got it!", "Thanks!", "I'll look into this."];
        }
    }

    async explainCode(code, language = "unknown") {
        const messages = [
            {
                role: "system",
                content: "You are a code explanation assistant. Explain code clearly for developers. Cover: what it does, how it works, and any potential issues.",
            },
            {
                role: "user",
                content: `Explain this ${language} code:\n\n\`\`\`${language}\n${code.slice(0, 4000)}\n\`\`\``,
            },
        ];

        const result = await this._request(FREE_MODELS.RESEARCH, messages, {
            temperature: 0.2,
            maxTokens: 600,
            timeoutMs: 10000,
        });

        return result ? result.trim() : null;
    }

    async critique(originalOutput, task) {
        const messages = [
            {
                role: "system",
                content: "You are a critic and editor. Review the provided output, identify weaknesses, and return an improved version. Be constructive and specific.",
            },
            {
                role: "user",
                content: `Task: ${task}\n\nOriginal output to improve:\n${originalOutput.slice(0, 3000)}\n\nProvide an improved version that is more accurate, clear, and complete.`,
            },
        ];

        const result = await this._request(FREE_MODELS.DOCUMENT_QA, messages, {
            temperature: 0.3,
            maxTokens: 800,
            timeoutMs: 12000,
        });

        return result ? result.trim() : null;
    }

    async research(question, context = "") {
        const contextBlock = context
            ? `\n\n## Background Context\n${context.slice(0, 4000)}`
            : "";

        const messages = [
            {
                role: "system",
                content: "You are a research assistant. Provide accurate, well-structured answers. Cite your reasoning. Be thorough but concise.",
            },
            {
                role: "user",
                content: `Research question: ${question}${contextBlock}\n\nProvide a comprehensive answer with key facts, relevant context, and a clear conclusion.`,
            },
        ];

        const result = await this._request(FREE_MODELS.RESEARCH, messages, {
            temperature: 0.3,
            maxTokens: 1000,
            timeoutMs: 15000,
        });

        return result ? result.trim() : null;
    }

    async documentQA(question, documentText) {
        const messages = [
            {
                role: "system",
                content: "You are a document analysis assistant. Answer questions based only on the provided document. If the answer is not in the document, say so clearly.",
            },
            {
                role: "user",
                content: `Document:\n${documentText.slice(0, 12000)}\n\nQuestion: ${question}`,
            },
        ];

        const result = await this._request(FREE_MODELS.DOCUMENT_QA, messages, {
            temperature: 0.1,
            maxTokens: 600,
            timeoutMs: 12000,
        });

        return result ? result.trim() : null;
    }

    async describeToWorkflow(description) {
        const messages = [
            {
                role: "system",
                content: `You are a workflow builder assistant. Convert natural language descriptions into structured workflow JSON.\nA workflow has: trigger (type, config), conditions (array), nodes (array of steps), and actions (array).\nNode types: "ai_agent", "http_request", "send_message", "send_email", "condition", "delay".\nReturn valid JSON only.`,
            },
            {
                role: "user",
                content: `Convert this workflow description to JSON:\n"${description}"\n\nReturn ONLY this JSON structure:\n{\n  "name": "<workflow name>",\n  "description": "<brief description>",\n  "trigger": {\n    "type": "message_keyword|schedule|webhook|manual",\n    "config": {}\n  },\n  "nodes": [\n    {\n      "id": "node_1",\n      "type": "ai_agent|http_request|send_message|send_email|condition|delay",\n      "name": "<step name>",\n      "config": {}\n    }\n  ]\n}`,
            },
        ];

        const raw = await this._request(FREE_MODELS.RESEARCH, messages, {
            temperature: 0.2,
            maxTokens: 800,
            timeoutMs: 12000,
        });

        if (!raw) return null;

        try {
            const match = raw.match(/\{[\s\S]*\}/);
            if (!match) return null;
            return JSON.parse(match[0]);
        } catch {
            return null;
        }
    }

    getStatus() {
        return {
            enabled:        this.enabled,
            rateLimited:    this._rateLimitHit,
            rateLimitReset: this._rateLimitHit ? new Date(this._rateLimitReset).toISOString() : null,
            model:          this.defaultModel,
            apiKeyCount:    this.apiKeys.length,
            models:         FREE_MODELS,
        };
    }

    isAvailable() {
        return this.enabled && (!this._rateLimitHit || Date.now() >= this._rateLimitReset);
    }
}

export default OpenRouterService;
