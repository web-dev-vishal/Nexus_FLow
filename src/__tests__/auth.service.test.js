/**
 * Unit tests for auth service — register, login, logout, refresh token flows.
 * Uses jest.unstable_mockModule for ESM-compatible mocking.
 */

import { describe, test, expect, jest, beforeEach } from '@jest/globals';

// ── Mock Redis ────────────────────────────────────────────────────────────────
const mockRedis = {
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1),
};

jest.unstable_mockModule('../lib/redis.js', () => ({
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

jest.unstable_mockModule('../models/user.model.js', () => ({
  default: mockUser,
}));

// ── Mock email helpers ────────────────────────────────────────────────────────
jest.unstable_mockModule('../email/verifyMail.js',  () => ({
  verifyMail: jest.fn().mockResolvedValue(true),
}));
jest.unstable_mockModule('../email/sendOtpMail.js', () => ({
  sendOtpMail: jest.fn().mockResolvedValue(true),
}));

// Set env vars before dynamic import
process.env.ACCESS_SECRET  = 'test-access-secret-at-least-32-chars';
process.env.REFRESH_SECRET = 'test-refresh-secret-at-least-32-chars';
process.env.VERIFY_SECRET  = 'test-verify-secret-at-least-32-chars';

// Dynamic import AFTER mocks are registered
const { registerService, loginService, logoutService, refreshTokenService } =
  await import('../services/auth.service.js');

// ── register ──────────────────────────────────────────────────────────────────
describe('registerService', () => {
  beforeEach(() => jest.clearAllMocks());

  test('throws 400 if user already exists', async () => {
    mockUser.findOne.mockResolvedValue({ _id: 'existing', email: 'test@test.com' });
    await expect(registerService({ username: 'test', email: 'test@test.com', password: 'pass123' }))
      .rejects.toMatchObject({ statusCode: 400, message: 'User already exists' });
  });

  test('creates user and returns safe fields when email is new', async () => {
    mockUser.findOne.mockResolvedValue(null);
    mockUser.create.mockResolvedValue({
      _id: 'newid',
      username: 'alice',
      email: 'alice@test.com',
      isVerified: false,
    });
    const result = await registerService({ username: 'alice', email: 'alice@test.com', password: 'pass123' });
    expect(result).toHaveProperty('email', 'alice@test.com');
    expect(result).not.toHaveProperty('password');
  });
});

// ── login ─────────────────────────────────────────────────────────────────────
describe('loginService', () => {
  beforeEach(() => jest.clearAllMocks());

  test('throws 401 for unknown email', async () => {
    mockUser.findOne.mockResolvedValue(null);
    await expect(loginService({ email: 'nobody@test.com', password: 'pass' }))
      .rejects.toMatchObject({ statusCode: 401 });
  });

  test('throws 401 for wrong password', async () => {
    mockUser.findOne.mockResolvedValue({
      _id: 'uid1',
      email: 'user@test.com',
      isVerified: true,
      comparePassword: jest.fn().mockResolvedValue(false),
    });
    await expect(loginService({ email: 'user@test.com', password: 'wrong' }))
      .rejects.toMatchObject({ statusCode: 401 });
  });

  test('throws 403 if email not verified', async () => {
    mockUser.findOne.mockResolvedValue({
      _id: 'uid1',
      email: 'user@test.com',
      isVerified: false,
      comparePassword: jest.fn().mockResolvedValue(true),
    });
    await expect(loginService({ email: 'user@test.com', password: 'correct' }))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  test('returns tokens and user payload on success', async () => {
    mockUser.findOne.mockResolvedValue({
      _id: { toString: () => 'uid1' },
      username: 'alice',
      email: 'alice@test.com',
      role: 'customer',
      isVerified: true,
      comparePassword: jest.fn().mockResolvedValue(true),
    });
    const result = await loginService({ email: 'alice@test.com', password: 'correct' });
    expect(result).toHaveProperty('accessToken');
    expect(result).toHaveProperty('refreshToken');
    expect(result.user).not.toHaveProperty('password');
  });
});

// ── logout ────────────────────────────────────────────────────────────────────
describe('logoutService', () => {
  beforeEach(() => jest.clearAllMocks());

  test('deletes refresh token and user cache from Redis', async () => {
    await logoutService('user123');
    expect(mockRedis.del).toHaveBeenCalledTimes(2);
  });
});

// ── refreshToken ──────────────────────────────────────────────────────────────
describe('refreshTokenService', () => {
  test('throws 401 for invalid token', async () => {
    await expect(refreshTokenService('not-a-valid-token'))
      .rejects.toMatchObject({ statusCode: 401 });
  });
});
