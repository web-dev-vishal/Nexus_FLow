// Auth service — all business logic for registration, login, and session management.
// Uses PASETO v4.public (Ed25519) instead of JWT.
// Private key signs tokens; public key verifies them.
// Refresh tokens are stored server-side in Redis — deleting the key = instant logout.

import User from "../models/user.model.js";
import { verifyMail } from "../email/verifyMail.js";
import { sendOtpMail } from "../email/sendOtpMail.js";
import { getRedis, keys, TTL } from "../lib/redis.js";
import logger from "../utils/logger.js";
import { AppError } from "../utils/app-error.js";
import {
    issueTokenPair,
    issueAccessToken,
    issueVerifyToken,
    verifyRefreshToken,
    verifyVerifyToken,
} from "./token.service.js";

// Thin Redis wrapper so we don't write getRedis().get() everywhere
const redis = {
    get: (...a) => getRedis().get(...a),
    set: (...a) => getRedis().set(...a),
    del: (...a) => getRedis().del(...a),
};

// ── Register ──────────────────────────────────────────────────────────────────
export const registerService = async ({ username, email, password }) => {
    const existingUser = await User.findOne({ email });
    if (existingUser) throw new AppError("User already exists", 400, "USER_EXISTS");

    // pre-save hook in user.model.js hashes the password automatically
    const newUser = await User.create({ username, email, password });

    const verificationToken = await issueVerifyToken(newUser._id);

    await redis.set(
        keys.verifyToken(newUser._id.toString()),
        verificationToken,
        "EX",
        TTL.VERIFY
    );

    // Fire-and-forget — don't block registration if email is slow
    verifyMail(verificationToken, email).catch((err) =>
        logger.error("Failed to send verification email:", err.message)
    );

    return {
        _id:        newUser._id,
        username:   newUser.username,
        email:      newUser.email,
        isVerified: newUser.isVerified,
    };
};

// ── Email Verification ────────────────────────────────────────────────────────
export const verifyEmailService = async (token) => {
    let payload;
    try {
        payload = await verifyVerifyToken(token);
    } catch (err) {
        if (err.code === "TOKEN_EXPIRED") {
            throw new AppError("Verification token has expired. Please request a new one.", 400, "TOKEN_EXPIRED");
        }
        throw new AppError("Verification token is invalid.", 400, "INVALID_TOKEN");
    }

    const userId = payload.sub;

    // Compare against Redis — prevents reuse of an already-used token
    const storedToken = await redis.get(keys.verifyToken(userId));
    if (!storedToken || storedToken !== token) {
        throw new AppError("Verification token is invalid or already used.", 400, "INVALID_TOKEN");
    }

    const user = await User.findById(userId);
    if (!user)           throw new AppError("User not found.", 404, "USER_NOT_FOUND");
    if (user.isVerified) throw new AppError("Email is already verified.", 400, "ALREADY_VERIFIED");

    user.isVerified = true;
    await user.save();

    // Single-use — delete so it can't be replayed
    await redis.del(keys.verifyToken(userId));
};

// ── Login ─────────────────────────────────────────────────────────────────────
export const loginService = async ({ email, password }) => {
    const user = await User.findOne({ email });
    if (!user) {
        // Same message for wrong email and wrong password — prevents user enumeration
        throw new AppError("Invalid email or password", 401, "INVALID_CREDENTIALS");
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) throw new AppError("Invalid email or password", 401, "INVALID_CREDENTIALS");

    if (!user.isVerified) {
        throw new AppError("Please verify your email before logging in", 403, "EMAIL_NOT_VERIFIED");
    }

    const { accessToken, refreshToken } = await issueTokenPair(user._id, { role: user.role, isVerified: user.isVerified });

    // Store refresh token server-side — deleting this key = instant session invalidation
    await redis.set(
        keys.refreshToken(user._id.toString()),
        refreshToken,
        "EX",
        TTL.REFRESH
    );

    const userPayload = {
        _id:        user._id,
        username:   user.username,
        email:      user.email,
        role:       user.role,
        isVerified: user.isVerified,
    };

    // Cache the profile so auth middleware skips MongoDB on every request
    await redis.set(
        keys.userCache(user._id.toString()),
        JSON.stringify(userPayload),
        "EX",
        TTL.USER_CACHE
    );

    return { accessToken, refreshToken, user: userPayload };
};

// ── Logout ────────────────────────────────────────────────────────────────────
export const logoutService = async (userId) => {
    const id = userId.toString();
    await redis.del(keys.refreshToken(id));
    await redis.del(keys.userCache(id));
};

