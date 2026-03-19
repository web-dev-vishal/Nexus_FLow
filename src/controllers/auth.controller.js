// Auth controller — handles all HTTP requests for user authentication.
// Each function here is thin: validate the request, call the service, format the response.
// All the real logic lives in auth.service.js.

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

// Pull the Bearer token out of the Authorization header.
// Returns null if the header is missing or not in "Bearer <token>" format.
const extractBearerToken = (req) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
    return authHeader.split(" ")[1];
};

// Send a consistent error response.
// The service layer sets err.statusCode on known errors — we use 500 as a fallback.
const handleError = (res, err) => {
    const status = err.statusCode || 500;
    return res.status(status).json({ success: false, message: err.message });
};

// POST /api/auth/register
// Creates a new user account and sends a verification email.
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

// GET /api/auth/verify-email
// The user clicks a link in their email — the token is in the Authorization header.
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

// POST /api/auth/login
// Returns an access token and a refresh token on success.
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

// POST /api/auth/logout
// Invalidates the user's refresh token in Redis so it can't be used again.
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

// POST /api/auth/refresh-token
// Exchange a valid refresh token for a new access token.
// The refresh token must be in the Authorization header.
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

// GET /api/auth/profile
// Returns the currently logged-in user's profile.
// req.user is set by the isAuthenticated middleware before this runs.
export const getProfile = async (req, res) => {
    try {
        return res.status(200).json({ success: true, user: req.user });
    } catch (err) {
        return handleError(res, err);
    }
};

// POST /api/auth/forgot-password
// Sends a 6-digit OTP to the user's email address.
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

// POST /api/auth/verify-otp/:email
// Checks the OTP the user entered against what we stored in Redis.
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

// POST /api/auth/change-password/:email
// Sets a new password after the user has verified their OTP.
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
