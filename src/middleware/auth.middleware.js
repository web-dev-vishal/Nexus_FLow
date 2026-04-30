// Auth middleware — protects routes that require a logged-in user.
// Verifies PASETO v4.public access tokens (Ed25519 signature).
// On success: sets req.user and req.userId for downstream handlers.

import { verifyAccessToken } from "../services/token.service.js";
import { getCachedUser } from "../services/auth.service.js";

export const isAuthenticated = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({
                success: false,
                message: "Access token is missing or invalid",
            });
        }

        const token = authHeader.split(" ")[1];

        // verifyAccessToken throws structured errors with .code and .statusCode
        let payload;
        try {
            payload = await verifyAccessToken(token);
        } catch (err) {
            // Map PASETO error codes to clear HTTP responses
            if (err.code === "TOKEN_EXPIRED") {
                return res.status(401).json({
                    success: false,
                    message: "Access token has expired — use your refresh token to get a new one",
                    code:    "TOKEN_EXPIRED",
                });
            }
            return res.status(401).json({
                success: false,
                message: "Access token is invalid",
                code:    err.code || "TOKEN_INVALID",
            });
        }

        // Read user claims from token — no Redis call needed for normal requests
        req.userId = payload.sub;
        req.user = {
            _id: payload.sub,
            role: payload.role || 'user',
            isVerified: payload.isVerified ?? false,
        };

        // For admin users, still verify against cache/DB for security
        if (payload.role === 'admin') {
            const user = await getCachedUser(payload.sub);
            if (!user) {
                return res.status(404).json({ success: false, message: 'User not found' });
            }
            req.user = user;
        }

        next();
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message,
        });
    }
};

// Restrict a route to admin users only.
// Must be used after isAuthenticated — relies on req.user being set.
export const adminOnly = (req, res, next) => {
    if (req.user && req.user.role === "admin") return next();
    return res.status(403).json({
        success: false,
        message: "Access denied — admin only",
    });
};
