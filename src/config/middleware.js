import helmet from "helmet";
import cors from "cors";
import compression from "compression";
import cookieParser from "cookie-parser";
import mongoSanitize from "express-mongo-sanitize";
import hpp from "hpp";
import { v4 as uuidv4 } from "uuid";
import express from "express";
import client from "prom-client";

import { globalLimiter } from "../middleware/rate-limit.middleware.js";
import { xssSanitizer } from "../middleware/sanitize.middleware.js";

const httpDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duration of HTTP requests in seconds',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.1, 0.3, 0.5, 1, 1.5, 2, 5],
});

export default function setupMiddleware(app) {
    // Security headers — sets X-Content-Type-Options, X-Frame-Options, CSP, etc.
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc:  ["'self'"],
                styleSrc:   ["'self'"],
                imgSrc:     ["'self'", "data:", "https:"],
                connectSrc: ["'self'"],
                fontSrc:    ["'self'"],
                objectSrc:  ["'none'"],
                frameSrc:   ["'none'"],
            },
        },
    }));

    // Allow cross-origin requests from the configured frontend origin only
    // Never fall back to "*" — that would allow any site to make credentialed requests
    const allowedOrigin = process.env.CLIENT_URL || process.env.CORS_ORIGIN;
    app.use(cors({
        origin:         allowedOrigin || (process.env.NODE_ENV === "production" ? false : "*"),
        credentials:    true,
        methods:        ["GET", "POST", "PUT", "DELETE", "PATCH"],
        allowedHeaders: ["Content-Type", "Authorization", "X-Correlation-ID"],
    }));

    // Compress all responses — reduces bandwidth significantly for JSON payloads
    app.use(compression());

    // Attach a unique correlation ID to every request for distributed tracing.
    // Clients can pass their own via X-Correlation-ID header, or we generate one.
    app.use((req, _res, next) => {
        req.correlationId = req.headers["x-correlation-id"] || uuidv4();
        next();
    });

    // Track HTTP request duration for Prometheus metrics
    app.use((req, res, next) => {
        const end = httpDuration.startTimer();
        res.on('finish', () => {
            end({
                method: req.method,
                route: req.route?.path || req.path,
                status_code: res.statusCode,
            });
        });
        next();
    });

    // Parse JSON and URL-encoded bodies, cap at 10kb to prevent large payload attacks
    app.use(express.json({ limit: "10kb" }));
    app.use(express.urlencoded({ extended: true, limit: "10kb" }));
    app.use(cookieParser());

    // Strip MongoDB operators from user input (prevents NoSQL injection)
    app.use(mongoSanitize());

    // Prevent HTTP parameter pollution (e.g. ?status=active&status=suspended)
    app.use(hpp());

    // Sanitize all string values in body/query/params against XSS
    app.use(xssSanitizer);

    // Global rate limiter — 100 requests per 15 minutes per IP
    app.use(globalLimiter);

    // Request timeout — respond with 503 if a request takes longer than 30 seconds
    app.use((req, res, next) => {
        const timer = setTimeout(() => {
            if (!res.headersSent) {
                res.status(503).json({ success: false, error: 'Request timeout', code: 'REQUEST_TIMEOUT' });
            }
        }, 30_000);
        res.on('finish', () => clearTimeout(timer));
        res.on('close', () => clearTimeout(timer));
        next();
    });
}
