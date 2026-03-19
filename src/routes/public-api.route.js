// Public API routes — proxy endpoints for free public APIs.
// No authentication required — these are informational endpoints.
// All responses are cached in Redis to avoid hammering external rate limits.
//
// APIs covered:
//   - Exchange rates (live + historical)
//   - Country information
//   - EU VAT rates
//   - Cryptocurrency prices
//   - Card BIN lookup
//   - ZIP/postcode lookup

import express from "express";

const createPublicApiRouter = (publicApiController) => {
    const router = express.Router();

    // ── Currency exchange rates ──────────────────────────────────────────────
    // GET /api/public/rates?base=USD
    router.get("/rates",                        publicApiController.getExchangeRates);

    // GET /api/public/convert?amount=100&from=USD&to=EUR
    router.get("/convert",                      publicApiController.convertCurrency);

    // GET /api/public/rates/historical?date=2024-01-15&base=USD
    router.get("/rates/historical",             publicApiController.getHistoricalRates);

    // GET /api/public/rates/historical/range?start=2024-01-01&end=2024-01-31&base=USD
    router.get("/rates/historical/range",       publicApiController.getHistoricalRateRange);

    // ── Country information ──────────────────────────────────────────────────
    // GET /api/public/countries
    router.get("/countries",                    publicApiController.getSupportedCountries);

    // GET /api/public/country/US
    router.get("/country/:code",                publicApiController.getCountryInfo);

    // ── VAT rates ────────────────────────────────────────────────────────────
    // GET /api/public/vat?country=DE
    router.get("/vat",                          publicApiController.getVatRates);

    // ── Cryptocurrency prices ────────────────────────────────────────────────
    // GET /api/public/crypto?coins=bitcoin,ethereum
    router.get("/crypto",                       publicApiController.getCryptoPrices);

    // GET /api/public/crypto/convert?amount=500&coin=bitcoin
    router.get("/crypto/convert",               publicApiController.convertToCrypto);

    // ── Card BIN lookup ──────────────────────────────────────────────────────
    // GET /api/public/bin/411111
    router.get("/bin/:bin",                     publicApiController.lookupCardBin);

    // ── Postcode / ZIP lookup ────────────────────────────────────────────────
    // GET /api/public/postcode/US/90210
    router.get("/postcode/:country/:postcode",  publicApiController.lookupPostcode);

    return router;
};

export default createPublicApiRouter;
