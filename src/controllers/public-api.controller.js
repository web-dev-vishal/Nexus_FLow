// Handles all public API endpoints — exchange rates, country info, VAT, crypto, BIN lookup, postcodes.
// All data comes from free public APIs (no API keys required).
// Results are cached in Redis to avoid hammering rate limits.

class PublicApiController {
    constructor(publicApiService) {
        this.service = publicApiService;
    }

    // GET /api/public/rates?base=USD
    getExchangeRates = async (req, res, next) => {
        try {
            const base = req.query.base || "USD";
            const result = await this.service.getExchangeRates(base);
            res.status(200).json({ success: true, ...result });
        } catch (error) {
            next(error);
        }
    };

    // GET /api/public/convert?amount=100&from=USD&to=EUR
    convertCurrency = async (req, res, next) => {
        try {
            const { amount, from, to } = req.query;

            if (!amount || !from || !to) {
                return res.status(400).json({ success: false, error: "amount, from, and to are required", code: "MISSING_PARAMS" });
            }

            const parsed = parseFloat(amount);
            if (isNaN(parsed) || parsed <= 0) {
                return res.status(400).json({ success: false, error: "amount must be a positive number", code: "INVALID_AMOUNT" });
            }

            const result = await this.service.convertCurrency(parsed, from, to);
            res.status(200).json({ success: true, ...result });
        } catch (error) {
            next(error);
        }
    };

    // GET /api/public/rates/historical?date=2024-01-15&base=USD
    // Returns exchange rates for a specific past date — useful for transaction auditing
    getHistoricalRates = async (req, res, next) => {
        try {
            const { date, base } = req.query;

            if (!date) {
                return res.status(400).json({ success: false, error: "date is required (format: YYYY-MM-DD)", code: "MISSING_DATE" });
            }

            const result = await this.service.getHistoricalRates(date, base || "USD");
            res.status(200).json({ success: true, ...result });
        } catch (error) {
            if (error.message?.includes("YYYY-MM-DD")) {
                return res.status(400).json({ success: false, error: error.message, code: "INVALID_DATE_FORMAT" });
            }
            next(error);
        }
    };

    // GET /api/public/rates/historical/range?start=2024-01-01&end=2024-01-31&base=USD
    // Returns exchange rates over a date range — useful for charts and trend analysis
    getHistoricalRateRange = async (req, res, next) => {
        try {
            const { start, end, base } = req.query;

            if (!start || !end) {
                return res.status(400).json({ success: false, error: "start and end dates are required (format: YYYY-MM-DD)", code: "MISSING_DATES" });
            }

            const startMs = new Date(start).getTime();
            const endMs   = new Date(end).getTime();

            if (isNaN(startMs) || isNaN(endMs)) {
                return res.status(400).json({ success: false, error: "Invalid date format — use YYYY-MM-DD", code: "INVALID_DATE_FORMAT" });
            }

            if (endMs < startMs) {
                return res.status(400).json({ success: false, error: "end date must be after start date", code: "INVALID_DATE_RANGE" });
            }

            // Don't allow ranges longer than 1 year to avoid huge responses
            const diffDays = (endMs - startMs) / (1000 * 60 * 60 * 24);
            if (diffDays > 365) {
                return res.status(400).json({ success: false, error: "Date range cannot exceed 365 days", code: "DATE_RANGE_TOO_LARGE" });
            }

            const result = await this.service.getHistoricalRateRange(start, end, base || "USD");
            res.status(200).json({ success: true, ...result });
        } catch (error) {
            next(error);
        }
    };

    // GET /api/public/countries
    getSupportedCountries = async (req, res, next) => {
        try {
            const result = await this.service.getSupportedCountries();
            res.status(200).json({ success: true, count: result.countries.length, cached: result.cached, countries: result.countries });
        } catch (error) {
            next(error);
        }
    };

