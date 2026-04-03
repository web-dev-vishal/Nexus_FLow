/**
 * Unit tests for Express middleware (sanitize, error, notFound).
 * Pure ESM — no require(), no jest.mock() (use jest.unstable_mockModule for ESM).
 */

import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import { xssSanitizer } from '../middleware/sanitize.middleware.js';
import { notFoundHandler, errorHandler } from '../middleware/error.middleware.js';

// ── xssSanitizer ─────────────────────────────────────────────────────────────
describe('xssSanitizer middleware', () => {
  const makeReq = (body = {}, query = {}, params = {}) => ({ body, query, params });
  const next = jest.fn();

  beforeEach(() => next.mockClear());

  test('strips script tags from body strings', () => {
    const req = makeReq({ name: '<script>alert(1)</script>hello' });
    xssSanitizer(req, {}, next);
    expect(req.body.name).not.toContain('<script>');
    expect(req.body.name).toContain('hello');
    expect(next).toHaveBeenCalled();
  });

  test('sanitizes nested objects', () => {
    const req = makeReq({ user: { bio: '<img src=x onerror=alert(1)>safe' } });
    xssSanitizer(req, {}, next);
    expect(req.body.user.bio).not.toContain('onerror');
  });

  test('sanitizes arrays', () => {
    const req = makeReq({ tags: ['<b>ok</b>', '<script>bad</script>'] });
    xssSanitizer(req, {}, next);
    expect(req.body.tags[1]).not.toContain('<script>');
  });

  test('passes numbers and booleans unchanged', () => {
    const req = makeReq({ amount: 100, active: true });
    xssSanitizer(req, {}, next);
    expect(req.body.amount).toBe(100);
    expect(req.body.active).toBe(true);
  });

  test('sanitizes query and params', () => {
    const req = makeReq({}, { q: '<script>x</script>' }, { id: '<script>1</script>' });
    xssSanitizer(req, {}, next);
    expect(req.query.q).not.toContain('<script>');
    expect(req.params.id).not.toContain('<script>');
  });
});

// ── notFoundHandler ───────────────────────────────────────────────────────────
describe('notFoundHandler middleware', () => {
  test('returns 404 with NOT_FOUND code', () => {
    const req = { originalUrl: '/api/nonexistent' };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    notFoundHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      code: 'NOT_FOUND',
    }));
  });
});

// ── errorHandler ──────────────────────────────────────────────────────────────
describe('errorHandler middleware', () => {
  const next = jest.fn();

  test('returns 500 for generic errors', async () => {
    const err = new Error('Something broke');
    const req = { originalUrl: '/api/test', method: 'POST', ip: '127.0.0.1', body: {} };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await errorHandler(err, req, res, next);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });

  test('returns 400 for Mongoose ValidationError', async () => {
    const err = { name: 'ValidationError', errors: { email: { message: 'Email is required' } } };
    const req = { originalUrl: '/api/test', method: 'POST', ip: '127.0.0.1', body: {} };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await errorHandler(err, req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('does not expose stack trace in production', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const err = new Error('Prod error');
    err.stack = 'Error: Prod error\n    at Object.<anonymous>';
    const req = { originalUrl: '/api/test', method: 'GET', ip: '127.0.0.1', body: {} };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await errorHandler(err, req, res, next);
    const body = res.json.mock.calls[0][0];
    expect(body.stack).toBeUndefined();
    process.env.NODE_ENV = originalEnv;
  });

  test('returns 401 for JsonWebTokenError', async () => {
    const err = { name: 'JsonWebTokenError', message: 'invalid token' };
    const req = { originalUrl: '/api/test', method: 'GET', ip: '127.0.0.1', body: {} };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await errorHandler(err, req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('returns 400 for MongoDB duplicate key error (code 11000)', async () => {
    const err = { code: 11000, keyValue: { email: 'test@test.com' } };
    const req = { originalUrl: '/api/test', method: 'POST', ip: '127.0.0.1', body: {} };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await errorHandler(err, req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
