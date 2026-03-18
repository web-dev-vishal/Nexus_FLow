import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import mongoSanitize from "express-mongo-sanitize";
import hpp from "hpp";
import authRoutes from "./routes/auth.route.js";
import { globalLimiter } from "./middleware/rate-limit.middleware.js";
import { xssSanitizer } from "./middleware/sanitize.middleware.js";

const app = express();

// Security headers
app.use(helmet());

// CORS
app.use(cors({
    origin: process.env.CLIENT_URL,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
}));

// Body parsers — reject payloads over 10kb
app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true, limit: "10kb" }));
app.use(cookieParser());

// Global rate limit
app.use(globalLimiter);

// NoSQL injection protection — strips $ and . from req body/query/params
app.use(mongoSanitize());

// HTTP Parameter Pollution protection
app.use(hpp());

// XSS sanitization
app.use(xssSanitizer);

// Routes
app.use("/api/auth", authRoutes);

// 404 handler
app.use((req, res) => {
    res.status(404).json({ success: false, message: "Route not found" });
});

// Global error handler
app.use((err, req, res, next) => {
    console.error("Unhandled error:", err.message);
    res.status(500).json({ success: false, message: "Internal server error" });
});

export default app;
