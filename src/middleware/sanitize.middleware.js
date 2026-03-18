import { filterXSS } from "xss";

/**
 * Recursively sanitizes all string values in an object against XSS.
 */
const sanitizeObject = (obj) => {
    if (typeof obj === "string") return filterXSS(obj);
    if (Array.isArray(obj)) return obj.map(sanitizeObject);
    if (obj !== null && typeof obj === "object") {
        return Object.fromEntries(
            Object.entries(obj).map(([k, v]) => [k, sanitizeObject(v)])
        );
    }
    return obj;
};

/**
 * Middleware — sanitizes req.body, req.query, and req.params against XSS.
 */
export const xssSanitizer = (req, res, next) => {
    if (req.body)   req.body   = sanitizeObject(req.body);
    if (req.query)  req.query  = sanitizeObject(req.query);
    if (req.params) req.params = sanitizeObject(req.params);
    next();
};
