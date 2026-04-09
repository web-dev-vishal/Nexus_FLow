// Sends a verification email to new users with a clickable link.
// The template is loaded once at startup, and the transporter is reused across calls.

import nodemailer from "nodemailer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import handlebars from "handlebars";
import logger from "../utils/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read and compile the template once at module load — no need to hit the disk on every send
const templateSource = fs.readFileSync(path.join(__dirname, "template.hbs"), "utf-8");
const template = handlebars.compile(templateSource);

// Reuse a single transporter instance — creating one per call is wasteful
const transporter = nodemailer.createTransport({
    service: process.env.MAIL_SERVICE || "gmail",
    auth: {
        user: process.env.MAIL_USER,
        pass: process.env.MAIL_PASS,
    },
});

export const verifyMail = async (token, email) => {
    const html = template({
        token: encodeURIComponent(token),
        clientUrl: process.env.CLIENT_URL,
    });

    await transporter.sendMail({
        from: `"NexusFlow" <${process.env.MAIL_USER}>`,
        to: email,
        subject: "Email Verification",
        html,
    });

    logger.info("Verification email sent", { to: email });
};