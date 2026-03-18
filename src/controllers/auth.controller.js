import jwt from "jsonwebtoken";
import User from "../models/user.model.js";
import Session from "../models/session.model.js";
import { verifyMail } from "../email/verifyMail.js";
import { sendOtpMail } from "../email/sendOtpMail.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

const generateTokens = (userId) => {
    const accessToken = jwt.sign({ id: userId }, process.env.ACCESS_SECRET, {
        expiresIn: "10d",
    });
    const refreshToken = jwt.sign({ id: userId }, process.env.REFRESH_SECRET, {
        expiresIn: "30d",
    });
    return { accessToken, refreshToken };
};

// ─── Register ────────────────────────────────────────────────────────────────

export const registerUser = async (req, res) => {
    try {
        const { username, email, password } = req.body;

        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).json({
                success: false,
                message: "User already exists",
            });
        }

        // User.create triggers the pre-save hook which hashes the password
        const newUser = await User.create({ username, email, password });

        // Generate a short-lived verification token (separate secret so it can't be used as an access token)
        const verificationToken = jwt.sign(
            { id: newUser._id },
            process.env.VERIFY_SECRET,
            { expiresIn: "10m" }
        );

        // Use findByIdAndUpdate to avoid re-triggering the password pre-save hook
        await User.findByIdAndUpdate(newUser._id, { token: verificationToken });

        // Send verification email (non-blocking — don't fail registration if mail fails)
        verifyMail(verificationToken, email).catch((err) =>
            console.error("Failed to send verification email:", err.message)
        );

        return res.status(201).json({
            success: true,
            message: "User registered successfully. Please verify your email.",
            data: {
                _id: newUser._id,
                username: newUser.username,
                email: newUser.email,
                isVerified: newUser.isVerified,
            },
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

// ─── Email Verification ──────────────────────────────────────────────────────

export const verifyEmail = async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({
                success: false,
                message: "Authorization token is missing or invalid",
            });
        }

        const token = authHeader.split(" ")[1];

        let decoded;
        try {
            decoded = jwt.verify(token, process.env.VERIFY_SECRET);
        } catch (err) {
            if (err.name === "TokenExpiredError") {
                return res.status(400).json({
                    success: false,
                    message: "Verification token has expired. Please register again.",
                });
            }
            return res.status(400).json({
                success: false,
                message: "Token verification failed",
            });
        }

        const user = await User.findById(decoded.id);
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        if (user.isVerified) {
            return res.status(400).json({
                success: false,
                message: "Email is already verified",
            });
        }

        user.token = null;
        user.isVerified = true;
        await user.save();

        return res.status(200).json({
            success: true,
            message: "Email verified successfully",
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

// ─── Login ───────────────────────────────────────────────────────────────────

export const loginUser = async (req, res) => {
    try {
        const { email, password } = req.body;

        const user = await User.findOne({ email });
        if (!user) {
            return res.status(401).json({
                success: false,
                message: "Invalid email or password",
            });
        }

        const isMatch = await user.comparePassword(password);
        if (!isMatch) {
            return res.status(401).json({
                success: false,
                message: "Invalid email or password",
            });
        }

        if (!user.isVerified) {
            return res.status(403).json({
                success: false,
                message: "Please verify your email before logging in",
            });
        }

        // Replace any existing session
        await Session.deleteMany({ userId: user._id });
        await Session.create({ userId: user._id });

        const { accessToken, refreshToken } = generateTokens(user._id);

        user.isLoggedIn = true;
        await user.save();

        return res.status(200).json({
            success: true,
            message: `Welcome back, ${user.username}`,
            accessToken,
            refreshToken,
            user: {
                _id: user._id,
                username: user.username,
                email: user.email,
                role: user.role,
                isVerified: user.isVerified,
            },
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

// ─── Logout ──────────────────────────────────────────────────────────────────

export const logoutUser = async (req, res) => {
    try {
        const userId = req.userId;
        await Session.deleteMany({ userId });
        await User.findByIdAndUpdate(userId, { isLoggedIn: false });

        return res.status(200).json({
            success: true,
            message: "Logged out successfully",
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

// ─── Refresh Token ───────────────────────────────────────────────────────────

export const refreshAccessToken = async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({
                success: false,
                message: "Refresh token is missing or invalid",
            });
        }

        const token = authHeader.split(" ")[1];

        let decoded;
        try {
            decoded = jwt.verify(token, process.env.REFRESH_SECRET);
        } catch (err) {
            if (err.name === "TokenExpiredError") {
                return res.status(401).json({
                    success: false,
                    message: "Refresh token has expired. Please log in again.",
                });
            }
            return res.status(401).json({
                success: false,
                message: "Invalid refresh token",
            });
        }

        // Confirm session still exists
        const session = await Session.findOne({ userId: decoded.id });
        if (!session) {
            return res.status(401).json({
                success: false,
                message: "Session not found. Please log in again.",
            });
        }

        const newAccessToken = jwt.sign(
            { id: decoded.id },
            process.env.ACCESS_SECRET,
            { expiresIn: "10d" }
        );

        return res.status(200).json({
            success: true,
            accessToken: newAccessToken,
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

// ─── Get Profile ─────────────────────────────────────────────────────────────

export const getProfile = async (req, res) => {
    try {
        return res.status(200).json({ success: true, user: req.user });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

// ─── Forgot Password ─────────────────────────────────────────────────────────

export const forgotPassword = async (req, res) => {
    try {
        const { email } = req.body;

        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        user.otp = otp;
        user.otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
        await user.save();

        try {
            await sendOtpMail(email, otp);
        } catch (mailErr) {
            // Roll back OTP if email fails so user can retry
            user.otp = null;
            user.otpExpiry = null;
            await user.save();
            return res.status(500).json({
                success: false,
                message: "Failed to send OTP email. Please try again.",
            });
        }

        return res.status(200).json({
            success: true,
            message: "OTP sent to your email",
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

// ─── Verify OTP ──────────────────────────────────────────────────────────────

export const verifyOTP = async (req, res) => {
    try {
        const { email } = req.params;
        const { otp } = req.body;

        if (!otp) {
            return res.status(400).json({ success: false, message: "OTP is required" });
        }

        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        if (!user.otp || !user.otpExpiry) {
            return res.status(400).json({
                success: false,
                message: "OTP not generated or already used",
            });
        }

        if (user.otpExpiry < new Date()) {
            return res.status(400).json({
                success: false,
                message: "OTP has expired. Please request a new one.",
            });
        }

        if (otp !== user.otp) {
            return res.status(400).json({ success: false, message: "Invalid OTP" });
        }

        user.otp = null;
        user.otpExpiry = null;
        await user.save();

        return res.status(200).json({ success: true, message: "OTP verified successfully" });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

// ─── Change Password ─────────────────────────────────────────────────────────

export const changePassword = async (req, res) => {
    try {
        const { email } = req.params;
        const { newPassword, confirmPassword } = req.body;

        if (!newPassword || !confirmPassword) {
            return res.status(400).json({
                success: false,
                message: "All fields are required",
            });
        }

        if (newPassword !== confirmPassword) {
            return res.status(400).json({
                success: false,
                message: "Passwords do not match",
            });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({
                success: false,
                message: "Password must be at least 6 characters",
            });
        }

        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        // Assign plain password — pre-save hook will hash it
        user.password = newPassword;
        await user.save();

        return res.status(200).json({
            success: true,
            message: "Password changed successfully",
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};
