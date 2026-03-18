import nodemailer from "nodemailer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import handlebars from "handlebars";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const verifyMail = async (token, email) => {
    const templateSource = fs.readFileSync(
        path.join(__dirname, "template.hbs"),
        "utf-8"
    );

    const template = handlebars.compile(templateSource);
    const html = template({
        token: encodeURIComponent(token),
        clientUrl: process.env.CLIENT_URL,
    });

    const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
            user: process.env.MAIL_USER,
            pass: process.env.MAIL_PASS,
        },
    });

    await transporter.sendMail({
        from: process.env.MAIL_USER,
        to: email,
        subject: "Email Verification",
        html,
    });

    console.log("Verification email sent to:", email);
};