    // GET /api/public/country/:code
    getCountryInfo = async (req, res, next) => {
        try {
            const { code } = req.params;

            if (!code || code.length !== 2) {
                return res.status(400).json({ success: false, error: "A valid 2-letter country code is required (e.g. US, GB, IN)", code: "INVALID_COUNTRY_CODE" });
            }

            const result = await this.service.getCountryInfo(code);
            res.status(200).json({ success: true, country: result });
        } catch (error) {
            if (error.message?.includes("not found")) {
                return res.status(404).json({ success: false, error: `Country code '${req.params.code}' not found`, code: "COUNTRY_NOT_FOUND" });
            }
            next(error);
        }
    };

    // GET /api/public/vat?country=DE
    // Returns VAT rates for a specific EU country, or all EU countries if no country given
    getVatRates = async (req, res, next) => {
        try {
            const { country } = req.query;
            const result = await this.service.getVatRates(country || null);
            res.status(200).json({ success: true, ...result });
        } catch (error) {
            next(error);
        }
    };

    // GET /api/public/crypto?coins=bitcoin,ethereum
    getCryptoPrices = async (req, res, next) => {
        try {
            const coins = req.query.coins
                ? req.query.coins.split(",").map((c) => c.trim().toLowerCase())
                : ["bitcoin", "ethereum", "tether", "usd-coin"];

            if (coins.length > 10) {
                return res.status(400).json({ success: false, error: "Maximum 10 coins per request", code: "TOO_MANY_COINS" });
            }

            const result = await this.service.getCryptoPrices(coins);
            res.status(200).json({ success: true, ...result });
        } catch (error) {
            next(error);
        }
    };

    // GET /api/public/crypto/convert?amount=500&coin=bitcoin
    convertToCrypto = async (req, res, next) => {
        try {
            const { amount, coin } = req.query;

            if (!amount) {
                return res.status(400).json({ success: false, error: "amount (in USD) is required", code: "MISSING_AMOUNT" });
            }

            const parsed = parseFloat(amount);
            if (isNaN(parsed) || parsed <= 0) {
                return res.status(400).json({ success: false, error: "amount must be a positive number", code: "INVALID_AMOUNT" });
            }

            const result = await this.service.convertToCrypto(parsed, coin || "bitcoin");
            res.status(200).json({ success: true, ...result });
        } catch (error) {
            if (error.message?.includes("not found")) {
                return res.status(404).json({ success: false, error: error.message, code: "COIN_NOT_FOUND" });
            }
            next(error);
        }
    };

    // GET /api/public/bin/:bin
    // Looks up a card BIN (first 6-8 digits) to identify the issuer, card type, and country.
    // Very useful for validating cards before initiating a payout.
    lookupCardBin = async (req, res, next) => {
        try {
            const { bin } = req.params;
            const cleanBin = String(bin).replace(/\D/g, "");

            if (cleanBin.length < 6) {
                return res.status(400).json({ success: false, error: "BIN must be at least 6 digits", code: "INVALID_BIN" });
            }

            const result = await this.service.lookupCardBin(cleanBin);
            res.status(200).json({ success: true, ...result });
        } catch (error) {
            if (error.message?.includes("not found")) {
                return res.status(404).json({ success: false, error: error.message, code: "BIN_NOT_FOUND" });
            }
            next(error);
        }
    };

    // GET /api/public/postcode/:country/:postcode
    // Validates a postcode and returns the city/state it belongs to.
    lookupPostcode = async (req, res, next) => {
        try {
            const { country, postcode } = req.params;

            if (!country || country.length !== 2) {
                return res.status(400).json({ success: false, error: "A valid 2-letter country code is required (e.g. US, GB, DE)", code: "INVALID_COUNTRY_CODE" });
            }

            if (!postcode) {
                return res.status(400).json({ success: false, error: "postcode is required", code: "MISSING_POSTCODE" });
            }

            const result = await this.service.lookupPostcode(country, postcode);
            res.status(200).json({ success: true, ...result });
        } catch (error) {
            // Zippopotam returns 404 for unknown postcodes
            if (error.message?.includes("404")) {
                return res.status(404).json({ success: false, error: `Postcode '${req.params.postcode}' not found in ${req.params.country}`, code: "POSTCODE_NOT_FOUND" });
            }
            next(error);
        }
    };
}

export default PublicApiController;
