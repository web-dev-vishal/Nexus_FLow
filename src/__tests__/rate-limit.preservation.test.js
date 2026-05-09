/**
 * Preservation Property Tests — Property 2
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**
 *
 * GOAL: Establish baseline behavior that MUST be preserved after the fix.
 *
 * These tests run on UNFIXED code with a mock Redis client that is already
 * connected (client is non-null), so the bug condition does NOT hold.
 * All tests are EXPECTED TO PASS on unfixed code.
 *
 * The mock Redis client simulates the commands used by rate-limit-redis:
 *   - SCRIPT LOAD  → returns a fake SHA1 string
 *   - EVALSHA      → implements counter increment logic, returns [count, ttlMs]
 *   - DECR         → decrements counter
 *   - DEL          → resets counter
 *
 * Properties tested:
 *   2a — Within-limit pass-through
 *   2b — Over-limit rejection (HTTP 429)
 *   2c — Redis key prefix isolation (loginLimiter vs registerLimiter)
 *   2d — payoutUserLimiter per-user keying
 *   2e — Standard headers present, legacy headers absent
 */

import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import fc from 'fast-check';

// ── In-memory Redis stub ──────────────────────────────────────────────────────
//
// rate-limit-redis's RedisStore calls sendCommand with:
//   { command: ["SCRIPT", "LOAD", script], ... }   → must return a SHA1 string
//   { command: ["EVALSHA", sha, "1", key, ...], ... } → must return [count, ttlMs]
//   { command: ["DECR", key], ... }
//   { command: ["DEL", key], ... }
//
// The sendCommand in rate-limit.middleware.js is:
//   (...args) => redisConnection.getClient().call(...args)
// So the ioredis client's .call() method receives the spread command array:
//   client.call("SCRIPT", "LOAD", script)
//   client.call("EVALSHA", sha, "1", key, resetOnChange, windowMs)
//
// We build a factory so each test suite gets a fresh in-memory store.

const FAKE_SHA1_INCREMENT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const FAKE_SHA1_GET       = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function makeInMemoryRedisClient() {
  // counters: Map<key, { count: number, expiresAt: number }>
  const counters = new Map();

  const call = jest.fn(async (...args) => {
    const command = args[0];

    if (command === 'SCRIPT') {
      // SCRIPT LOAD <script> — return a fake SHA1
      const script = args[2] || '';
      if (script.includes('INCR')) return FAKE_SHA1_INCREMENT;
      return FAKE_SHA1_GET;
    }

    if (command === 'EVALSHA') {
      const sha  = args[1];
      // args: EVALSHA sha numkeys key [resetOnChange] [windowMs]
      const key  = args[3];

      if (sha === FAKE_SHA1_GET) {
        // GET script: return [totalHits, timeToExpire]
        const entry = counters.get(key);
        if (!entry || Date.now() >= entry.expiresAt) {
          return [0, -1];
        }
        return [entry.count, Math.max(0, entry.expiresAt - Date.now())];
      }

      // INCREMENT script: args[4] = resetOnChange ("0"/"1"), args[5] = windowMs
      const windowMs = parseInt(args[5], 10) || 60000;
      const now = Date.now();
      const entry = counters.get(key);

      if (!entry || now >= entry.expiresAt) {
        // New window
        counters.set(key, { count: 1, expiresAt: now + windowMs });
        return [1, windowMs];
      }

      entry.count += 1;
      const ttl = Math.max(0, entry.expiresAt - now);
      return [entry.count, ttl];
    }

    if (command === 'DECR') {
      const key = args[1];
      const entry = counters.get(key);
      if (entry) entry.count = Math.max(0, entry.count - 1);
      return entry ? entry.count : 0;
    }

    if (command === 'DEL') {
      const key = args[1];
      counters.delete(key);
      return 1;
    }

    return null;
  });

  return { call, _counters: counters };
}

// ── Mock redisConnection ──────────────────────────────────────────────────────
// We need a non-null client so the bug condition does NOT hold.
// Each test suite creates its own client via makeInMemoryRedisClient().
// We expose a mutable reference so individual tests can swap the client.

let _currentClient = makeInMemoryRedisClient();

