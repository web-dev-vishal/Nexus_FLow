// Error middleware — catches all unhandled errors and sends a clean JSON response.
// Express calls this when next(error) is called from any route handler.
// It also optionally uses the Groq AI client to generate a friendly error explanation.

import logger from "../utils/logger.js";

// The Groq client is injected at startup — it's optional, so we default to null.
let groqClient = null;

// Called from app.js after the Groq client is initialized
export const setGroqClient = (client) => {
    groqClient = client;
};

// 404 handler — catches requests to routes that don't exist.
// Must be registered after all other routes.
export const notFoundHandler = (req, res) => {
    res.status(404).json({
        success: false,
        error:   "Route not found",
        code:    "NOT_FOUND",
        path:    req.originalUrl,
    });
};

// Global error handler — catches errors thrown by route handlers and services.
// Express identifies this as an error handler because it has 4 parameters (err, req, res, next).
export const errorHandler = async (err, req, res, next) => {
    logger.error("Unhandled error", {
        message: err.message,
        code:    err.code,
        url:     req.originalUrl,
        method:  req.method,
        ip:      req.ip,
        userId:  req.body?.userId,
        // Only include stack traces in development — never expose them in production
        stack:   process.env.NODE_ENV === "development" ? err.stack : undefined,
    });

    // Start with the error as-is, then normalize known error types below
    let statusCode = err.statusCode || 500;
    let code       = err.code || "INTERNAL_ERROR";
    let message    = err.message || "Internal server error";

    // Mongoose validation error — e.g. required field missing
    if (err.name === "ValidationError") {
        statusCode = 400;
        code       = "VALIDATION_ERROR";
        message    = Object.values(err.errors).map((e) => e.message).join(", ");

    // MongoDB duplicate key error — e.g. email already registered
    } else if (err.code === 11000) {
        const field = Object.keys(err.keyValue || {})[0] || "field";
        statusCode  = 400;
        code        = "DUPLICATE_ERROR";
        message     = `Duplicate value for ${field}`;

    // Mongoose cast error — e.g. invalid ObjectId format
    } else if (err.name === "CastError") {
        statusCode = 400;
        code       = "CAST_ERROR";
        message    = "Invalid data format";

    // JWT errors
    } else if (err.name === "JsonWebTokenError") {
        statusCode = 401;
        code       = "INVALID_TOKEN";
        message    = "Invalid token";
    } else if (err.name === "TokenExpiredError") {
        statusCode = 401;
        code       = "TOKEN_EXPIRED";
        message    = "Token expired";
    }

    // Optional: ask the AI to generate a friendly explanation of the error.
    // Only runs for payout errors where we have a userId — non-critical, won't block the response.
    let explanation = null;
    if (groqClient && req.body?.userId) {
        try {
            explanation = await groqClient.generateErrorExplanation(code, {
                userId:   req.body.userId,
                amount:   req.body.amount || 0,
                currency: req.body.currency || "USD",
            });
        } catch {
            // If AI fails, just skip the explanation — don't let it break the error response
        }
    }

    const body = {
        success: false,
        error:   message,
        code,
        // Only include the AI explanation if we got one
        ...(explanation && { explanation }),
        // Only include the stack trace in development
        ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
    };

    res.status(statusCode).json(body);
};
