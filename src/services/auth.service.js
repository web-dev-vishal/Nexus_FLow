// This file contains all the business logic for authentication.
// The controller just calls these functions — it doesn't do any logic itself.
// Keeping logic here (not in the controller) makes it easier to test and reuse.

import jwt from "jsonwebtoken";
import User from "../models/user.model.js";
import { verifyMail } from "../email/verifyMail.js";
import { sendOtpMail } from "../email/sendOtpMail.js";
import { getRedis, keys, TTL } from "../lib/redis.js";
import logger from "../utils/logger.js";

// Shorthand wrapper so we don't have to write getRedis().get() everywhere.
// All three methods just forward to the real Redis client.
const redis = {
    get: (...a) => getRedis().get(...a),
    set: (...a) => getRedis().set(...a),
    del: (...a) => getRedis().del(...a),
};

// ── Helper: create a structured error ────────────────────────────────────────
// We attach a statusCode to the error so the controller knows what HTTP status to send.
// This is cleaner than checking error messages in the controller.
const createError = (statusCode, message) => {
    const err = new Error(message);
    err.statusCode = statusCode;
    return err;
};

// ── Helper: generate access + refresh tokens ──────────────────────────────────
// Access token: short-lived (15 minutes), sent with every API request
// Refresh token: longer-lived (30 days), used only to get a new access token
const generateTokens = (userId) => {
    const id = userId.toString();

    const accessToken = jwt.sign({ id }, process.env.ACCESS_SECRET, {
        expiresIn: "15m",
    });

    const refreshToken = jwt.sign({ id }, process.env.REFRESH_SECRET, {
        expiresIn: "30d",
    });

    return { accessToken, refreshToken };
};

// ── Register ──────────────────────────────────────────────────────────────────
export const registerService = async ({ username, email, password }) => {
    // Make sure no one else already has this email
    const existingUser = await User.findOne({ email });
    if (existingUser) {
        throw createError(400, "User already exists");
    }

    // Create the user — the pre-save hook in user.model.js will hash the password automatically
    const newUser = await User.create({ username, email, password });

    // Create a short-lived token just for email verification (uses a separate secret)
    const verificationToken = jwt.sign(
        { id: newUser._id.toString() },
        process.env.VERIFY_SECRET,
        { expiresIn: "10m" } // expires in 10 minutes — user must verify quickly
    );

    // Store the token in Redis so we can check it when the user clicks the link
    // We don't store it in MongoDB to avoid the pre-save hook re-hashing the password
    await redis.set(
        keys.verifyToken(newUser._id.toString()),
        verificationToken,
        "EX",
        TTL.VERIFY
    );

    // Send the verification email — we don't await this so registration doesn't slow down
    // If the email fails, we just log it — the user can request a new one
    verifyMail(verificationToken, email).catch((err) =>
        logger.error("Failed to send verification email:", err.message)
    );

    // Return only safe fields — never return the password hash
    return {
        _id:        newUser._id,
        username:   newUser.username,
        email:      newUser.email,
        isVerified: newUser.isVerified,
    };
};

// ── Email Verification ────────────────────────────────────────────────────────
export const verifyEmailService = async (token) => {
    // Decode the token — this will throw if it's expired or tampered with
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

    // Double-check the token against what we stored in Redis
    // This prevents someone from reusing an old token after they've already verified
    const storedToken = await redis.get(keys.verifyToken(userId));
    if (!storedToken || storedToken !== token) {
        throw createError(400, "Verification token is invalid or already used");
    }

    // Find the user and mark them as verified
    const user = await User.findById(userId);
    if (!user) throw createError(404, "User not found");
    if (user.isVerified) throw createError(400, "Email is already verified");

    user.isVerified = true;
    await user.save();

    // Delete the token from Redis — it's been used, can't be used again
    await redis.del(keys.verifyToken(userId));
};

