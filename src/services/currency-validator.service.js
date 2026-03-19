// Currency Validator — checks that a currency code is valid and gets its exchange rate.
// Exchange rates are cached in Redis for 1 hour to avoid burning through the free API limit.
// If the API is unavailable, we fall back to hardcoded rates so payouts still work.

import logger from "../utils/logger.js";

// Cache exchange rates for 1 hour — rates don't change that fast
const CACHE_TTL = 60 * 60;

// Hardcoded fallback rates relative to USD.
// These are used when the exchange rate API is down or the API key is missing.
// They're not perfectly accurate but good enough to keep the system running.
const FALLBACK_RATES = {
    USD: 1.0,   EUR: 0.92,  GBP: 0.79,  INR: 83.12, CAD: 1.36,
    AUD: 1.52,  JPY: 149.5, CHF: 0.88,  CNY: 7.24,  MXN: 17.08,
    BRL: 4.97,  ZAR: 18.65, SGD: 1.34,  HKD: 7.82,  NZD: 1.64,
    SEK: 10.52, NOK: 10.68, DKK: 6.86,  PLN: 3.98,  THB: 34.25,
};

class CurrencyValidator {
    constructor(redisClient) {
        this.redis = redisClient;

        // Optional API key for live exchange rates — falls back to hardcoded rates if missing
        this.apiKey = process.env.EXCHANGE_RATE_API_KEY;

        // Currency validation can be turned off via env var
        this.enabled = process.env.ENABLE_CURRENCY_VALIDATION === "true";
    }

    // Check if a currency code is valid and return its exchange rate vs USD.
    // Returns { valid: true, exchangeRate, amountInUSD } on success.
    // Returns { valid: false, error, message } if the currency isn't supported.
    async validateCurrency(currency, amount) {
        // If validation is disabled, skip the check entirely
        if (!this.enabled) {
            return { valid: true, exchangeRate: null, amountInUSD: null, cached: false };
        }

        if (!currency) {
            return { valid: false, error: "MISSING_CURRENCY", message: "Currency code is required" };
        }

        try {
            const cacheKey = `cache:currency:${currency}`;

            // Check Redis cache first — saves an API call if we've seen this currency recently
            const cached = await this.redis.get(cacheKey);

            if (cached) {
                const data = JSON.parse(cached);
                return {
                    valid:        true,
                    exchangeRate: data.rate,
                    // Calculate how much this amount is worth in USD
                    amountInUSD:  amount ? parseFloat((amount / data.rate).toFixed(2)) : null,
                    cached:       true,
                    lastUpdated:  data.lastUpdated,
                };
            }

            // No API key — use fallback rates instead of making an API call
            if (!this.apiKey) {
                logger.warn("Exchange rate API key not set — using fallback rates");
                return this._fallback(currency, amount);
            }

            // Abort the request if it takes more than 1.5 seconds
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 1500);

            const response = await fetch(
                `https://v6.exchangerate-api.com/v6/${this.apiKey}/latest/USD`,
                { signal: controller.signal }
            );

            clearTimeout(timeout);

            if (!response.ok) throw new Error(`Exchange rate API error: ${response.status}`);

            const data = await response.json();
            if (data.result !== "success") throw new Error(data["error-type"] || "API error");

            // Check if the requested currency is in the API's response
            if (!data.conversion_rates[currency]) {
                return {
                    valid:   false,
                    error:   "INVALID_CURRENCY",
                    message: `Currency ${currency} is not supported`,
                };
            }

            const rate = data.conversion_rates[currency];

            // Cache the rate so we don't hit the API again for the next hour
            await this.redis.setex(
                cacheKey,
                CACHE_TTL,
                JSON.stringify({ rate, lastUpdated: new Date().toISOString() })
            );

            return {
                valid:        true,
                exchangeRate: rate,
                amountInUSD:  amount ? parseFloat((amount / rate).toFixed(2)) : null,
                cached:       false,
                lastUpdated:  new Date().toISOString(),
            };
        } catch (error) {
            if (error.name === "AbortError") {
                logger.warn("Currency validation timed out", { currency });
            } else {
                logger.error("Currency validation failed", { currency, error: error.message });
            }

            // Fall back to hardcoded rates so the payout can still proceed
            return this._fallback(currency, amount);
        }
    }

    // Use hardcoded rates when the API is unavailable.
    // If the currency isn't in our fallback list, we return an error.
    _fallback(currency, amount) {
        const rate = FALLBACK_RATES[currency];

        if (!rate) {
            return {
                valid:   false,
                error:   "CURRENCY_SERVICE_UNAVAILABLE",
                message: "Currency service unavailable and no fallback rate available",
            };
        }

        return {
            valid:        true,
            exchangeRate: rate,
            amountInUSD:  amount ? parseFloat((amount / rate).toFixed(2)) : null,
            cached:       false,
            fallback:     true,  // Let the caller know these are approximate rates
            lastUpdated:  "fallback",
        };
    }

    // Returns the full list of supported currency codes.
    // Used by the /api/ai/currencies endpoint.
    getSupportedCurrencies() {
        const currencies = [
            "USD", "EUR", "GBP", "INR", "CAD", "AUD", "JPY", "CHF", "CNY", "MXN",
            "BRL", "ZAR", "SGD", "HKD", "NZD", "SEK", "NOK", "DKK", "PLN", "THB",
            "KRW", "RUB", "TRY", "IDR", "MYR", "PHP", "VND", "AED", "SAR", "EGP",
        ];
        return { success: true, currencies, count: currencies.length };
    }
}

export default CurrencyValidator;