// ── Refresh Token ─────────────────────────────────────────────────────────────
export const refreshTokenService = async (token) => {
    let payload;
    try {
        payload = await verifyRefreshToken(token);
    } catch (err) {
        if (err.code === "TOKEN_EXPIRED") {
            throw new AppError("Refresh token has expired. Please log in again.", 401, "TOKEN_EXPIRED");
        }
        throw new AppError("Invalid refresh token.", 401, "INVALID_TOKEN");
    }

    const userId = payload.sub;

    // Validate against Redis — catches tokens from already-logged-out sessions
    const storedToken = await redis.get(keys.refreshToken(userId));
    if (!storedToken || storedToken !== token) {
        throw new AppError("Refresh token is invalid or session has expired. Please log in again.", 401, "INVALID_TOKEN");
    }

    // Get user from cache to embed claims in new access token
    const cachedUser = await getCachedUser(userId);
    const accessToken = await issueAccessToken(userId, {
        role: cachedUser?.role || 'user',
        isVerified: cachedUser?.isVerified ?? false,
    });
    return { accessToken };
};

// ── Get Cached User (used by auth middleware) ─────────────────────────────────
export const getCachedUser = async (userId) => {
    const id = userId.toString();

    const cached = await redis.get(keys.userCache(id));
    if (cached) return JSON.parse(cached);

    const user = await User.findById(id).select("-password -__v");
    if (!user) return null;

    const userPayload = {
        _id:        user._id,
        username:   user.username,
        email:      user.email,
        role:       user.role,
        isVerified: user.isVerified,
    };

    await redis.set(
        keys.userCache(id),
        JSON.stringify(userPayload),
        "EX",
        TTL.USER_CACHE
    );

    return userPayload;
};

// ── Forgot Password ───────────────────────────────────────────────────────────
export const forgotPasswordService = async (email) => {
    const user = await User.findOne({ email });
    if (!user) throw new AppError("User not found", 404, "USER_NOT_FOUND");

    // 6-digit OTP — 100000 to 999999
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    await redis.set(keys.otp(email), otp, "EX", TTL.OTP);

    try {
        await sendOtpMail(email, otp);
    } catch (mailErr) {
        await redis.del(keys.otp(email));
        throw new AppError("Failed to send OTP email. Please try again.", 500, "EMAIL_SEND_FAILED");
    }
};

// ── Verify OTP ────────────────────────────────────────────────────────────────
export const verifyOTPService = async (email, otp) => {
    const user = await User.findOne({ email });
    if (!user) throw new AppError("User not found", 404, "USER_NOT_FOUND");

    const storedOtp = await redis.get(keys.otp(email));
    if (!storedOtp)        throw new AppError("OTP not generated or already used", 400, "OTP_INVALID");
    if (otp !== storedOtp) throw new AppError("Invalid OTP", 400, "OTP_INVALID");

    await redis.del(keys.otp(email));

    // Short-lived flag so changePasswordService knows OTP was verified
    await redis.set(`otp_verified:${email}`, "true", "EX", TTL.OTP);
};

// ── Change Password ───────────────────────────────────────────────────────────
export const changePasswordService = async (email, { newPassword }) => {
    const otpVerified = await redis.get(`otp_verified:${email}`);
    if (!otpVerified) {
        throw new AppError("OTP verification required before changing password", 403, "OTP_REQUIRED");
    }

    if (newPassword.length < 6) {
        throw new AppError("Password must be at least 6 characters", 400, "INVALID_PASSWORD");
    }

    const user = await User.findOne({ email });
    if (!user) throw new AppError("User not found", 404, "USER_NOT_FOUND");

    // Assign plain text — pre-save hook hashes it
    user.password = newPassword;
    await user.save();

    await redis.del(`otp_verified:${email}`);
    await redis.del(keys.userCache(user._id.toString()));
    await redis.del(keys.refreshToken(user._id.toString()));
};

// ── Resend Verification Email ─────────────────────────────────────────────────
export const resendVerificationService = async (email) => {
    const user = await User.findOne({ email });
    if (!user)           throw new AppError("User not found", 404, "USER_NOT_FOUND");
    if (user.isVerified) throw new AppError("This account is already verified", 400, "ALREADY_VERIFIED");

    const verificationToken = await issueVerifyToken(user._id);

    await redis.set(
        keys.verifyToken(user._id.toString()),
        verificationToken,
        "EX",
        TTL.VERIFY
    );

    await verifyMail(verificationToken, email);
};

// ── Update Profile ────────────────────────────────────────────────────────────
export const updateProfileService = async (userId, { username, email }) => {
    const updates = {};

    if (username) updates.username = username.trim();

    if (email) {
        const existing = await User.findOne({ email, _id: { $ne: userId } });
        if (existing) throw new AppError("Email is already in use by another account", 409, "EMAIL_IN_USE");
        updates.email      = email.toLowerCase().trim();
        updates.isVerified = false;
    }

    const user = await User.findByIdAndUpdate(
        userId,
        { $set: updates },
        { new: true, runValidators: true }
    ).select("-password -__v");

    if (!user) throw new AppError("User not found", 404, "USER_NOT_FOUND");

    await redis.del(keys.userCache(userId));
    return user;
};
