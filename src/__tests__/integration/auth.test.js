/**
 * Integration tests for auth endpoints using supertest.
 * Mocks all infrastructure (MongoDB, Redis, RabbitMQ, WebSocket) and the auth service
 * so tests run without real external dependencies.
 */

import { describe, test, expect, jest, beforeAll, afterAll } from '@jest/globals';

// ── Top-level imports needed inside mock factories ────────────────────────────
// These must be imported before jest.unstable_mockModule calls that use them
const { default: expressForMiddleware } = await import('express');
const { z } = await import('zod');

// ── Mock infrastructure BEFORE importing the app ─────────────────────────────

jest.unstable_mockModule('../../config/database.js', () => ({
    default: {
        connect:     jest.fn().mockResolvedValue(undefined),
        disconnect:  jest.fn().mockResolvedValue(undefined),
        isHealthy:   jest.fn().mockReturnValue(true),
        isConnected: true,
    },
}));

const mockRedisClient = {
    get:       jest.fn().mockResolvedValue(null),
    set:       jest.fn().mockResolvedValue('OK'),
    del:       jest.fn().mockResolvedValue(1),
    ping:      jest.fn().mockResolvedValue('PONG'),
    eval:      jest.fn().mockResolvedValue(null),
    on:        jest.fn(),
    quit:      jest.fn().mockResolvedValue(undefined),
    subscribe: jest.fn().mockResolvedValue(undefined),
    duplicate: jest.fn().mockReturnValue({
        subscribe: jest.fn().mockResolvedValue(undefined),
        on:        jest.fn(),
    }),
    status: 'ready',
};

jest.unstable_mockModule('../../config/redis.js', () => ({
    default: {
        connect:     jest.fn().mockResolvedValue(undefined),
        disconnect:  jest.fn().mockResolvedValue(undefined),
        getClient:   jest.fn().mockReturnValue(mockRedisClient),
        isHealthy:   jest.fn().mockResolvedValue(true),
        isConnected: true,
        client:      mockRedisClient,
    },
}));

const mockChannel = {
    assertExchange: jest.fn().mockResolvedValue({}),
    assertQueue:    jest.fn().mockResolvedValue({}),
    bindQueue:      jest.fn().mockResolvedValue({}),
    prefetch:       jest.fn().mockResolvedValue({}),
    sendToQueue:    jest.fn().mockReturnValue(true),
    publish:        jest.fn().mockReturnValue(true),
    consume:        jest.fn().mockResolvedValue({}),
    on:             jest.fn(),
    close:          jest.fn().mockResolvedValue(undefined),
};

jest.unstable_mockModule('../../config/rabbitmq.js', () => ({
    default: {
        connect:     jest.fn().mockResolvedValue(undefined),
        disconnect:  jest.fn().mockResolvedValue(undefined),
        getChannel:  jest.fn().mockReturnValue(mockChannel),
        isHealthy:   jest.fn().mockReturnValue(true),
        isConnected: true,
        channel:     mockChannel,
        channelPool: [mockChannel],
    },
}));

jest.unstable_mockModule('../../config/websocket.js', () => ({
    default: {
        initialize:               jest.fn().mockReturnValue({ on: jest.fn(), engine: { clientsCount: 0 } }),
        close:                    jest.fn().mockResolvedValue(undefined),
        emitPayoutInitiated:      jest.fn(),
        emitPayoutCompleted:      jest.fn(),
        emitPayoutFailed:         jest.fn(),
        emitPayoutProcessing:     jest.fn(),
        emitToUser:               jest.fn(),
        emitToRoom:               jest.fn(),
        emitMessageCreated:       jest.fn(),
        emitMessageUpdated:       jest.fn(),
        emitMessageDeleted:       jest.fn(),
        emitReactionUpdated:      jest.fn(),
        isUserConnected:          jest.fn().mockReturnValue(false),
        getConnectedClientsCount: jest.fn().mockReturnValue(0),
        clients:                  new Map(),
        io:                       null,
    },
}));

// ── Mock config/middleware to avoid Express 5 incompatibilities ───────────────
// express-mongo-sanitize tries to set req.query which is read-only in Express 5
jest.unstable_mockModule('../../config/middleware.js', () => ({
    default: (app) => {
        app.use(expressForMiddleware.json({ limit: '10kb' }));
        app.use(expressForMiddleware.urlencoded({ extended: true, limit: '10kb' }));
    },
}));

// ── Mock validators with Zod v4 compatible error format ───────────────────────
// user.validate.js uses result.error.errors which doesn't exist in Zod v4 (use .issues)
const registerSchema = z.object({
    username: z.string().min(3).max(30),
    email:    z.string().email(),
    password: z.string().min(6).max(64),
});
const loginSchema = z.object({
    email:    z.string().email(),
    password: z.string().min(1),
});
const validate = (schema) => (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
        const errors = result.error.issues.map((e) => e.message);
        return res.status(400).json({ success: false, errors });
    }
    req.body = result.data;
    next();
};

jest.unstable_mockModule('../../validators/user.validate.js', () => ({
    registerSchema,
    loginSchema,
    forgotPasswordSchema:     z.object({ email: z.string().email() }),
    verifyOtpSchema:          z.object({ otp: z.string().length(6) }),
    changePasswordSchema:     z.object({ newPassword: z.string().min(6), confirmPassword: z.string() }),
    updateProfileSchema:      z.object({ username: z.string().optional(), email: z.string().optional() }),
    resendVerificationSchema: z.object({ email: z.string().email() }),
    validate,
}));

