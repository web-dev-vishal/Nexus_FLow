// Logger — wraps Winston to give us structured JSON logs in production
// and readable colored logs in development.
//
// Log files are written to the /logs directory:
//   - error.log    — only error-level messages
//   - combined.log — all messages
//   - exceptions.log — uncaught exceptions
//   - rejections.log — unhandled promise rejections
//
// Log level is controlled by the LOG_LEVEL env var (default: "info").

import winston from "winston";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Make sure the logs directory exists — Winston won't create it automatically
const logsDir = path.join(process.cwd(), "logs");
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

// JSON format for log files — structured so log aggregators (Datadog, CloudWatch) can parse it
const jsonFormat = winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.errors({ stack: true }),  // Include stack traces in error logs
    winston.format.json()
);

// Human-readable format for the console — colored and easy to scan
const consoleFormat = winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
        // Only append metadata if there is any — keeps simple logs clean
        const extras = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
        return `${timestamp} [${level}]: ${message}${extras}`;
    })
);

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || "info",
    format: jsonFormat,
    defaultMeta: { service: "swiftpay" },
    transports: [
        // Console — always on, uses the readable format
        new winston.transports.Console({ format: consoleFormat }),

        // Error log — only errors, rotates at 5MB, keeps 5 files
        new winston.transports.File({
            filename: path.join(logsDir, "error.log"),
            level:    "error",
            maxsize:  5 * 1024 * 1024,
            maxFiles: 5,
        }),

        // Combined log — everything, same rotation settings
        new winston.transports.File({
            filename: path.join(logsDir, "combined.log"),
            maxsize:  5 * 1024 * 1024,
            maxFiles: 5,
        }),
    ],

    // Catch uncaught exceptions and unhandled rejections so they get logged
    // before the process crashes
    exceptionHandlers: [
        new winston.transports.File({ filename: path.join(logsDir, "exceptions.log") }),
    ],
    rejectionHandlers: [
        new winston.transports.File({ filename: path.join(logsDir, "rejections.log") }),
    ],
});

export default logger;
