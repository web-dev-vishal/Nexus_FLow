// XSS sanitizer middleware — strips malicious HTML/script tags from all user input.
// Runs on req.body, req.query, and req.params before any route handler sees the data.
// Uses the 'xss' package which is specifically designed for this purpose.

import { filterXSS } from "xss";

// Recursively walk through an object and sanitize every string value.
// Handles nested objects and arrays so nothing slips through.
const sanitizeObject = (obj) => {
    if (typeof obj === "string") return filterXSS(obj);
    if (Array.isArray(obj))     return obj.map(sanitizeObject);
    if (obj !== null && typeof obj === "object") {
        return Object.fromEntries(
            Object.entries(obj).map(([k, v]) => [k, sanitizeObject(v)])
        );
    }
    // Numbers, booleans, null — pass through unchanged
    return obj;
};

// Express middleware — sanitizes all incoming request data against XSS.
// Attach this globally in app.js so every route is protected automatically.
export const xssSanitizer = (req, res, next) => {
    if (req.body)   req.body   = sanitizeObject(req.body);
    if (req.query)  req.query  = sanitizeObject(req.query);
    if (req.params) req.params = sanitizeObject(req.params);
    next();
};
