// Sends a one-time password (OTP) email for password reset.
// The transporter is created once and reused across calls.

import nodemailer from "nodemailer";
import logger from "../utils/logger.js";

// Reuse a single transporter instance
const transporter = nodemailer.createTransport({
    service: process.env.MAIL_SERVICE || "gmail",
    auth: {
        user: process.env.MAIL_USER,
        pass: process.env.MAIL_PASS,
    },
});

export const sendOtpMail = async (email, otp) => {
    await transporter.sendMail({
        from: `"NexusFlow" <${process.env.MAIL_USER}>`,
        to: email,
        subject: "Password Reset OTP",
        html: `<p>Your OTP for password reset is: <b>${otp}</b>. It is valid for 10 minutes.</p>`,
    });

    logger.info("OTP email sent", { to: email });
};