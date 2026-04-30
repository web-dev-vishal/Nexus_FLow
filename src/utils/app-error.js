// Unified error class used across all services.
// Extends native Error so instanceof checks and stack traces work as expected.
export class AppError extends Error {
    constructor(message, statusCode = 500, code = 'INTERNAL_ERROR') {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
    }
}