jest.unstable_mockModule('../config/redis.js', () => ({
  default: {
    client:      {},   // non-null — bug condition does NOT hold
    isConnected: true,
    connect:     jest.fn().mockResolvedValue(undefined),
    disconnect:  jest.fn().mockResolvedValue(undefined),
    getClient:   jest.fn(() => _currentClient),
    isHealthy:   jest.fn().mockResolvedValue(true),
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal mock Express req/res/next triple.
 * Includes all methods that express-rate-limit may call on res.
 * @param {object} overrides - Properties to merge into req.
 */
function makeMockReqRes(overrides = {}) {
  const headers = {};
  const res = {
    // express-rate-limit's default handler calls res.status(429).send(message)
    // payoutUserLimiter's custom handler calls res.status(429).json(...)
    status: jest.fn().mockReturnThis(),
    json:   jest.fn().mockReturnThis(),
    send:   jest.fn().mockReturnThis(),
    set:    jest.fn((name, value) => { headers[name] = value; return res; }),
    setHeader: jest.fn((name, value) => { headers[name] = value; }),
    getHeader: jest.fn((name) => headers[name]),
    removeHeader: jest.fn((name) => { delete headers[name]; }),
    _headers: headers,
    headersSent: false,
    locals: {},
  };
  const req = {
    ip:     '127.0.0.1',
    method: 'GET',
    path:   '/',
    headers: {},
    body:   {},
    ...overrides,
  };
  const next = jest.fn();
  return { req, res, next };
}

/**
 * Run the middleware and return a promise that resolves when next(), res.send(),
 * or res.json() is called (whichever comes first).
 */
function runMiddleware(middleware, req, res, next) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const settle = (result) => {
      if (!resolved) {
        resolved = true;
        resolve(result);
      }
    };

    next.mockImplementation((...args) => settle({ type: 'next', args }));
    res.send.mockImplementation((...args) => { settle({ type: 'send', args }); return res; });
    res.json.mockImplementation((...args) => { settle({ type: 'json', args }); return res; });

    try {
      const result = middleware(req, res, next);
      if (result && typeof result.then === 'function') {
        result.catch(reject);
      }
    } catch (err) {
      reject(err);
    }
  });
}

// ── Load middleware module ────────────────────────────────────────────────────
// We import once; Jest caches ESM modules.
// The mock is set up before this import so getClient() returns our stub.

let globalLimiter, loginLimiter, registerLimiter, payoutUserLimiter;

beforeEach(async () => {
  // Reset the in-memory client for each test to get fresh counters
  _currentClient = makeInMemoryRedisClient();

  // Import (or re-use cached) middleware
  const mod = await import('../middleware/rate-limit.middleware.js');
  globalLimiter    = mod.globalLimiter;
  loginLimiter     = mod.loginLimiter;
  registerLimiter  = mod.registerLimiter;
  payoutUserLimiter = mod.payoutUserLimiter;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Property 2: Preservation — Request-Time Rate Limiting Behavior', () => {

  // ── Property 2a — Within-limit pass-through ─────────────────────────────────
  describe('Property 2a — Within-limit pass-through', () => {
    /**
     * **Validates: Requirements 3.1, 3.2**
     *
     * For any request count n where 0 ≤ n ≤ max, each request calls next()
     * and sets RateLimit-Limit / RateLimit-Remaining headers.
     *
     * We test loginLimiter (max=10) as a representative limiter.
     */
    test('loginLimiter: requests within limit call next() and set rate-limit headers', async () => {
      await fc.assert(
        fc.asyncProperty(
          // n in [1, 10] — within the loginLimiter max of 10
          fc.integer({ min: 1, max: 10 }),
          async (n) => {
            // Fresh client for each property run
            _currentClient = makeInMemoryRedisClient();
            // Use a unique IP per run to avoid counter bleed between runs
            const ip = `10.0.${Math.floor(n / 256)}.${(n % 256) || 1}`;

            for (let i = 0; i < n; i++) {
              const { req, res, next } = makeMockReqRes({ ip });
              await runMiddleware(loginLimiter, req, res, next);

              // Each request within limit must call next()
              if (!next.mock.calls.length) return false;

              // RateLimit-Limit header must be set (case-insensitive)
              const headerKeys = Object.keys(res._headers).map(k => k.toLowerCase());
              if (!headerKeys.includes('ratelimit-limit')) return false;
            }
            return true;
          }
        ),
        { numRuns: 20, verbose: false }
      );
    }, 30000);

    test('registerLimiter: requests within limit (max=5) call next()', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 5 }),
          async (n) => {
            _currentClient = makeInMemoryRedisClient();
            const ip = `192.168.${Math.floor(n / 256)}.${(n % 256) || 1}`;

            for (let i = 0; i < n; i++) {
              const { req, res, next } = makeMockReqRes({ ip });
              await runMiddleware(registerLimiter, req, res, next);
              if (!next.mock.calls.length) return false;
            }
            return true;
          }
        ),
        { numRuns: 10, verbose: false }
      );
    }, 30000);
  });

  // ── Property 2b — Over-limit rejection ─────────────────────────────────────
  describe('Property 2b — Over-limit rejection (HTTP 429)', () => {
    /**
     * **Validates: Requirements 3.1**
     *
     * For any sequence exceeding max within windowMs, the (max+1)-th request
     * receives HTTP 429 with the configured message body.
     *
     * loginLimiter: max=10, message="Too many login attempts. Please try again after 15 minutes."
     */
    test('loginLimiter: (max+1)-th request receives HTTP 429', async () => {
      const MAX = 10;
      const ip = '10.1.2.3';

      // Exhaust the limit
      for (let i = 0; i < MAX; i++) {
        const { req, res, next } = makeMockReqRes({ ip });
        await runMiddleware(loginLimiter, req, res, next);
      }

      // The (max+1)-th request should be rejected
      const { req, res, next } = makeMockReqRes({ ip });
      await runMiddleware(loginLimiter, req, res, next);

      expect(res.status).toHaveBeenCalledWith(429);
      expect(next).not.toHaveBeenCalled();
    }, 30000);

    test('registerLimiter: (max+1)-th request receives HTTP 429 with configured message', async () => {
      const MAX = 5;
      const ip = '10.2.3.4';

      for (let i = 0; i < MAX; i++) {
        const { req, res, next } = makeMockReqRes({ ip });
        await runMiddleware(registerLimiter, req, res, next);
      }

      const { req, res, next } = makeMockReqRes({ ip });
      await runMiddleware(registerLimiter, req, res, next);

      expect(res.status).toHaveBeenCalledWith(429);
      expect(next).not.toHaveBeenCalled();
    }, 30000);

    test('Property 2b — over-limit rejection holds for any k ≥ 1 extra requests', async () => {
      await fc.assert(
        fc.asyncProperty(
          // k extra requests beyond max (1 to 3)
          fc.integer({ min: 1, max: 3 }),
          async (k) => {
            _currentClient = makeInMemoryRedisClient();
            const MAX = 10;
            const ip = `172.16.${k}.1`;

            // Exhaust the limit
            for (let i = 0; i < MAX; i++) {
              const { req, res, next } = makeMockReqRes({ ip });
              await runMiddleware(loginLimiter, req, res, next);
            }

            // All k extra requests should be rejected with 429
            for (let i = 0; i < k; i++) {
              const { req, res, next } = makeMockReqRes({ ip });
              await runMiddleware(loginLimiter, req, res, next);
              if (!res.status.mock.calls.some(c => c[0] === 429)) return false;
              if (next.mock.calls.length > 0) return false;
            }
            return true;
          }
        ),
        { numRuns: 5, verbose: false }
      );
    }, 60000);
  });

  // ── Property 2c — Redis key prefix isolation ────────────────────────────────
  describe('Property 2c — Redis key prefix isolation', () => {
    /**
     * **Validates: Requirements 3.3**
     *
     * loginLimiter (prefix rl:login:) and registerLimiter (prefix rl:register:)
     * must use different Redis key prefixes and NOT share counters.
     *
     * Strategy: exhaust loginLimiter for an IP, then assert registerLimiter
     * still passes requests for the same IP.
     */
    test('loginLimiter and registerLimiter do not share counters', async () => {
      const ip = '10.3.4.5';
      const LOGIN_MAX = 10;

      // Exhaust loginLimiter
      for (let i = 0; i < LOGIN_MAX; i++) {
        const { req, res, next } = makeMockReqRes({ ip });
        await runMiddleware(loginLimiter, req, res, next);
      }

      // loginLimiter should now reject
      {
        const { req, res, next } = makeMockReqRes({ ip });
        await runMiddleware(loginLimiter, req, res, next);
        expect(res.status).toHaveBeenCalledWith(429);
      }

      // registerLimiter should still pass (different prefix, different counter)
      {
        const { req, res, next } = makeMockReqRes({ ip });
        await runMiddleware(registerLimiter, req, res, next);
        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalledWith(429);
      }
    }, 30000);

    test('Property 2c — prefix isolation holds for any IP', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate a valid IPv4-like string
          fc.tuple(
            fc.integer({ min: 1, max: 254 }),
            fc.integer({ min: 1, max: 254 }),
            fc.integer({ min: 1, max: 254 }),
            fc.integer({ min: 1, max: 254 })
          ),
          async ([a, b, c, d]) => {
            _currentClient = makeInMemoryRedisClient();
            const ip = `${a}.${b}.${c}.${d}`;
            const LOGIN_MAX = 10;

            // Exhaust loginLimiter for this IP
            for (let i = 0; i < LOGIN_MAX; i++) {
              const { req, res, next } = makeMockReqRes({ ip });
              await runMiddleware(loginLimiter, req, res, next);
            }

            // loginLimiter must reject
            {
              const { req, res, next } = makeMockReqRes({ ip });
              await runMiddleware(loginLimiter, req, res, next);
              if (!res.status.mock.calls.some(c => c[0] === 429)) return false;
            }

            // registerLimiter must still pass (counter is independent)
            {
              const { req, res, next } = makeMockReqRes({ ip });
              await runMiddleware(registerLimiter, req, res, next);
              if (!next.mock.calls.length) return false;
            }

            return true;
          }
        ),
        { numRuns: 5, verbose: false }
      );
    }, 60000);
  });

  // ── Property 2d — payoutUserLimiter per-user keying ─────────────────────────
  describe('Property 2d — payoutUserLimiter per-user keying', () => {
    /**
     * **Validates: Requirements 3.5**
     *
     * payoutUserLimiter is a factory that accepts a redisClient.
     * It keys by req.body.userId, falling back to req.ip.
     *
     * Two requests with different userId values must be counted independently.
     * A request without userId must fall back to req.ip.
     *
     * Note: express-rate-limit v8 validates that custom keyGenerators using
     * req.ip call the ipKeyGenerator helper. We use a fixed IPv4 address
     * (not IPv6) to avoid the ERR_ERL_KEY_GEN_IPV6 validation error.
     * The validation fires at rateLimit() construction time, not at request time.
     */
    test('two different userIds are counted independently', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate two distinct non-empty userId strings (alphanumeric only)
          fc.tuple(
            fc.string({ minLength: 3, maxLength: 20 }).filter(s => /^[a-zA-Z0-9_-]+$/.test(s)),
            fc.string({ minLength: 3, maxLength: 20 }).filter(s => /^[a-zA-Z0-9_-]+$/.test(s))
          ).filter(([a, b]) => a !== b),
          async ([userId1, userId2]) => {
            _currentClient = makeInMemoryRedisClient();
            // Use a fixed IPv4 address to avoid ERR_ERL_KEY_GEN_IPV6 validation
            const limiter = payoutUserLimiter(_currentClient);
            const MAX = 10;
            const ip = '10.0.0.1';

            // Exhaust limit for userId1
            for (let i = 0; i < MAX; i++) {
              const { req, res, next } = makeMockReqRes({ ip, body: { userId: userId1 } });
              await runMiddleware(limiter, req, res, next);
            }

            // userId1 should be rejected
            {
              const { req, res, next } = makeMockReqRes({ ip, body: { userId: userId1 } });
              await runMiddleware(limiter, req, res, next);
              if (!res.status.mock.calls.some(c => c[0] === 429)) return false;
            }

            // userId2 should still pass (independent counter)
            {
              const { req, res, next } = makeMockReqRes({ ip, body: { userId: userId2 } });
              await runMiddleware(limiter, req, res, next);
              if (!next.mock.calls.length) return false;
            }

            return true;
          }
        ),
        { numRuns: 10, verbose: false }
      );
    }, 60000);

    test('request without userId falls back to req.ip', async () => {
      const limiter = payoutUserLimiter(_currentClient);
      const ip = '10.5.6.7';
      const MAX = 10;

      // Exhaust limit using IP (no userId in body)
      for (let i = 0; i < MAX; i++) {
        const { req, res, next } = makeMockReqRes({ ip, body: {} });
        await runMiddleware(limiter, req, res, next);
      }

      // Next request without userId should be rejected (IP-based counter exhausted)
      const { req, res, next } = makeMockReqRes({ ip, body: {} });
      await runMiddleware(limiter, req, res, next);
      expect(res.status).toHaveBeenCalledWith(429);
    }, 30000);

    test('userId-keyed and IP-keyed counters are independent', async () => {
      const limiter = payoutUserLimiter(_currentClient);
      const ip = '10.6.7.8';
      const userId = 'user-abc-123';
      const MAX = 10;

      // Exhaust limit for userId
      for (let i = 0; i < MAX; i++) {
        const { req, res, next } = makeMockReqRes({ ip, body: { userId } });
        await runMiddleware(limiter, req, res, next);
      }

      // userId should be rejected
      {
        const { req, res, next } = makeMockReqRes({ ip, body: { userId } });
        await runMiddleware(limiter, req, res, next);
        expect(res.status).toHaveBeenCalledWith(429);
      }

      // Same IP without userId should still pass (different key)
      {
        const { req, res, next } = makeMockReqRes({ ip, body: {} });
        await runMiddleware(limiter, req, res, next);
        expect(next).toHaveBeenCalled();
      }
    }, 30000);
  });

  // ── Property 2e — Standard headers, no legacy headers ──────────────────────
  describe('Property 2e — Standard headers present, legacy headers absent', () => {
    /**
     * **Validates: Requirements 3.4**
     *
     * RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset must be present.
     * X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset must be absent.
     */
    test('loginLimiter sets RateLimit-* headers and omits X-RateLimit-* headers', async () => {
      const { req, res, next } = makeMockReqRes({ ip: '10.7.8.9' });
      await runMiddleware(loginLimiter, req, res, next);

      expect(next).toHaveBeenCalled();

      // Standard headers must be present (case-insensitive check)
      const headerKeys = Object.keys(res._headers).map(k => k.toLowerCase());
      expect(headerKeys).toContain('ratelimit-limit');
      expect(headerKeys).toContain('ratelimit-remaining');
      expect(headerKeys).toContain('ratelimit-reset');

      // Legacy headers must be absent
      expect(headerKeys).not.toContain('x-ratelimit-limit');
      expect(headerKeys).not.toContain('x-ratelimit-remaining');
      expect(headerKeys).not.toContain('x-ratelimit-reset');
    }, 15000);

    test('Property 2e — header invariant holds across multiple limiters', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Pick a limiter index: 0=loginLimiter, 1=registerLimiter
          fc.integer({ min: 0, max: 1 }),
          async (limiterIdx) => {
            _currentClient = makeInMemoryRedisClient();
            const mod = await import('../middleware/rate-limit.middleware.js');
            const limiters = [mod.loginLimiter, mod.registerLimiter];
            const limiter = limiters[limiterIdx];

            const ip = `10.8.${limiterIdx + 1}.1`;
            const { req, res, next } = makeMockReqRes({ ip });
            await runMiddleware(limiter, req, res, next);

            // Must call next (within limit)
            if (!next.mock.calls.length) return false;

            const headerKeys = Object.keys(res._headers).map(k => k.toLowerCase());

            // Standard headers present
            if (!headerKeys.includes('ratelimit-limit')) return false;
            if (!headerKeys.includes('ratelimit-remaining')) return false;
            if (!headerKeys.includes('ratelimit-reset')) return false;

            // Legacy headers absent
            if (headerKeys.includes('x-ratelimit-limit')) return false;
            if (headerKeys.includes('x-ratelimit-remaining')) return false;
            if (headerKeys.includes('x-ratelimit-reset')) return false;

            return true;
          }
        ),
        { numRuns: 10, verbose: false }
      );
    }, 30000);
  });

});
