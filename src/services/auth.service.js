import jwt from "jsonwebtoken";
import User from "../models/user.model.js";
import { verifyMail } from "../email/verifyMail.js";
import { sendOtpMail } from "../email/sendOtpMail.js";
import redis, { keys, TTL } from "../lib/redis.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

const createError = (statusCode, message) => {
    const err = new Error(message);
    err.statusCode = statusCode;
    return err;
};

const generateTokens = (userId) => {
    const id = userId.toString();
    const accessToken = jwt.sign({ id }, process.env.ACCESS_SECRET, {
        expiresIn: "10d",
    });
    const refreshToken = jwt.sign({ id }, process.env.REFRESH_SECRET, {
        expiresIn: "30d",
    });
    return { accessToken, refreshToken };
};

// ─── Register ────────────────────────────────────────────────────────────────

export const registerService = async ({ username, email, password }) => {
    const existingUser = await User.findOne({ email });
    if (existingUser) {
        throw createError(400, "User already exists");
    }

    // User.create triggers the pre-save hook which hashes the password
    const newUser = await User.create({ username, email, password });

    // Generate a short-lived verification token (separate secret)
    const verificationToken = jwt.sign(
        { id: newUser._id.toString() },
        process.env.VERIFY_SECRET,
        { expiresIn: "10m" }
    );

    // Store verification token in Redis — no DB write needed, avoids double-hash bug
    await redis.set(
        keys.verifyToken(newUser._id.toString()),
        verificationToken,
        "EX",
        TTL.VERIFY
    );

    // Non-blocking — don't fail registration if mail fails
    verifyMail(verificationToken, email).catch((err) =>
        console.error("Failed to send verification email:", err.message)
    );

    return {
        _id: newUser._id,
        username: newUser.username,
        email: newUser.email,
        isVerified: newUser.isVerified,
    };
};

// ─── Email Verification ──────────────────────────────────────────────────────

export const verifyEmailService = async (token) => {
    let decoded;
    try {
        decoded = jwt.verify(token, process.env.VERIFY_SECRET);
    } catch (err) {
        if (err.name === "TokenExpiredError") {
            throw createError(400, "Verification token has expired. Please register again.");
        }
        throw createError(400, "Token verification failed");
    }

    const userId = decoded.id;

    // Check token exists in Redis (prevents token reuse after verification)
    const storedToken = await redis.get(keys.verifyToken(userId));
    if (!storedToken || storedToken !== token) {
        throw createError(400, "Verification token is invalid or already used");
    }

    const user = await User.findById(userId);
    if (!user) {
        throw createError(404, "User not found");
    }

    if (user.isVerified) {
        throw createError(400, "Email is already verified");
    }

    user.isVerified = true;
    await user.save();

    // Delete token from Redis — can't be reused
    await redis.del(keys.verifyToken(userId));
};

// ─── Login ───────────────────────────────────────────────────────────────────

export const loginService = async ({ email, password }) => {
    const user = await User.findOne({ email });
    if (!user) {
        throw createError(401, "Invalid email or password");
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
        throw createError(401, "Invalid email or password");
    }

    if (!user.isVerified) {
        throw createError(403, "Please verify your email before logging in");
    }

    const { accessToken, refreshToken } = generateTokens(user._id);

    // Store refresh token in Redis with 30-day TTL (replaces Session model)
    await redis.set(
        keys.refreshToken(user._id.toString()),
        refreshToken,
        "EX",
        TTL.REFRESH
    );

    // Cache user profile in Redis to avoid DB hit on every authenticated request
    const userPayload = {
        _id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
        isVerified: user.isVerified,
    };
    await redis.set(
        keys.userCache(user._id.toString()),
        JSON.stringify(userPayload),
        "EX",
        TTL.USER_CACHE
    );

    return { accessToken, refreshToken, user: userPayload };
};

// ─── Logout ──────────────────────────────────────────────────────────────────

export const logoutService = async (userId) => {
    const id = userId.toString();

    // Delete refresh token and user cache from Redis
    await redis.del(keys.refreshToken(id));
    await redis.del(keys.userCache(id));

    // No DB write needed — Redis handles session state
};

// ─── Refresh Token ───────────────────────────────────────────────────────────

export const refreshTokenService = async (token) => {
    let decoded;
    try {
        decoded = jwt.verify(token, process.env.REFRESH_SECRET);
    } catch (err) {
        if (err.name === "TokenExpiredError") {
            throw createError(401, "Refresh token has expired. Please log in again.");
        }
        throw createError(401, "Invalid refresh token");
    }

    const userId = decoded.id;

    // Validate token against what's stored in Redis
    const storedToken = await redis.get(keys.refreshToken(userId));
    if (!storedToken || storedToken !== token) {
        throw createError(401, "Refresh token is invalid or session has expired. Please log in again.");
    }

    const accessToken = jwt.sign(
        { id: userId },
        process.env.ACCESS_SECRET,
        { expiresIn: "10d" }
    );

    return { accessToken };
};

// ─── Get Cached User (used by middleware) ────────────────────────────────────

export const getCachedUser = async (userId) => {
    const id = userId.toString();
    const cached = await redis.get(keys.userCache(id));
    if (cached) {
        return JSON.parse(cached);
    }

    // Cache miss — fetch from DB and re-cache
    const user = await User.findById(id).select("-password");
    if (!user) return null;

    const userPayload = {
        _id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
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

// ─── Forgot Password ─────────────────────────────────────────────────────────

export const forgotPasswordService = async (email) => {
    const user = await User.findOne({ email });
    if (!user) {
        throw createError(404, "User not found");
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Store OTP in Redis with 10-minute TTL
    await redis.set(keys.otp(email), otp, "EX", TTL.OTP);

    try {
        await sendOtpMail(email, otp);
    } catch (mailErr) {
        // Roll back: delete OTP from Redis so user can retry cleanly
        await redis.del(keys.otp(email));
        throw createError(500, "Failed to send OTP email. Please try again.");
    }
};

// ─── Verify OTP ──────────────────────────────────────────────────────────────

export const verifyOTPService = async (email, otp) => {
    const user = await User.findOne({ email });
    if (!user) {
        throw createError(404, "User not found");
    }

    const storedOtp = await redis.get(keys.otp(email));
    if (!storedOtp) {
        throw createError(400, "OTP not generated or already used");
    }

    if (otp !== storedOtp) {
        throw createError(400, "Invalid OTP");
    }

    // Delete immediately — single use only
    await redis.del(keys.otp(email));
};

// ─── Change Password ─────────────────────────────────────────────────────────

export const changePasswordService = async (email, { newPassword }) => {
    if (newPassword.length < 6) {
        throw createError(400, "Password must be at least 6 characters");
    }

    const user = await User.findOne({ email });
    if (!user) {
        throw createError(404, "User not found");
    }

    // Assign plain password — pre-save hook will hash it
    user.password = newPassword;
    await user.save();

    // Invalidate user cache and force re-login by deleting refresh token
    const id = user._id.toString();
    await redis.del(keys.userCache(id));
    await redis.del(keys.refreshToken(id));
};
