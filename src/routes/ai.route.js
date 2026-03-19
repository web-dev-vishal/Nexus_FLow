// AI/utility routes — endpoints for currency validation, IP lookup, and API usage stats.
// These are informational endpoints — they don't modify any data.

import express from "express";

const createAIRouter = (aiController) => {
    const router = express.Router();

    // GET /api/ai/usage — today's API call counts for external services
    router.get("/usage",             aiController.getAPIUsage);

    // GET /api/ai/currencies — list of supported currency codes
    router.get("/currencies",        aiController.getSupportedCurrencies);

    // GET /api/ai/validate/currency?currency=EUR&amount=100
    router.get("/validate/currency", aiController.validateCurrency);

    // GET /api/ai/validate/ip?ip=1.2.3.4
    router.get("/validate/ip",       aiController.validateIP);

    return router;
};

export default createAIRouter;
