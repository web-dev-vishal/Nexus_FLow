// Token service — PASETO v4.public (Ed25519 asymmetric signing).
//
// Why PASETO over JWT?
//   - No algorithm confusion attacks (JWT's "alg: none" / RS-HS swap don't exist here)
//   - Version + purpose are baked into the token format — can't mix up key types
//   - exp claim is an ISO string enforced by the library, not a raw number we might forget
//   - Asymmetric: private key signs, public key verifies
//     (public key can be shared with other services without exposing the secret)
//
// Three key pairs:
//   - access  — short-lived (15 min), sent with every API request
//   - refresh — long-lived (30 days), stored server-side in Redis
//   - verify  — short-lived (10 min), used only for email verification links
//
// Generate keys once with: node scripts/generate-keys.js
// Store the output in your .env file.

import { V4 } from "paseto";
import { createPublicKey } from "crypto";
import crypto from "crypto";
import logger from "../utils/logger.js";

// ── Key loading ───────────────────────────────────────────────────────────────
// V4.generateKey() returns only the private key.
// We derive the public key from it using Node's createPublicKey().
// Keys are stored as hex strings in .env — 128 hex chars for private, 64 for public.

function loadKeyPair(privateHex, publicHex, name) {
    if (!privateHex || !publicHex) {
        throw new Error(
            `PASETO ${name} key pair missing. Run: node scripts/generate-keys.js`
        );
    }

    const privateBytes = Buffer.from(privateHex, "hex");
    const publicBytes  = Buffer.from(publicHex,  "hex");

    if (privateBytes.length !== 64) {
        throw new Error(
            `PASETO ${name} private key must be 64 bytes (128 hex chars). Got ${privateBytes.length}.`
        );
    }
    if (publicBytes.length !== 32) {
        throw new Error(
            `PASETO ${name} public key must be 32 bytes (64 hex chars). Got ${publicBytes.length}.`
        );
    }

    const privateKey = V4.bytesToKeyObject(privateBytes);
    const publicKey  = V4.bytesToKeyObject(publicBytes);

    return { privateKey, publicKey };
}

let accessKeys, refreshKeys, verifyKeys;

try {
    accessKeys  = loadKeyPair(process.env.PASETO_ACCESS_PRIVATE,  process.env.PASETO_ACCESS_PUBLIC,  "access");
    refreshKeys = loadKeyPair(process.env.PASETO_REFRESH_PRIVATE, process.env.PASETO_REFRESH_PUBLIC, "refresh");
    verifyKeys  = loadKeyPair(process.env.PASETO_VERIFY_PRIVATE,  process.env.PASETO_VERIFY_PUBLIC,  "verify");
} catch (err) {
    // Keys won't be set in test environments — warn but don't crash the import
    logger.warn("PASETO keys not loaded:", err.message);
}

// ── TTL helpers ───────────────────────────────────────────────────────────────
// PASETO requires exp as an ISO 8601 string, not a Unix timestamp.

function expiresAt(seconds) {
    return new Date(Date.now() + seconds * 1000).toISOString();
}

export const TOKEN_TTL = {
    ACCESS:  15 * 60,            // 15 minutes
    REFRESH: 30 * 24 * 60 * 60,  // 30 days
    VERIFY:  10 * 60,            // 10 minutes
};

// ── Token issuance ────────────────────────────────────────────────────────────

export async function issueAccessToken(userId, userClaims = {}) {
    const payload = {
        sub: userId.toString(),
        jti: crypto.randomBytes(16).toString("hex"),
        exp: expiresAt(TOKEN_TTL.ACCESS),
        typ: "access",
        role: userClaims.role || "user",
        isVerified: userClaims.isVerified ?? false,
    };
    return V4.sign(payload, accessKeys.privateKey);
}

export async function issueRefreshToken(userId) {
    const payload = {
        sub: userId.toString(),
        jti: crypto.randomBytes(16).toString("hex"),
        exp: expiresAt(TOKEN_TTL.REFRESH),
        typ: "refresh",
    };
    return V4.sign(payload, refreshKeys.privateKey);
}

export async function issueVerifyToken(userId) {
    const payload = {
        sub: userId.toString(),
        jti: crypto.randomBytes(16).toString("hex"),
        exp: expiresAt(TOKEN_TTL.VERIFY),
        typ: "verify",
    };
    return V4.sign(payload, verifyKeys.privateKey);
}

export async function issueTokenPair(userId, userClaims = {}) {
    const [accessToken, refreshToken] = await Promise.all([
        issueAccessToken(userId, userClaims),
        issueRefreshToken(userId),
    ]);
    return { accessToken, refreshToken };
}

// ── Token verification ────────────────────────────────────────────────────────

export async function verifyAccessToken(token) {
    return _verify(token, accessKeys.publicKey, "access");
}

export async function verifyRefreshToken(token) {
    return _verify(token, refreshKeys.publicKey, "refresh");
}

export async function verifyVerifyToken(token) {
    return _verify(token, verifyKeys.publicKey, "verify");
}

async function _verify(token, publicKey, expectedType) {
    if (!token || typeof token !== "string") {
        const err = new Error("Token is missing");
        err.code = "TOKEN_MISSING";
        err.statusCode = 401;
        throw err;
    }

    let payload;
    try {
        // V4.verify throws PasetoVerificationFailed on bad signature
        // and PasetoClaimInvalid on expired tokens (exp is checked by the library)
        payload = await V4.verify(token, publicKey);
    } catch (cause) {
        const isExpired = cause?.code === "ERR_PASETO_CLAIM_INVALID" &&
            cause?.message?.toLowerCase().includes("exp");

        if (isExpired) {
            const messages = {
                access:  "Access token has expired — use your refresh token to get a new one",
                refresh: "Refresh token has expired — please log in again",
                verify:  "Verification token has expired — please request a new one",
            };
            const err = new Error(messages[expectedType] || "Token has expired");
            err.code = "TOKEN_EXPIRED";
            err.statusCode = 401;
            throw err;
        }

        const err = new Error("Token is invalid or has been tampered with");
        err.code = "TOKEN_INVALID";
        err.statusCode = 401;
        err.cause = cause;
        throw err;
    }

    // Reject tokens issued for a different purpose
    if (payload.typ !== expectedType) {
        const err = new Error(`Wrong token type: expected "${expectedType}", got "${payload.typ}"`);
        err.code = "TOKEN_WRONG_TYPE";
        err.statusCode = 401;
        throw err;
    }

    return payload;
}

// ── Key generation (used by scripts/generate-keys.js) ────────────────────────
// V4.generateKey returns only the private key — derive public from it.
export async function generateKeyPairHex() {
    const privateKey = await V4.generateKey("public");
    const publicKey  = createPublicKey(privateKey);

    const privateBytes = V4.keyObjectToBytes(privateKey);
    const publicBytes  = V4.keyObjectToBytes(publicKey);

    return {
        privateHex: privateBytes.toString("hex"),
        publicHex:  publicBytes.toString("hex"),
    };
}
