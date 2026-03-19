// This service wraps several free public APIs that are useful for a payment system.
// All of them require no API key and are sourced from the public-apis repository:
// https://github.com/public-apis/public-apis
//
// APIs used:
//   1. open.er-api.com       — real-time currency exchange rates (Finance > Currency Exchange)
//   2. api.frankfurter.app   — historical exchange rates by date range (Finance > Currency Exchange)
//   3. restcountries.com     — country info: name, currency, flag, calling code (Geography)
//   4. api.vatcomply.com     — VAT rates by country + IP geolocation (Finance > Tax)
//   5. api.coingecko.com     — live cryptocurrency prices in USD (Finance > Cryptocurrency)
//   6. api.coincap.io        — real-time crypto prices, backup to CoinGecko (Finance > Cryptocurrency)
//   7. lookup.binlist.net    — card BIN/IIN lookup: issuer, country, card type (Finance > Payments)
//   8. api.zippopotam.us     — ZIP/postcode lookup for address validation (Geography)

import logger from "../utils/logger.js";

// How long to cache each type of data in Redis (seconds)
const CACHE_TTL = {
    exchangeRates:    60 * 60,       // 1 hour — rates don't change that fast
    historicalRates:  24 * 60 * 60,  // 24 hours — historical data never changes
    country:          24 * 60 * 60,  // 24 hours — country data is basically static
    vat:              24 * 60 * 60,  // 24 hours — VAT rates rarely change
    crypto:           5 * 60,        // 5 minutes — crypto prices move quickly
    bin:              7 * 24 * 60 * 60, // 7 days — card BIN data is very stable
    postcode:         30 * 24 * 60 * 60, // 30 days — postcode data almost never changes
};

// Timeout for all outbound HTTP calls — we never want to block a request for more than this
const REQUEST_TIMEOUT_MS = 5000;

class PublicApiService {
    constructor(redisClient) {
        this.redis = redisClient;
    }

    // ─── Internal helper ──────────────────────────────────────────────────────

