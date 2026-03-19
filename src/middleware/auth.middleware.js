// Auth middleware — protects routes that require a logged-in user.
// Checks the Authorization header for a valid JWT access token,
// then loads the user from Redis cache (or falls back to the database).

import jwt from "jsonwebtoken";
import { getCachedUser } from "../services/auth.service.js";

// isAuthenticated — attach this to any route that requires login.
// Sets req.user and req.userId so downstream handlers don't need to re-fetch the user.
export const isAuthenticated = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;

        // Reject requests with no token or wrong format
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({
                success: false,
                message: "Access token is missing or invalid",
            });
        }

        const token = authHeader.split(" ")[1];

        // Verify the token signature and expiry
        let decoded;
        try {
            decoded = jwt.verify(token, process.env.ACCESS_SECRET);
        } catch (err) {
            // Give a specific message for expired tokens — the client should use the refresh token
            if (err.name === "TokenExpiredError") {
                return res.status(401).json({
                    success: false,
                    message: "Access token has expired, use refresh token to generate a new one",
                });
            }
            return res.status(401).json({
                success: false,
                message: "Access token is invalid",
            });
        }

        // Try Redis cache first — falls back to DB on cache miss
        const user = await getCachedUser(decoded.id);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found",
            });
        }

        // Attach user info to the request so controllers can use it without another DB call
        req.user   = user;
        req.userId = decoded.id;
        next();
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message,
        });
    }
};

// adminOnly — attach after isAuthenticated to restrict a route to admin users only.
export const adminOnly = (req, res, next) => {
    if (req.user && req.user.role === "admin") {
        return next();
    }
    return res.status(403).json({
        success: false,
        message: "Access denied - Admin only",
    });
};
