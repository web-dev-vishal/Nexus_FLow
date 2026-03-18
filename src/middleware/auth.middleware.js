import jwt from "jsonwebtoken";
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

        let decoded;
        try {
            decoded = jwt.verify(token, process.env.ACCESS_SECRET);
        } catch (err) {
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

        req.user = user;
        req.userId = decoded.id;
        next();
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message,
        });
    }
};

export const adminOnly = (req, res, next) => {
    if (req.user && req.user.role === "admin") {
        return next();
    }
    return res.status(403).json({
        success: false,
        message: "Access denied - Admin only",
    });
};