    // Wraps fetch with a timeout and consistent error handling.
    // Returns parsed JSON or throws with a clean message.
    async _fetch(url, label) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        try {
            const res = await fetch(url, {
                headers: { "User-Agent": "SwiftPay/1.0" },
                signal:  controller.signal,
            });

            clearTimeout(timer);

            if (!res.ok) throw new Error(`${label} returned ${res.status}`);

            return await res.json();
        } catch (err) {
            clearTimeout(timer);
            if (err.name === "AbortError") {
                throw new Error(`${label} timed out`);
            }
            throw err;
        }
    }

    // ─── 1. Exchange Rates (open.er-api.com) ─────────────────────────────────
    // Free, no API key required.
    // Returns live rates for all supported currencies relative to the base.

    async getExchangeRates(baseCurrency = "USD") {
        const base = baseCurrency.toUpperCase();
        const cacheKey = `pubapi:rates:${base}`;

        // Try cache first — rates are cached for 1 hour
        const cached = await this.redis.get(cacheKey);
        if (cached) {
            return { ...JSON.parse(cached), cached: true };
        }

        try {
            const data = await this._fetch(
                `https://open.er-api.com/v6/latest/${base}`,
                "ExchangeRate API"
            );

            if (data.result !== "success") {
                throw new Error(data["error-type"] || "Exchange rate API error");
            }

            const result = {
                base:        data.base_code,
                rates:       data.rates,
                lastUpdated: data.time_last_update_utc,
                cached:      false,
            };

            await this.redis.setex(cacheKey, CACHE_TTL.exchangeRates, JSON.stringify(result));

            return result;
        } catch (error) {
            logger.error("Exchange rate fetch failed:", error.message);
            throw error;
        }
    }

    // Convert an amount from one currency to another using live rates
    async convertCurrency(amount, from, to) {
        const fromUpper = from.toUpperCase();
        const toUpper   = to.toUpperCase();

        if (fromUpper === toUpper) {
            return { amount, from: fromUpper, to: toUpper, converted: amount, rate: 1 };
        }

        const rates = await this.getExchangeRates(fromUpper);

        const rate = rates.rates[toUpper];
        if (!rate) {
            throw new Error(`No rate available for ${toUpper}`);
        }

        const converted = parseFloat((amount * rate).toFixed(2));

        return {
            amount,
            from:        fromUpper,
            to:          toUpper,
            converted,
            rate,
            lastUpdated: rates.lastUpdated,
            cached:      rates.cached,
        };
    }

    // ─── 2. Historical Exchange Rates (api.frankfurter.app) ──────────────────
    // Free, no API key required.
    // Useful for auditing past transactions at the rate that was active at the time.

    async getHistoricalRates(date, baseCurrency = "USD") {
        const base = baseCurrency.toUpperCase();

        // Validate date format — must be YYYY-MM-DD
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            throw new Error("Date must be in YYYY-MM-DD format");
        }

        const cacheKey = `pubapi:historical:${date}:${base}`;

        const cached = await this.redis.get(cacheKey);
        if (cached) {
            return { ...JSON.parse(cached), cached: true };
        }

        try {
            // Frankfurter is a free, open-source exchange rate API backed by ECB data
            const data = await this._fetch(
                `https://api.frankfurter.app/${date}?base=${base}`,
                "Frankfurter API"
            );

            const result = {
                date:   data.date,
                base:   data.base,
                rates:  data.rates,
                cached: false,
            };

            await this.redis.setex(cacheKey, CACHE_TTL.historicalRates, JSON.stringify(result));

            return result;
        } catch (error) {
            logger.error("Historical rates fetch failed:", { date, base, error: error.message });
            throw error;
        }
    }

    // Get exchange rates over a date range — useful for charts and trend analysis
    async getHistoricalRateRange(startDate, endDate, baseCurrency = "USD") {
        const base = baseCurrency.toUpperCase();

        if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
            throw new Error("Dates must be in YYYY-MM-DD format");
        }

        const cacheKey = `pubapi:historical:range:${startDate}:${endDate}:${base}`;

        const cached = await this.redis.get(cacheKey);
        if (cached) {
            return { ...JSON.parse(cached), cached: true };
        }

        try {
            const data = await this._fetch(
                `https://api.frankfurter.app/${startDate}..${endDate}?base=${base}`,
                "Frankfurter API"
            );

            const result = {
                startDate: data.start_date,
                endDate:   data.end_date,
                base:      data.base,
                rates:     data.rates,
                cached:    false,
            };

            await this.redis.setex(cacheKey, CACHE_TTL.historicalRates, JSON.stringify(result));

            return result;
        } catch (error) {
            logger.error("Historical rate range fetch failed:", error.message);
            throw error;
        }
    }

    // ─── 3. Country Info (restcountries.com) ──────────────────────────────────
    // Free, no API key required.
    // Useful for validating user country codes and enriching payout data.

    async getCountryInfo(countryCode) {
        const code = countryCode.toUpperCase();
        const cacheKey = `pubapi:country:${code}`;

        const cached = await this.redis.get(cacheKey);
        if (cached) {
            return { ...JSON.parse(cached), cached: true };
        }

        try {
            const data = await this._fetch(
                `https://restcountries.com/v3.1/alpha/${code}`,
                "RestCountries API"
            );

            // The API returns an array — we only need the first result
            const country = Array.isArray(data) ? data[0] : data;

            if (!country) throw new Error(`Country not found: ${code}`);

            // Pull out just what's useful for a payment system
            const currencies = country.currencies
                ? Object.entries(country.currencies).map(([currCode, curr]) => ({
                    code:   currCode,
                    name:   curr.name,
                    symbol: curr.symbol,
                }))
                : [];

            const result = {
                code,
                name:         country.name?.common || code,
                officialName: country.name?.official || code,
                region:       country.region,
                subregion:    country.subregion,
                capital:      country.capital?.[0] || null,
                currencies,
                callingCode:  country.idd?.root
                    ? `${country.idd.root}${(country.idd.suffixes || [])[0] || ""}`
                    : null,
                flag:         country.flag || null,
                flagUrl:      country.flags?.png || null,
                population:   country.population || null,
            };

            await this.redis.setex(cacheKey, CACHE_TTL.country, JSON.stringify(result));

            return { ...result, cached: false };
        } catch (error) {
            logger.error("Country info fetch failed:", { countryCode: code, error: error.message });
            throw error;
        }
    }

    // Get a list of countries — useful for populating dropdowns in the frontend
    async getSupportedCountries() {
        const cacheKey = "pubapi:countries:list";

        const cached = await this.redis.get(cacheKey);
        if (cached) {
            return { countries: JSON.parse(cached), cached: true };
        }

        try {
            // Only fetch the fields we actually need — keeps the response small
            const data = await this._fetch(
                "https://restcountries.com/v3.1/all?fields=name,cca2,flag,currencies,region",
                "RestCountries API"
            );

            const countries = data
                .map((c) => ({
                    code:       c.cca2,
                    name:       c.name?.common,
                    flag:       c.flag,
                    region:     c.region,
                    currencies: c.currencies ? Object.keys(c.currencies) : [],
                }))
                .sort((a, b) => a.name?.localeCompare(b.name));

            await this.redis.setex(cacheKey, CACHE_TTL.country, JSON.stringify(countries));

            return { countries, cached: false };
        } catch (error) {
            logger.error("Countries list fetch failed:", error.message);
            throw error;
        }
    }

    // ─── 4. VAT Rates (api.vatcomply.com) ────────────────────────────────────
    // Free, no API key required.
    // Returns VAT rates for EU countries — useful for calculating tax on payouts.

    async getVatRates(countryCode = null) {
        // If a country code is given, fetch just that country's rates
        if (countryCode) {
            const code = countryCode.toUpperCase();
            const cacheKey = `pubapi:vat:${code}`;

            const cached = await this.redis.get(cacheKey);
            if (cached) {
                return { ...JSON.parse(cached), cached: true };
            }

            try {
                const data = await this._fetch(
                    `https://api.vatcomply.com/rates?country_code=${code}`,
                    "VATComply API"
                );

                const result = {
                    countryCode: code,
                    rates:       data.rates,
                    cached:      false,
                };

                await this.redis.setex(cacheKey, CACHE_TTL.vat, JSON.stringify(result));

                return result;
            } catch (error) {
                logger.error("VAT rate fetch failed:", { countryCode: code, error: error.message });
                throw error;
            }
        }

        // No country code — return all EU VAT rates
        const cacheKey = "pubapi:vat:all";

        const cached = await this.redis.get(cacheKey);
        if (cached) {
            return { rates: JSON.parse(cached), cached: true };
        }

        try {
            const data = await this._fetch(
                "https://api.vatcomply.com/rates",
                "VATComply API"
            );

            await this.redis.setex(cacheKey, CACHE_TTL.vat, JSON.stringify(data.rates));

            return { rates: data.rates, cached: false };
        } catch (error) {
            logger.error("VAT rates fetch failed:", error.message);
            throw error;
        }
    }

    // ─── 5. Crypto Prices (CoinGecko) ─────────────────────────────────────────
    // Free public API, no key required for basic endpoints.
    // Useful for showing crypto equivalent of payout amounts.

    async getCryptoPrices(coins = ["bitcoin", "ethereum", "tether", "usd-coin"]) {
        const cacheKey = `pubapi:crypto:${coins.sort().join(",")}`;

        const cached = await this.redis.get(cacheKey);
        if (cached) {
            return { ...JSON.parse(cached), cached: true };
        }

        try {
            const ids = coins.join(",");

            // CoinGecko free tier — no API key needed for this endpoint
            const data = await this._fetch(
                `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`,
                "CoinGecko API"
            );

            const prices = Object.entries(data).map(([id, info]) => ({
                id,
                priceUSD:  info.usd,
                change24h: info.usd_24h_change
                    ? parseFloat(info.usd_24h_change.toFixed(2))
                    : null,
                source:    "coingecko",
            }));

            const result = {
                prices,
                fetchedAt: new Date().toISOString(),
                cached:    false,
            };

            // Cache for 5 minutes — crypto prices move fast
            await this.redis.setex(cacheKey, CACHE_TTL.crypto, JSON.stringify(result));

            return result;
        } catch (error) {
            logger.error("CoinGecko prices fetch failed:", error.message);

            // If CoinGecko fails, fall back to CoinCap
            logger.info("Falling back to CoinCap for crypto prices");
            return this.getCryptoPricesFromCoinCap(coins);
        }
    }

    // Convert a fiat amount to its crypto equivalent
    async convertToCrypto(amountUSD, coinId = "bitcoin") {
        const prices = await this.getCryptoPrices([coinId]);
        const coin = prices.prices.find((p) => p.id === coinId);

        if (!coin) throw new Error(`Coin not found: ${coinId}`);

        const cryptoAmount = parseFloat((amountUSD / coin.priceUSD).toFixed(8));

        return {
            amountUSD,
            coinId,
            priceUSD:    coin.priceUSD,
            cryptoAmount,
            change24h:   coin.change24h,
            fetchedAt:   prices.fetchedAt,
            cached:      prices.cached,
            source:      coin.source || "coingecko",
        };
    }

    // ─── 6. Crypto Prices Backup (CoinCap) ────────────────────────────────────
    // Free, no API key required.
    // Used as a fallback when CoinGecko is unavailable or rate-limited.
    // CoinCap uses different coin IDs (e.g. "bitcoin", "ethereum" — same as CoinGecko for major coins).

    async getCryptoPricesFromCoinCap(coins = ["bitcoin", "ethereum"]) {
        const cacheKey = `pubapi:coincap:${coins.sort().join(",")}`;

        const cached = await this.redis.get(cacheKey);
        if (cached) {
            return { ...JSON.parse(cached), cached: true };
        }

        try {
            // CoinCap returns all assets — we filter to the ones we want
            const data = await this._fetch(
                `https://api.coincap.io/v2/assets?ids=${coins.join(",")}`,
                "CoinCap API"
            );

            if (!data.data || !Array.isArray(data.data)) {
                throw new Error("CoinCap returned unexpected data format");
            }

            const prices = data.data.map((asset) => ({
                id:        asset.id,
                priceUSD:  parseFloat(parseFloat(asset.priceUsd).toFixed(2)),
                change24h: asset.changePercent24Hr
                    ? parseFloat(parseFloat(asset.changePercent24Hr).toFixed(2))
                    : null,
                rank:      parseInt(asset.rank, 10),
                source:    "coincap",
            }));

            const result = {
                prices,
                fetchedAt: new Date().toISOString(),
                cached:    false,
            };

            await this.redis.setex(cacheKey, CACHE_TTL.crypto, JSON.stringify(result));

            return result;
        } catch (error) {
            logger.error("CoinCap prices fetch failed:", error.message);
            throw error;
        }
    }

    // ─── 7. Card BIN Lookup (lookup.binlist.net) ──────────────────────────────
    // Free, no API key required.
    // Given the first 6-8 digits of a card number (the BIN/IIN), returns:
    //   - Card scheme (Visa, Mastercard, Amex, etc.)
    //   - Card type (debit or credit)
    //   - Issuing bank name and country
    // This is very useful for payment systems to validate cards before processing.

    async lookupCardBin(bin) {
        // BIN is the first 6-8 digits of a card number — strip spaces/dashes
        const cleanBin = String(bin).replace(/\D/g, "").slice(0, 8);

        if (cleanBin.length < 6) {
            throw new Error("BIN must be at least 6 digits");
        }

        const cacheKey = `pubapi:bin:${cleanBin}`;

        const cached = await this.redis.get(cacheKey);
        if (cached) {
            return { ...JSON.parse(cached), cached: true };
        }

        try {
            // binlist.net — free BIN lookup, no auth required
            // Note: they ask for Accept: application/json header
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

            const res = await fetch(`https://lookup.binlist.net/${cleanBin}`, {
                headers: {
                    "User-Agent":  "SwiftPay/1.0",
                    "Accept-Version": "3",
                },
                signal: controller.signal,
            });

            clearTimeout(timer);

            // 404 means the BIN wasn't found in their database
            if (res.status === 404) {
                throw new Error(`BIN ${cleanBin} not found`);
            }

            if (!res.ok) {
                throw new Error(`BIN lookup returned ${res.status}`);
            }

            const data = await res.json();

            const result = {
                bin:     cleanBin,
                scheme:  data.scheme || null,       // visa, mastercard, amex, etc.
                type:    data.type || null,          // debit or credit
                brand:   data.brand || null,         // Visa, Mastercard, etc.
                prepaid: data.prepaid ?? null,       // true if it's a prepaid card
                bank: {
                    name:  data.bank?.name || null,
                    city:  data.bank?.city || null,
                    url:   data.bank?.url || null,
                    phone: data.bank?.phone || null,
                },
                country: {
                    code:     data.country?.alpha2 || null,
                    name:     data.country?.name || null,
                    currency: data.country?.currency || null,
                    emoji:    data.country?.emoji || null,
                },
                cached: false,
            };

            // BIN data is very stable — cache for 7 days
            await this.redis.setex(cacheKey, CACHE_TTL.bin, JSON.stringify(result));

            return result;
        } catch (error) {
            logger.error("BIN lookup failed:", { bin: cleanBin, error: error.message });
            throw error;
        }
    }

    // ─── 8. ZIP / Postcode Lookup (api.zippopotam.us) ─────────────────────────
    // Free, no API key required.
    // Validates a ZIP or postcode and returns the city/state/country it belongs to.
    // Useful for address validation during user onboarding or payout destination checks.

    async lookupPostcode(countryCode, postcode) {
        const country = countryCode.toUpperCase();

        // Clean the postcode — remove spaces and convert to uppercase
        const clean = postcode.replace(/\s+/g, "").toUpperCase();

        const cacheKey = `pubapi:postcode:${country}:${clean}`;

        const cached = await this.redis.get(cacheKey);
        if (cached) {
            return { ...JSON.parse(cached), cached: true };
        }

        try {
            // Zippopotam supports most countries — US, GB, CA, AU, DE, FR, etc.
            const data = await this._fetch(
                `https://api.zippopotam.us/${country}/${clean}`,
                "Zippopotam API"
            );

            const result = {
                postcode:    data["post code"],
                country:     data.country,
                countryCode: data["country abbreviation"],
                places:      (data.places || []).map((p) => ({
                    name:      p["place name"],
                    state:     p.state,
                    stateCode: p["state abbreviation"],
                    latitude:  p.latitude ? parseFloat(p.latitude) : null,
                    longitude: p.longitude ? parseFloat(p.longitude) : null,
                })),
                cached: false,
            };

            // Postcode data almost never changes — cache for 30 days
            await this.redis.setex(cacheKey, CACHE_TTL.postcode, JSON.stringify(result));

            return result;
        } catch (error) {
            logger.error("Postcode lookup failed:", { country, postcode: clean, error: error.message });
            throw error;
        }
    }
}

export default PublicApiService;