// ── Login ─────────────────────────────────────────────────────────────────────
export const loginService = async ({ email, password }) => {
    // Look up the user by email
    const user = await User.findOne({ email });
    if (!user) {
        // Use the same error message for wrong email AND wrong password
        // This prevents attackers from figuring out which emails are registered
        throw createError(401, "Invalid email or password");
    }

    // Check the password using bcrypt — comparePassword is defined on the User model
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
        throw createError(401, "Invalid email or password");
    }

    // Block login if the user hasn't verified their email yet
    if (!user.isVerified) {
        throw createError(403, "Please verify your email before logging in");
    }

    // Generate both tokens
    const { accessToken, refreshToken } = generateTokens(user._id);

    // Store the refresh token in Redis — this is how we track active sessions
    // When the user logs out, we delete this key so the token can't be used again
    await redis.set(
        keys.refreshToken(user._id.toString()),
        refreshToken,
        "EX",
        TTL.REFRESH
    );

    // Cache the user's profile in Redis so the auth middleware doesn't hit MongoDB on every request
    const userPayload = {
        _id:        user._id,
        username:   user.username,
        email:      user.email,
        role:       user.role,
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

// ── Logout ────────────────────────────────────────────────────────────────────
export const logoutService = async (userId) => {
    const id = userId.toString();

    // Delete the refresh token — this invalidates the session immediately
    // Even if someone has the token, it won't work anymore
    await redis.del(keys.refreshToken(id));

    // Also clear the user cache so stale data doesn't linger
    await redis.del(keys.userCache(id));

    // No database write needed — Redis is the source of truth for sessions
};

// ── Refresh Token ─────────────────────────────────────────────────────────────
export const refreshTokenService = async (token) => {
    // Verify the token is valid and not expired
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

    // Check the token matches what we have stored in Redis
    // This catches cases where the user already logged out but still has the old token
    const storedToken = await redis.get(keys.refreshToken(userId));
    if (!storedToken || storedToken !== token) {
        throw createError(401, "Refresh token is invalid or session has expired. Please log in again.");
    }

    // Issue a fresh access token — the refresh token stays the same
    const accessToken = jwt.sign(
        { id: userId },
        process.env.ACCESS_SECRET,
        { expiresIn: "15m" }
    );

    return { accessToken };
};

// ── Get Cached User (used by auth middleware) ─────────────────────────────────
export const getCachedUser = async (userId) => {
    const id = userId.toString();

    // Try Redis first — this is the fast path (no database query)
    const cached = await redis.get(keys.userCache(id));
    if (cached) {
        return JSON.parse(cached);
    }

    // Cache miss — go to MongoDB and then re-cache the result
    const user = await User.findById(id).select("-password"); // never return the password hash
    if (!user) return null;

    const userPayload = {
        _id:        user._id,
        username:   user.username,
        email:      user.email,
        role:       user.role,
        isVerified: user.isVerified,
    };

    // Put it back in Redis so the next request is fast again
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
    // Make sure the email belongs to a real user
    const user = await User.findOne({ email });
    if (!user) throw createError(404, "User not found");

    // Generate a 6-digit OTP (one-time password)
    // Math.random() gives a number between 0 and 1, multiplying by 900000 and adding 100000
    // ensures we always get a 6-digit number (100000 to 999999)
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Store the OTP in Redis with a 10-minute expiry
    await redis.set(keys.otp(email), otp, "EX", TTL.OTP);

    try {
        // Send the OTP to the user's email
        await sendOtpMail(email, otp);
    } catch (mailErr) {
        // If the email fails, delete the OTP from Redis so the user can try again cleanly
        await redis.del(keys.otp(email));
        throw createError(500, "Failed to send OTP email. Please try again.");
    }
};

// ── Verify OTP ────────────────────────────────────────────────────────────────
export const verifyOTPService = async (email, otp) => {
    const user = await User.findOne({ email });
    if (!user) throw createError(404, "User not found");

    // Get the OTP we stored in Redis
    const storedOtp = await redis.get(keys.otp(email));
    if (!storedOtp) {
        throw createError(400, "OTP not generated or already used");
    }

    // Check if the OTP the user entered matches what we sent them
    if (otp !== storedOtp) {
        throw createError(400, "Invalid OTP");
    }

    // Delete the OTP immediately — it's single-use only
    await redis.del(keys.otp(email));

    // Set a short-lived flag so changePasswordService knows OTP was verified.
    // Without this, someone could skip OTP and go straight to change-password.
    await redis.set(`otp_verified:${email}`, "true", "EX", TTL.OTP);
};

// ── Change Password ───────────────────────────────────────────────────────────
export const changePasswordService = async (email, { newPassword }) => {
    // Verify the user passed OTP verification before allowing password change.
    // Without this check, anyone who knows an email could directly change the password.
    const otpVerified = await redis.get(`otp_verified:${email}`);
    if (!otpVerified) {
        throw createError(403, "OTP verification required before changing password");
    }

    if (newPassword.length < 6) {
        throw createError(400, "Password must be at least 6 characters");
    }

    const user = await User.findOne({ email });
    if (!user) throw createError(404, "User not found");

    // Set the new plain-text password — the pre-save hook in user.model.js will hash it
    user.password = newPassword;
    await user.save();

    // Clean up the OTP verification flag — single-use only
    await redis.del(`otp_verified:${email}`);

    // Force the user to log in again with the new password
    // by clearing their session and cache
    const id = user._id.toString();
    await redis.del(keys.userCache(id));
    await redis.del(keys.refreshToken(id));
};

// ── Resend Verification Email ─────────────────────────────────────────────────
// If the 10-minute verification token expired, the user can request a fresh one.
// We block this if the account is already verified — no point resending.
export const resendVerificationService = async (email) => {
    const user = await User.findOne({ email });
    if (!user) throw createError(404, "User not found");

    if (user.isVerified) {
        throw createError(400, "This account is already verified");
    }

    // Generate a fresh verification token
    const verificationToken = jwt.sign(
        { id: user._id.toString() },
        process.env.VERIFY_SECRET,
        { expiresIn: "10m" }
    );

    // Overwrite any old token in Redis — only the latest one is valid
    await redis.set(
        keys.verifyToken(user._id.toString()),
        verificationToken,
        "EX",
        TTL.VERIFY
    );

    // Send the new email
    await verifyMail(verificationToken, email);
};

// ── Update Profile ────────────────────────────────────────────────────────────
// Let a logged-in user update their username or email.
// We only update fields that were actually sent — ignore anything else.
export const updateProfileService = async (userId, { username, email }) => {
    const updates = {};

    if (username) {
        // Zod already validated length and format — just trim and store
        updates.username = username.trim();
    }

    if (email) {
        // Make sure no other account already uses this email — that's a DB concern, not input validation
        const existing = await User.findOne({ email, _id: { $ne: userId } });
        if (existing) {
            throw createError(409, "Email is already in use by another account");
        }

        updates.email = email.toLowerCase().trim();
        // If they change their email, require re-verification
        updates.isVerified = false;
    }

    const user = await User.findByIdAndUpdate(
        userId,
        { $set: updates },
        { new: true, runValidators: true }
    ).select("-password -__v");

    if (!user) throw createError(404, "User not found");

    // Clear the cached profile so the next request gets fresh data
    await redis.del(keys.userCache(userId));

    return user;
};
