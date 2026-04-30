/**
 * Unit tests for BalanceService.
 * Uses a mock Redis client with a mock eval function.
 * The Lua script returns: null for missing key, -1 for insufficient balance,
 * or the new balance as a number.
 */

import { describe, test, expect, jest, beforeEach } from '@jest/globals';
import BalanceService from '../../services/balance.service.js';

// Mock Redis client
const mockRedis = {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    eval: jest.fn(),
};

let service;

beforeEach(() => {
    jest.clearAllMocks();
    service = new BalanceService(mockRedis);
});

// ── getBalance ────────────────────────────────────────────────────────────────
describe('getBalance', () => {
    test('returns null when key does not exist', async () => {
        mockRedis.get.mockResolvedValue(null);
        const result = await service.getBalance('user1');
        expect(result).toBeNull();
        expect(mockRedis.get).toHaveBeenCalledWith('balance:user1');
    });

    test('returns float when key exists', async () => {
        mockRedis.get.mockResolvedValue('150.75');
        const result = await service.getBalance('user1');
        expect(result).toBe(150.75);
    });

    test('returns 0 when balance is zero', async () => {
        mockRedis.get.mockResolvedValue('0');
        const result = await service.getBalance('user1');
        expect(result).toBe(0);
    });
});

// ── deductBalance ─────────────────────────────────────────────────────────────
describe('deductBalance', () => {
    test('throws BALANCE_NOT_FOUND when key is missing (eval returns null)', async () => {
        mockRedis.eval.mockResolvedValue(null);
        await expect(service.deductBalance('user1', 50)).rejects.toThrow('BALANCE_NOT_FOUND');
    });

    test('throws INSUFFICIENT_BALANCE when amount exceeds balance (eval returns -1)', async () => {
        mockRedis.eval.mockResolvedValue(-1);
        await expect(service.deductBalance('user1', 200)).rejects.toThrow('INSUFFICIENT_BALANCE');
    });

    test('returns new balance as float on success', async () => {
        mockRedis.eval.mockResolvedValue(50);
        const result = await service.deductBalance('user1', 50);
        expect(result).toBe(50);
    });

    test('calls eval with correct key and amount', async () => {
        mockRedis.eval.mockResolvedValue(75);
        await service.deductBalance('user42', 25);
        // eval is called with (lua, numKeys, key, amount)
        expect(mockRedis.eval).toHaveBeenCalledWith(
            expect.any(String),
            1,
            'balance:user42',
            '25'
        );
    });
});

// ── addBalance ────────────────────────────────────────────────────────────────
describe('addBalance', () => {
    test('throws BALANCE_NOT_FOUND when key is missing (eval returns null)', async () => {
        mockRedis.eval.mockResolvedValue(null);
        await expect(service.addBalance('user1', 50)).rejects.toThrow('BALANCE_NOT_FOUND');
    });

    test('returns new balance as float on success', async () => {
        mockRedis.eval.mockResolvedValue(150);
        const result = await service.addBalance('user1', 50);
        expect(result).toBe(150);
    });

    test('calls eval with correct key and amount', async () => {
        mockRedis.eval.mockResolvedValue(200);
        await service.addBalance('user99', 100);
        expect(mockRedis.eval).toHaveBeenCalledWith(
            expect.any(String),
            1,
            'balance:user99',
            '100'
        );
    });
});

// ── Round-trip property ───────────────────────────────────────────────────────
describe('round-trip: deduct then add same amount returns original balance', () => {
    test('deduct 50 then add 50 returns original balance', async () => {
        const originalBalance = 100;
        const amount = 50;

        // First call: deductBalance → returns 50
        mockRedis.eval.mockResolvedValueOnce(originalBalance - amount);
        const afterDeduct = await service.deductBalance('user1', amount);
        expect(afterDeduct).toBe(50);

        // Second call: addBalance → returns 100
        mockRedis.eval.mockResolvedValueOnce(afterDeduct + amount);
        const afterAdd = await service.addBalance('user1', amount);
        expect(afterAdd).toBe(originalBalance);
    });

    test('deduct 0.1 then add 0.1 returns original balance (float precision)', async () => {
        const originalBalance = 10.5;
        const amount = 0.1;

        mockRedis.eval.mockResolvedValueOnce(originalBalance - amount);
        const afterDeduct = await service.deductBalance('user1', amount);

        mockRedis.eval.mockResolvedValueOnce(afterDeduct + amount);
        const afterAdd = await service.addBalance('user1', amount);
        expect(afterAdd).toBeCloseTo(originalBalance, 5);
    });
});

// ── syncBalance / deleteBalance ───────────────────────────────────────────────
describe('syncBalance', () => {
    test('calls redis.set with stringified balance', async () => {
        mockRedis.set.mockResolvedValue('OK');
        await service.syncBalance('user1', 200.5);
        expect(mockRedis.set).toHaveBeenCalledWith('balance:user1', '200.5');
    });
});

describe('deleteBalance', () => {
    test('calls redis.del with correct key', async () => {
        mockRedis.del.mockResolvedValue(1);
        await service.deleteBalance('user1');
        expect(mockRedis.del).toHaveBeenCalledWith('balance:user1');
    });
});
