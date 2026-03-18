import { z } from "zod";

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const registerSchema = z.object({
    username: z
        .string({ required_error: "Username is required" })
        .trim()
        .min(3, "Username must be at least 3 characters")
        .max(30, "Username must be at most 30 characters")
        .regex(/^[a-zA-Z0-9_]+$/, "Username can only contain letters, numbers and underscores"),
    email: z
        .string({ required_error: "Email is required" })
        .trim()
        .toLowerCase()
        .email("Please provide a valid email"),
    password: z
        .string({ required_error: "Password is required" })
        .min(6, "Password must be at least 6 characters")
        .max(64, "Password must be at most 64 characters"),
});

export const loginSchema = z.object({
    email: z
        .string({ required_error: "Email is required" })
        .trim()
        .toLowerCase()
        .email("Please provide a valid email"),
    password: z
        .string({ required_error: "Password is required" })
        .min(1, "Password is required"),
});

export const forgotPasswordSchema = z.object({
    email: z
        .string({ required_error: "Email is required" })
        .trim()
        .toLowerCase()
        .email("Please provide a valid email"),
});

export const verifyOtpSchema = z.object({
    otp: z
        .string({ required_error: "OTP is required" })
        .length(6, "OTP must be exactly 6 digits")
        .regex(/^\d{6}$/, "OTP must contain only digits"),
});

export const changePasswordSchema = z.object({
    newPassword: z
        .string({ required_error: "New password is required" })
        .min(6, "Password must be at least 6 characters")
        .max(64, "Password must be at most 64 characters"),
    confirmPassword: z
        .string({ required_error: "Confirm password is required" })
        .min(1, "Confirm password is required"),
}).refine((data) => data.newPassword === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
});

// ─── Middleware factory ───────────────────────────────────────────────────────

/**
 * Validates req.body against a Zod schema.
 * Returns 400 with all validation errors if invalid.
 */
export const validate = (schema) => (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
        const errors = result.error.errors.map((e) => e.message);
        return res.status(400).json({ success: false, errors });
    }
    // Replace req.body with the parsed (coerced + trimmed) data
    req.body = result.data;
    next();
};
