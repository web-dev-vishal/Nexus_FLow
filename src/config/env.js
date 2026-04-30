// Validates all required and optional environment variables at startup.
// If a required variable is missing, envalid prints a clear error and exits.

import { cleanEnv, str, num, url } from "envalid";

const env = cleanEnv(process.env, {
    // ─── Required ─────────────────────────────────────────────────────────────
    MONGO_URI:              url(),
    REDIS_URL:              url(),
    RABBITMQ_URL:           url(),
    PASETO_ACCESS_PRIVATE:  str(),
    PASETO_ACCESS_PUBLIC:   str(),
    PASETO_REFRESH_PRIVATE: str(),
    PASETO_REFRESH_PUBLIC:  str(),

    // ─── Optional with defaults ───────────────────────────────────────────────
    PORT:                   num({ default: 5000 }),
    NODE_ENV:               str({ default: "development" }),
    MONGO_MAX_POOL_SIZE:    num({ default: 10 }),
    MONGO_MIN_POOL_SIZE:    num({ default: 2 }),
    FRAUD_RISK_THRESHOLD:   num({ default: 70 }),
    RABBITMQ_POOL_MIN:      num({ default: 2 }),
    RABBITMQ_POOL_MAX:      num({ default: 10 }),
});

export default env;