// ── Mock rate-limit middleware to avoid Redis dependency ──────────────────────
const noopMiddleware = (req, res, next) => next();
jest.unstable_mockModule('../../middleware/rate-limit.middleware.js', () => ({
    globalLimiter:         noopMiddleware,
    registerLimiter:       noopMiddleware,
    loginLimiter:          noopMiddleware,
    forgotPasswordLimiter: noopMiddleware,
    verifyOtpLimiter:      noopMiddleware,
    changePasswordLimiter: noopMiddleware,
    refreshTokenLimiter:   noopMiddleware,
    publicApiLimiter:      noopMiddleware,
    payoutUserLimiter:     () => noopMiddleware,
}));

// ── Mock scheduler service to avoid background timers ────────────────────────
jest.unstable_mockModule('../../services/scheduler.service.js', () => ({
    default: class MockSchedulerService {
        constructor() {}
        start() {}
        stop() {}
    },
}));

// ── Mock auth service ─────────────────────────────────────────────────────────
const mockRegisterService = jest.fn();
const mockLoginService    = jest.fn();
const mockLogoutService   = jest.fn();
const mockGetCachedUser   = jest.fn();

jest.unstable_mockModule('../../services/auth.service.js', () => ({
    registerService:          mockRegisterService,
    loginService:             mockLoginService,
    logoutService:            mockLogoutService,
    refreshTokenService:      jest.fn(),
    verifyEmailService:       jest.fn(),
    forgotPasswordService:    jest.fn(),
    verifyOTPService:         jest.fn(),
    changePasswordService:    jest.fn(),
    resendVerificationService:jest.fn(),
    updateProfileService:     jest.fn(),
    getCachedUser:            mockGetCachedUser,
}));

// ── Mock token service (used by auth middleware) ──────────────────────────────
const mockVerifyAccessToken = jest.fn();

jest.unstable_mockModule('../../services/token.service.js', () => ({
    issueTokenPair:     jest.fn().mockResolvedValue({ accessToken: 'access', refreshToken: 'refresh' }),
    issueAccessToken:   jest.fn().mockResolvedValue('access'),
    issueVerifyToken:   jest.fn().mockResolvedValue('verify'),
    verifyRefreshToken: jest.fn().mockResolvedValue({ sub: 'uid1' }),
    verifyVerifyToken:  jest.fn().mockResolvedValue({ sub: 'uid1' }),
    verifyAccessToken:  mockVerifyAccessToken,
    TOKEN_TTL: { ACCESS: 900, REFRESH: 2592000, VERIFY: 600 },
}));

// ── Mock lib/redis (used by auth service internals) ───────────────────────────
jest.unstable_mockModule('../../lib/redis.js', () => ({
    getRedis: jest.fn(() => mockRedisClient),
    keys: {
        verifyToken:  (id) => `verify:${id}`,
        refreshToken: (id) => `refresh:${id}`,
        userCache:    (id) => `user:${id}`,
        otp:          (email) => `otp:${email}`,
    },
    TTL: { VERIFY: 600, REFRESH: 2592000, USER_CACHE: 3600, OTP: 600 },
}));

// ── Dynamic imports AFTER all mocks ──────────────────────────────────────────
const { default: request } = await import('supertest');
const { default: Application } = await import('../../app.js');

let app;
let appInstance;

beforeAll(async () => {
    appInstance = new Application();
    await appInstance.initialize();
    app = appInstance.getApp();
});

afterAll(async () => {
    if (appInstance) {
        try { await appInstance.shutdown(); } catch { /* ignore */ }
    }
});

// ── POST /api/auth/register ───────────────────────────────────────────────────
describe('POST /api/auth/register', () => {
    test('returns 201 with valid body', async () => {
        mockRegisterService.mockResolvedValue({
            _id: 'uid1', username: 'alice', email: 'alice@test.com', isVerified: false,
        });

        const res = await request(app)
            .post('/api/auth/register')
            .send({ username: 'alice', email: 'alice@test.com', password: 'password123' });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
    });

    test('returns 400 when email is missing', async () => {
        const res = await request(app)
            .post('/api/auth/register')
            .send({ username: 'alice', password: 'password123' });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    test('returns 400 when username is too short', async () => {
        const res = await request(app)
            .post('/api/auth/register')
            .send({ username: 'ab', email: 'alice@test.com', password: 'password123' });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
describe('POST /api/auth/login', () => {
    test('returns 200 with tokens on valid credentials', async () => {
        mockLoginService.mockResolvedValue({
            accessToken:  'access-token',
            refreshToken: 'refresh-token',
            user: { _id: 'uid1', username: 'alice', email: 'alice@test.com', role: 'customer', isVerified: true },
        });

        const res = await request(app)
            .post('/api/auth/login')
            .send({ email: 'alice@test.com', password: 'password123' });

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('accessToken');
        expect(res.body).toHaveProperty('refreshToken');
    });

    test('returns 401 when password is wrong', async () => {
        const err = Object.assign(new Error('Invalid email or password'), { statusCode: 401 });
        mockLoginService.mockRejectedValue(err);

        const res = await request(app)
            .post('/api/auth/login')
            .send({ email: 'alice@test.com', password: 'wrongpassword' });

        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
    });
});

// ── GET /api/auth/profile ─────────────────────────────────────────────────────
describe('GET /api/auth/profile', () => {
    test('returns 401 without token', async () => {
        const res = await request(app).get('/api/auth/profile');
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
    });

    test('returns 401 with invalid token', async () => {
        const err = Object.assign(new Error('Invalid token'), { statusCode: 401, code: 'TOKEN_INVALID' });
        mockVerifyAccessToken.mockRejectedValue(err);

        const res = await request(app)
            .get('/api/auth/profile')
            .set('Authorization', 'Bearer invalid-token-here');

        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
    });
});
