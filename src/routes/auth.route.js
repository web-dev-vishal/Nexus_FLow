import express from "express";
import {
    registerUser,
    verifyEmail,
    loginUser,
    logoutUser,
    refreshAccessToken,
    getProfile,
    forgotPassword,
    verifyOTP,
    changePassword,
} from "../controllers/auth.controller.js";
import { isAuthenticated } from "../middleware/auth.middleware.js";
import { validate, registerSchema, loginSchema } from "../validators/user.validate.js";

const router = express.Router();

// Public routes
router.post("/register", validate(registerSchema), registerUser);
router.get("/verify-email", verifyEmail);           // token via Authorization header
router.post("/login", validate(loginSchema), loginUser);
router.post("/forgot-password", forgotPassword);
router.post("/verify-otp/:email", verifyOTP);
router.post("/change-password/:email", changePassword);
router.post("/refresh-token", refreshAccessToken);  // refreshToken via Authorization header

// Protected routes
router.post("/logout", isAuthenticated, logoutUser);
router.get("/profile", isAuthenticated, getProfile);

export default router;
