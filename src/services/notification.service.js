// Notification Service — sends email (and optionally SMS) when payout events happen.
// Email is sent via Nodemailer using the MAIL_USER/MAIL_PASS from .env.
// SMS is optional — only works if TWILIO_* env vars are set.
// All notifications are fire-and-forget — a failed notification never blocks a payout.

import nodemailer from "nodemailer";
import logger from "../utils/logger.js";

class NotificationService {
    constructor() {
        // Set up the email transporter once — reused for all emails
        this.transporter = nodemailer.createTransport({
            service: process.env.MAIL_SERVICE || "gmail",
            auth: {
                user: process.env.MAIL_USER,
                pass: process.env.MAIL_PASS,
            },
        });

        // Twilio is optional — only initialize if credentials are present
        this.twilioClient = null;
        if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
            // Dynamic import so the app doesn't crash if twilio isn't installed
            import("twilio").then(({ default: twilio }) => {
                this.twilioClient = twilio(
                    process.env.TWILIO_ACCOUNT_SID,
                    process.env.TWILIO_AUTH_TOKEN
                );
                logger.info("Twilio SMS notifications enabled");
            }).catch(() => {
                logger.warn("Twilio package not installed — SMS notifications disabled");
            });
        }
    }

    // Send a payout initiated notification
    async notifyPayoutInitiated(user, { transactionId, amount, currency }) {
        const subject = "Your payout has been initiated";
        const html = this._buildEmail({
            title:   "Payout Initiated",
            color:   "#3b82f6", // blue
            message: `Your payout of <strong>${amount} ${currency}</strong> has been initiated.`,
            details: [
                { label: "Transaction ID", value: transactionId },
                { label: "Amount",         value: `${amount} ${currency}` },
                { label: "Status",         value: "Initiated" },
                { label: "Time",           value: new Date().toLocaleString() },
            ],
            footer: "Your payout is being processed. You'll receive another notification when it completes.",
        });

        await this._sendEmail(user.email, subject, html);
        await this._sendSms(user.phone, `NexusFlow: Your payout of ${amount} ${currency} has been initiated. Ref: ${transactionId}`);
    }

    // Send a payout completed notification
    async notifyPayoutCompleted(user, { transactionId, amount, currency, newBalance }) {
        const subject = "Your payout is complete";
        const html = this._buildEmail({
            title:   "Payout Completed",
            color:   "#22c55e", // green
            message: `Your payout of <strong>${amount} ${currency}</strong> has been completed successfully.`,
            details: [
                { label: "Transaction ID",  value: transactionId },
                { label: "Amount",          value: `${amount} ${currency}` },
                { label: "Status",          value: "Completed" },
                { label: "New Balance",     value: `${newBalance} USD` },
                { label: "Time",            value: new Date().toLocaleString() },
            ],
            footer: "Thank you for using NexusFlow.",
        });

        await this._sendEmail(user.email, subject, html);
        await this._sendSms(user.phone, `NexusFlow: Payout of ${amount} ${currency} completed. New balance: ${newBalance} USD. Ref: ${transactionId}`);
    }

    // Send a payout failed notification
    async notifyPayoutFailed(user, { transactionId, amount, currency, reason }) {
        const subject = "Your payout failed";
        const html = this._buildEmail({
            title:   "Payout Failed",
            color:   "#ef4444", // red
            message: `Your payout of <strong>${amount} ${currency}</strong> could not be completed.`,
            details: [
                { label: "Transaction ID", value: transactionId },
                { label: "Amount",         value: `${amount} ${currency}` },
                { label: "Status",         value: "Failed" },
                { label: "Reason",         value: reason || "An unexpected error occurred" },
                { label: "Time",           value: new Date().toLocaleString() },
            ],
            footer: "Your balance has not been affected. Please try again or contact support.",
        });

        await this._sendEmail(user.email, subject, html);
        await this._sendSms(user.phone, `NexusFlow: Payout of ${amount} ${currency} failed. Ref: ${transactionId}. Contact support if needed.`);
    }

    // Send a spending limit warning when a user is close to their limit
    async notifySpendingLimitWarning(user, { period, used, limit, currency }) {
        const percentUsed = Math.round((used / limit) * 100);
        const subject = `You've used ${percentUsed}% of your ${period} spending limit`;
        const html = this._buildEmail({
            title:   "Spending Limit Warning",
            color:   "#f59e0b", // amber
            message: `You've used <strong>${percentUsed}%</strong> of your ${period} spending limit.`,
            details: [
                { label: "Period",    value: period },
                { label: "Limit",     value: `${limit} ${currency}` },
                { label: "Used",      value: `${used} ${currency}` },
                { label: "Remaining", value: `${Math.max(0, limit - used)} ${currency}` },
            ],
            footer: "You can update your spending limits in your account settings.",
        });

        await this._sendEmail(user.email, subject, html);
    }

    // Internal: send an email — swallows errors so a failed email never crashes anything
    async _sendEmail(to, subject, html) {
        if (!to || !process.env.MAIL_USER) return;

        try {
            await this.transporter.sendMail({
                from:    `"NexusFlow" <${process.env.MAIL_USER}>`,
                to,
                subject,
                html,
            });
            logger.debug("Email sent", { to, subject });
        } catch (error) {
            // Log but don't throw — email failure should never block a payout
            logger.error("Email send failed", { to, subject, error: error.message });
        }
    }

    // Internal: send an SMS via Twilio — only runs if Twilio is configured
    async _sendSms(to, message) {
        if (!to || !this.twilioClient || !process.env.TWILIO_PHONE_NUMBER) return;

        try {
            await this.twilioClient.messages.create({
                body: message,
                from: process.env.TWILIO_PHONE_NUMBER,
                to,
            });
            logger.debug("SMS sent", { to });
        } catch (error) {
            logger.error("SMS send failed", { to, error: error.message });
        }
    }

    // Build a simple but clean HTML email template
    _buildEmail({ title, color, message, details, footer }) {
        const rows = details.map(({ label, value }) => `
            <tr>
                <td style="padding:8px 0;color:#6b7280;font-size:14px;">${label}</td>
                <td style="padding:8px 0;color:#111827;font-size:14px;font-weight:500;">${value}</td>
            </tr>
        `).join("");

        return `
        <!DOCTYPE html>
        <html>
        <body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;">
            <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
                <div style="background:${color};padding:24px 32px;">
                    <h1 style="margin:0;color:#fff;font-size:20px;">${title}</h1>
                </div>
                <div style="padding:32px;">
                    <p style="margin:0 0 24px;color:#374151;font-size:15px;">${message}</p>
                    <table style="width:100%;border-collapse:collapse;">
                        ${rows}
                    </table>
                    <p style="margin:24px 0 0;color:#6b7280;font-size:13px;">${footer}</p>
                </div>
                <div style="background:#f9fafb;padding:16px 32px;border-top:1px solid #e5e7eb;">
                    <p style="margin:0;color:#9ca3af;font-size:12px;">NexusFlow — Secure Payout Platform</p>
                </div>
            </div>
        </body>
        </html>
        `;
    }
}

export default NotificationService;
