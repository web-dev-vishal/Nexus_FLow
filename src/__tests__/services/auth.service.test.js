/**
 * Additional unit tests for auth service — getCachedUser, forgotPassword, verifyOTP.
 * Complements src/__tests__/auth.service.test.js with coverage of additional functions.
 * Uses jest.unstable_mockModule for ESM-compatible mocking.
 */

import { describe, test, expect, jest, beforeEach } from '@jest/globals';

// ── Mock Redis ────────────────────────────────────────────────────────────────
const mockRedis = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
};

jest.unstable_mockModule('../../lib/redis.js', () => ({
    getRedis: jest.fn(() => mockRedis),
    keys: {
        verifyToken:  (id) => `verify:${id}`,
        refreshToken: (id) => `refresh:${id}`,
        userCache:    (id) => `user:${id}`,
        otp:          (email) => `otp:${email}`,
    },
    TTL: { VERIFY: 600, REFRESH: 2592000, USER_CACHE: 3600, OTP: 600 },
}));

// ── Mock User model ───────────────────────────────────────────────────────────
const mockUser = {
    findOne:           jest.fn(),
    findById:          jest.fn(),
    findByIdAndUpdate: jest.fn(),
    create:            jest.fn(),
};

jest.unstable_mockModule('../../models/user.model.js', () => ({
    default: mockUser,
}));

// ── Mock email helpers ────────────────────────────────────────────────────────
jest.unstable_mockModule('../../email/verifyMail.js', () => ({
    verifyMail: jest.fn().mockResolvedValue(true),
}));
jest.unstable_mockModule('../../email/sendOtpMail.js', () => ({
    sendOtpMail: jest.fn().mockResolvedValue(true),
}));

// ── Mock token service ────────────────────────────────────────────────────────
jest.unstable_mockModule('../../services/token.service.js', () => ({
    issueTokenPair:     jest.fn().mockResolvedValue({ accessToken: 'access', refreshToken: 'refresh' }),
    issueAccessToken:   jest.fn().mockResolvedValue('access'),
    issueVerifyToken:   jest.fn().mockResolvedValue('verify'),
    verifyRefreshToken: jest.fn().mockResolvedValue({ sub: 'uid1' }),
    verifyVerifyToken:  jest.fn().mockResolvedValue({ sub: 'uid1' }),
    TOKEN_TTL: { ACCESS: 900, REFRESH: 2592000, VERIFY: 600 },
}));

process.env.ACCESS_SECRET  = 'test-access-secret-at-least-32-chars';
process.env.REFRESH_SECRET = 'test-refresh-secret-at-least-32-chars';
process.env.VERIFY_SECRET  = 'test-verify-secret-at-least-32-chars';

// Dynamic import AFTER mocks are registered
const {
    getCachedUser,
    forgotPasswordService,
    verifyOTPService,
} = await import('../../services/auth.service.js');

// ── getCachedUser ─────────────────────────────────────────────────────────────
describe('getCachedUser', () => {
    beforeEach(() => jest.clearAllMocks());

    test('returns parsed JSON from Redis cache when available', async () => {
        const cachedPayload = { _id: 'uid1', username: 'alice', email: 'alice@test.com', role: 'customer', isVerified: true };
        mockRedis.get.mockResolvedValue(JSON.stringify(cachedPayload));

        const result = await getCachedUser('uid1');

        expect(result).toEqual(cachedPayload);
        // Should NOT hit MongoDB when cache is warm
        expect(mockUser.findById).not.toHaveBeenCalled();
    });

    test('fetches from MongoDB and caches when Redis miss', async () => {
        mockRedis.get.mockResolvedValue(null);

        const dbUser = {
            _id:        { toString: () => 'uid1' },
            username:   'bob',
            email:      'bob@test.com',
            role:       'customer',
            isVerified: true,
            select:     jest.fn().mockReturnThis(),
        };
        // findById().select() chain
        mockUser.findById.mockReturnValue({
            select: jest.fn().mockResolvedValue(dbUser),
        });

        const result = await getCachedUser('uid1');

        expect(result).toMatchObject({ username: 'bob', email: 'bob@test.com' });
        // Should cache the result in Redis
        expect(mockRedis.set).toHaveBeenCalledWith(
            'user:uid1',
            expect.any(String),
            'EX',
            expect.any(Number)
        );
    });

    test('returns null when user not found in MongoDB', async () => {
        mockRedis.get.mockResolvedValue(null);
        mockUser.findById.mockReturnValue({
            select: jest.fn().mockResolvedValue(null),
        });

        const result = await getCachedUser('nonexistent');
        expect(result).toBeNull();
    });
});

// ── forgotPasswordService ─────────────────────────────────────────────────────
describe('forgotPasswordService', () => {
    beforeEach(() => jest.clearAllMocks());

    test('throws USER_NOT_FOUND for unknown email', async () => {
        mockUser.findOne.mockResolvedValue(null);

        await expect(forgotPasswordService('unknown@test.com'))
            .rejects.toMatchObject({ statusCode: 404, code: 'USER_NOT_FOUND' });
    });

    test('stores OTP in Redis and sends email on success', async () => {
        mockUser.findOne.mockResolvedValue({ _id: 'uid1', email: 'user@test.com' });
        mockRedis.set.mockResolvedValue('OK');

        const { sendOtpMail } = await import('../../email/sendOtpMail.js');

        await forgotPasswordService('user@test.com');

        expect(mockRedis.set).toHaveBeenCalledWith(
            'otp:user@test.com',
            expect.stringMatching(/^\d{6}$/),
            'EX',
            expect.any(Number)
        );
        expect(sendOtpMail).toHaveBeenCalledWith('user@test.com', expect.stringMatching(/^\d{6}$/));
    });
});

// ── verifyOTPService ──────────────────────────────────────────────────────────
describe('verifyOTPService', () => {
    beforeEach(() => jest.clearAllMocks());

    test('throws OTP_INVALID for wrong OTP', async () => {
        mockUser.findOne.mockResolvedValue({ _id: 'uid1', email: 'user@test.com' });
        // Redis has '123456' stored but user provides '999999'
        mockRedis.get.mockResolvedValue('123456');

        await expect(verifyOTPService('user@test.com', '999999'))
            .rejects.toMatchObject({ statusCode: 400, code: 'OTP_INVALID' });
    });

    test('throws OTP_INVALID when no OTP in Redis (expired or not generated)', async () => {
        mockUser.findOne.mockResolvedValue({ _id: 'uid1', email: 'user@test.com' });
        mockRedis.get.mockResolvedValue(null);

        await expect(verifyOTPService('user@test.com', '123456'))
            .rejects.toMatchObject({ statusCode: 400, code: 'OTP_INVALID' });
    });

    test('throws USER_NOT_FOUND for unknown email', async () => {
        mockUser.findOne.mockResolvedValue(null);

        await expect(verifyOTPService('nobody@test.com', '123456'))
            .rejects.toMatchObject({ statusCode: 404, code: 'USER_NOT_FOUND' });
    });

    test('succeeds and deletes OTP from Redis when OTP matches', async () => {
        mockUser.findOne.mockResolvedValue({ _id: 'uid1', email: 'user@test.com' });
        mockRedis.get.mockResolvedValue('654321');
        mockRedis.del.mockResolvedValue(1);
        mockRedis.set.mockResolvedValue('OK');

        await expect(verifyOTPService('user@test.com', '654321')).resolves.not.toThrow();
        expect(mockRedis.del).toHaveBeenCalledWith('otp:user@test.com');
    });
});
