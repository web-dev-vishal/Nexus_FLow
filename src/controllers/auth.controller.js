import {
    registerService,
    verifyEmailService,
    loginService,
    logoutService,
    refreshTokenService,
    forgotPasswordService,
    verifyOTPService,
    changePasswordService,
} from "../services/auth.service.js";

// ─── Helper ──────────────────────────────────────────────────────────────────

/**
 * Extracts Bearer token from Authorization header.
 * Returns null if missing or malformed.
 */
const extractBearerToken = (req) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
    return authHeader.split(" ")[1];
};

/**
 * Sends a consistent error response.
 * Uses err.statusCode if set by the service layer, otherwise 500.
 */
const handleError = (res, err) => {
    const status = err.statusCode || 500;
    return res.status(status).json({ success: false, message: err.message });
};

// ─── Register ────────────────────────────────────────────────────────────────

export const registerUser = async (req, res) => {
    try {
        const data = await registerService(req.body);
        return res.status(201).json({
            success: true,
            message: "User registered successfully. Please verify your email.",
            data,
        });
    } catch (err) {
        return handleError(res, err);
    }
};

// ─── Email Verification ──────────────────────────────────────────────────────

export const verifyEmail = async (req, res) => {
    try {
        const token = extractBearerToken(req);
        if (!token) {
            return res.status(401).json({
                success: false,
                message: "Authorization token is missing or invalid",
            });
        }

        await verifyEmailService(token);
        return res.status(200).json({
            success: true,
            message: "Email verified successfully",
        });
    } catch (err) {
        return handleError(res, err);
    }
};

// ─── Login ───────────────────────────────────────────────────────────────────

export const loginUser = async (req, res) => {
    try {
        const { accessToken, refreshToken, user } = await loginService(req.body);
        return res.status(200).json({
            success: true,
            message: `Welcome back, ${user.username}`,
            accessToken,
            refreshToken,
            user,
        });
    } catch (err) {
        return handleError(res, err);
    }
};

// ─── Logout ──────────────────────────────────────────────────────────────────

export const logoutUser = async (req, res) => {
    try {
        await logoutService(req.userId);
        return res.status(200).json({
            success: true,
            message: "Logged out successfully",
        });
    } catch (err) {
        return handleError(res, err);
    }
};

// ─── Refresh Token ───────────────────────────────────────────────────────────

export const refreshAccessToken = async (req, res) => {
    try {
        const token = extractBearerToken(req);
        if (!token) {
            return res.status(401).json({
                success: false,
                message: "Refresh token is missing or invalid",
            });
        }

        const { accessToken } = await refreshTokenService(token);
        return res.status(200).json({
            success: true,
            accessToken,
        });
    } catch (err) {
        return handleError(res, err);
    }
};

// ─── Get Profile ─────────────────────────────────────────────────────────────

export const getProfile = async (req, res) => {
    try {
        return res.status(200).json({ success: true, user: req.user });
    } catch (err) {
        return handleError(res, err);
    }
};

// ─── Forgot Password ─────────────────────────────────────────────────────────

export const forgotPassword = async (req, res) => {
    try {
        await forgotPasswordService(req.body.email);
        return res.status(200).json({
            success: true,
            message: "OTP sent to your email",
        });
    } catch (err) {
        return handleError(res, err);
    }
};

// ─── Verify OTP ──────────────────────────────────────────────────────────────

export const verifyOTP = async (req, res) => {
    try {
        const { email } = req.params;
        const { otp } = req.body;

        await verifyOTPService(email, otp);
        return res.status(200).json({
            success: true,
            message: "OTP verified successfully",
        });
    } catch (err) {
        return handleError(res, err);
    }
};

// ─── Change Password ─────────────────────────────────────────────────────────

export const changePassword = async (req, res) => {
    try {
        const { email } = req.params;
        await changePasswordService(email, req.body);
        return res.status(200).json({
            success: true,
            message: "Password changed successfully",
        });
    } catch (err) {
        return handleError(res, err);
    }
};
