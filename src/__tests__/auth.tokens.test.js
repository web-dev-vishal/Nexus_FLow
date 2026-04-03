/**
 * Unit tests for JWT token logic used in auth flows.
 * Tests token generation, expiry, and verification without any DB/Redis calls.
 */

import { describe, test, expect } from '@jest/globals';
import jwt from 'jsonwebtoken';

const ACCESS_SECRET  = 'test-access-secret-at-least-32-chars';
const REFRESH_SECRET = 'test-refresh-secret-at-least-32-chars';
const VERIFY_SECRET  = 'test-verify-secret-at-least-32-chars';

describe('Access token', () => {
  test('can be signed and verified', () => {
    const token = jwt.sign({ id: 'user1' }, ACCESS_SECRET, { expiresIn: '15m' });
    const decoded = jwt.verify(token, ACCESS_SECRET);
    expect(decoded.id).toBe('user1');
  });

  test('15m TTL is exactly 900 seconds', () => {
    const token = jwt.sign({ id: 'user1' }, ACCESS_SECRET, { expiresIn: '15m' });
    const { iat, exp } = jwt.decode(token);
    expect(exp - iat).toBe(900);
  });

  test('fails verification with wrong secret', () => {
    const token = jwt.sign({ id: 'user1' }, ACCESS_SECRET, { expiresIn: '15m' });
    expect(() => jwt.verify(token, 'wrong-secret')).toThrow();
  });

  test('expired token throws TokenExpiredError', () => {
    const token = jwt.sign({ id: 'user1' }, ACCESS_SECRET, { expiresIn: '-1s' });
    expect(() => jwt.verify(token, ACCESS_SECRET)).toThrow('jwt expired');
  });
});

describe('Refresh token', () => {
  test('30d TTL is exactly 2592000 seconds', () => {
    const token = jwt.sign({ id: 'user1' }, REFRESH_SECRET, { expiresIn: '30d' });
    const { iat, exp } = jwt.decode(token);
    expect(exp - iat).toBe(30 * 24 * 60 * 60);
  });

  test('cannot be verified with access secret', () => {
    const token = jwt.sign({ id: 'user1' }, REFRESH_SECRET, { expiresIn: '30d' });
    expect(() => jwt.verify(token, ACCESS_SECRET)).toThrow();
  });
});

describe('Verification token', () => {
  test('10m TTL is exactly 600 seconds', () => {
    const token = jwt.sign({ id: 'user1' }, VERIFY_SECRET, { expiresIn: '10m' });
    const { iat, exp } = jwt.decode(token);
    expect(exp - iat).toBe(600);
  });
});

describe('Token payload', () => {
  test('contains only id — no sensitive fields', () => {
    const token = jwt.sign({ id: 'user1' }, ACCESS_SECRET, { expiresIn: '15m' });
    const decoded = jwt.decode(token);
    expect(decoded).not.toHaveProperty('password');
    expect(decoded).not.toHaveProperty('email');
    expect(decoded).toHaveProperty('id');
  });
});
