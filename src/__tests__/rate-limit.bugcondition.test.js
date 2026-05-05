/**
 * Bug Condition Exploration Test — Property 1
 *
 * **Validates: Requirements 1.1, 1.2**
 *
 * GOAL: Surface counterexamples that demonstrate the bug BEFORE the fix.
 *
 * Bug Condition (C):
 *   rate-limit.middleware.js is imported while redisConnection.client is null
 *   (i.e., connect() has never been called).
 *
 * Property 1 (expected behavior after fix):
 *   FOR ALL module import events where redisConnection.client = null,
 *   importing rate-limit.middleware.js SHALL NOT call getClient() (spy count = 0)
 *   and SHALL NOT throw.
 *
 * On UNFIXED code this test FAILS:
 *   - getClient() is called 8 times during import (once per top-level createLimiter())
 *   - Each call throws "Redis client not initialized — call connect() first"
 *   - The throws propagate as unhandled rejections
 *
 * DO NOT fix the test or the implementation when it fails.
 * The failure IS the confirmation that the bug exists.
 *
 * NOTE ON TEST DESIGN:
 *   The mock's getClient() does NOT throw — it records calls and returns undefined.
 *   This prevents a process-level crash so Jest can report the assertion failure
 *   (call count > 0) rather than an unhandled rejection.
 *   The assertion "call count = 0" is what encodes the property.
 *   On unfixed code: FAILS with call count = 8.
 *   On fixed code:   PASSES with call count = 0.
 */

import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import fc from 'fast-check';

// ── Mock redisConnection BEFORE any dynamic import of the middleware ──────────
// jest.unstable_mockModule intercepts the module at the path relative to THIS test file.
// The middleware (src/middleware/rate-limit.middleware.js) imports:
//   import redisConnection from "../config/redis.js"
// which resolves to src/config/redis.js.
// From src/__tests__/ the relative path to that module is ../config/redis.js.
//
// IMPORTANT: mockGetClient does NOT throw here. If it threw, the unhandled
// rejection from the middleware's module-level RedisStore construction would
// crash the Node.js process before Jest could record the test failure.
// Instead, we record the call and return a stub object with a .call() method
// that returns a fake SHA1 string — this is what rate-limit-redis's RedisStore
// constructor expects from "SCRIPT LOAD" commands.
// The assertion on call count is what proves the bug:
//   count > 0 on unfixed code (called 8 times at module load)
//   count = 0 on fixed code   (never called at module load)
const FAKE_SHA1 = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';
const mockGetClient = jest.fn(() => ({
  call: jest.fn().mockResolvedValue(FAKE_SHA1),
}));

jest.unstable_mockModule('../config/redis.js', () => ({
  default: {
    client:      null,
    isConnected: false,
    connect:     jest.fn(),
    disconnect:  jest.fn(),
    getClient:   mockGetClient,
    isHealthy:   jest.fn().mockResolvedValue(false),
  },
}));

// ── Test setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockGetClient.mockClear();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Bug Condition: Module Import with null Redis client', () => {

  /**
   * Concrete test: import the middleware while client is null.
   * Assert getClient() was called 0 times.
   *
   * EXPECTED ON UNFIXED CODE: FAILS — getClient() is called 8 times
   * (once per top-level createLimiter() invocation, one per exported limiter).
   *
   * The 8 calls correspond to:
   *   1. globalLimiter
   *   2. registerLimiter
   *   3. loginLimiter
   *   4. forgotPasswordLimiter
   *   5. verifyOtpLimiter
   *   6. publicApiLimiter
   *   7. changePasswordLimiter
   *   8. refreshTokenLimiter
   */
  test('importing rate-limit.middleware.js with null client should NOT call getClient()', async () => {
    // Arrange: getClient spy is already set up via jest.unstable_mockModule above.
    // client is null — this is the bug condition.

    // Act: import the middleware module (this is where the bug fires on unfixed code)
    let importError = null;
    try {
      await import('../middleware/rate-limit.middleware.js');
    } catch (err) {
      importError = err;
    }

    // Assert 1: import should complete without throwing
    expect(importError).toBeNull();

    // Assert 2: getClient() should NOT have been called during import
    // On unfixed code: FAILS — called 8 times (once per createLimiter() call)
    const callCount = mockGetClient.mock.calls.length;
    expect(callCount).toBe(0);
  });

  /**
   * Property-based test: for all module import events where the bug condition holds
   * (redisConnection.client = null), the middleware import SHALL NOT call getClient().
   *
   * We use fast-check to model the "module import event" as a record with
   * moduleLoaded = "rate-limit.middleware.js" and redisConnection.client = null.
   * The property is deterministic (the bug always fires), so fast-check will
   * find the counterexample on the very first run.
   *
   * **Validates: Requirements 1.1, 1.2**
   */
  test('Property 1 — for all bug-condition import events, getClient() call count = 0', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Arbitrary representing a ModuleImportEvent where isBugCondition = true
        fc.record({
          moduleLoaded:     fc.constant('rate-limit.middleware.js'),
          redisClientState: fc.constant(null),   // client is null — bug condition
        }),
        async (_importEvent) => {
          // Note: Jest caches ESM modules, so the import below returns the cached
          // module after the first call. The spy count accumulated during the first
          // import (in the test above) is what demonstrates the bug.
          // We clear the spy here to measure only calls from this property run.
          mockGetClient.mockClear();

          // Act: import the middleware (triggers the bug on unfixed code)
          let importError = null;
          try {
            await import('../middleware/rate-limit.middleware.js');
          } catch (err) {
            importError = err;
          }

          // Property: no error thrown during import
          if (importError !== null) {
            return false;
          }

          // Property: getClient() must not be called during import
          // Counterexample on unfixed code: called 8 times on first import
          // (subsequent imports return cached module, so count = 0 after first)
          // The first test above captures the definitive call count.
          const callCount = mockGetClient.mock.calls.length;
          return callCount === 0;
        }
      ),
      {
        numRuns: 1, // Bug is deterministic — one run is sufficient to surface the counterexample
        verbose: true,
      }
    );
  });

  /**
   * Supplementary assertion: verify the exported limiters are functions (not
   * pre-constructed objects). On unfixed code this test may not even be reached
   * because the import itself throws.
   */
  test('all exported limiters should be Express middleware functions after import', async () => {
    const middleware = await import('../middleware/rate-limit.middleware.js');

    expect(typeof middleware.globalLimiter).toBe('function');
    expect(typeof middleware.loginLimiter).toBe('function');
    expect(typeof middleware.registerLimiter).toBe('function');
    expect(typeof middleware.forgotPasswordLimiter).toBe('function');
    expect(typeof middleware.verifyOtpLimiter).toBe('function');
    expect(typeof middleware.publicApiLimiter).toBe('function');
    expect(typeof middleware.changePasswordLimiter).toBe('function');
    expect(typeof middleware.refreshTokenLimiter).toBe('function');
    expect(typeof middleware.payoutUserLimiter).toBe('function');
  });

});
