/**
 * Unit tests for PayoutService.initiatePayout — focuses on error mapping.
 * Uses jest.unstable_mockModule for ESM-compatible mocking.
 */

import { describe, test, expect, jest, beforeEach } from '@jest/globals';

// ── Mock models ───────────────────────────────────────────────────────────────
const mockPayoutUser = {
    findByUserId: jest.fn(),
};

jest.unstable_mockModule('../../models/payout-user.model.js', () => ({
    default: mockPayoutUser,
}));

const mockTransaction = {
    create: jest.fn(),
    countDocuments: jest.fn(),
    findByTransactionId: jest.fn(),
};

jest.unstable_mockModule('../../models/transaction.model.js', () => ({
    default: mockTransaction,
}));

const mockAuditLog = {
    logAction: jest.fn(),
};

jest.unstable_mockModule('../../models/audit-log.model.js', () => ({
    default: mockAuditLog,
}));

// Dynamic import AFTER mocks are registered
const { default: PayoutService } = await import('../../services/payout.service.js');

// ── Mock dependencies ─────────────────────────────────────────────────────────
const makeServices = (overrides = {}) => ({
    balanceService: {
        getBalance: jest.fn().mockResolvedValue(500),
        syncBalance: jest.fn().mockResolvedValue(undefined),
        hasSufficientBalance: jest.fn().mockResolvedValue(true),
        deductBalance: jest.fn().mockResolvedValue(400),
    },
    distributedLock: {
        acquireWithRetry: jest.fn().mockResolvedValue('lock-value-123'),
        release: jest.fn().mockResolvedValue(true),
    },
    messagePublisher: {
        publishPayoutMessage: jest.fn().mockReturnValue(true),
    },
    websocketServer: {
        emitPayoutInitiated: jest.fn(),
    },
    ipValidator: {
        validateIP: jest.fn().mockResolvedValue({ suspicious: false, country: 'US', city: 'New York' }),
    },
    currencyValidator: {
        validateCurrency: jest.fn().mockResolvedValue({ valid: true, exchangeRate: 1, amountInUSD: 100 }),
    },
    groqClient: {
        scoreFraudRisk: jest.fn().mockResolvedValue({ riskScore: 10, reasoning: 'low risk', recommendation: 'approve', aiAvailable: true }),
    },
    webhookService: null,
    spendingLimitService: null,
    notificationService: null,
    ...overrides,
});

const validPayoutData = {
    userId: 'user123',
    amount: 100,
    currency: 'USD',
    description: 'Test payout',
};

const validMetadata = { ipAddress: '1.2.3.4', userAgent: 'test', source: 'api' };

const activeUser = {
    _id: 'user123',
    userId: 'user123',
    status: 'active',
    balance: 500,
    country: 'US',
    email: 'user@test.com',
    phone: '+1234567890',
};

beforeEach(() => {
    jest.clearAllMocks();
    mockAuditLog.logAction.mockResolvedValue(undefined);
    mockTransaction.create.mockResolvedValue({ transactionId: 'txn-123' });
    mockTransaction.countDocuments.mockResolvedValue(5);
});

// ── USER_NOT_FOUND ────────────────────────────────────────────────────────────
describe('initiatePayout — USER_NOT_FOUND', () => {
    test('throws USER_NOT_FOUND when PayoutUser.findByUserId returns null', async () => {
        mockPayoutUser.findByUserId.mockResolvedValue(null);
        const service = new PayoutService(makeServices());

        await expect(service.initiatePayout(validPayoutData, validMetadata))
            .rejects.toMatchObject({ code: 'USER_NOT_FOUND', statusCode: 404 });
    });
});

// ── CONCURRENT_REQUEST_DETECTED ───────────────────────────────────────────────
describe('initiatePayout — CONCURRENT_REQUEST_DETECTED', () => {
    test('throws CONCURRENT_REQUEST_DETECTED when lock.acquireWithRetry returns null', async () => {
        mockPayoutUser.findByUserId.mockResolvedValue(activeUser);
        const services = makeServices({
            distributedLock: {
                acquireWithRetry: jest.fn().mockResolvedValue(null),
                release: jest.fn(),
            },
        });
        const service = new PayoutService(services);

        await expect(service.initiatePayout(validPayoutData, validMetadata))
            .rejects.toMatchObject({ code: 'CONCURRENT_REQUEST', statusCode: 409 });
    });
});

// ── INSUFFICIENT_BALANCE ──────────────────────────────────────────────────────
describe('initiatePayout — INSUFFICIENT_BALANCE', () => {
    test('throws INSUFFICIENT_BALANCE when hasSufficientBalance returns false', async () => {
        mockPayoutUser.findByUserId.mockResolvedValue(activeUser);
        const services = makeServices({
            balanceService: {
                getBalance: jest.fn().mockResolvedValue(50),
                syncBalance: jest.fn(),
                hasSufficientBalance: jest.fn().mockResolvedValue(false),
                deductBalance: jest.fn(),
            },
        });
        const service = new PayoutService(services);

        await expect(service.initiatePayout(validPayoutData, validMetadata))
            .rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE', statusCode: 400 });
    });
});

// ── Happy path ────────────────────────────────────────────────────────────────
describe('initiatePayout — success', () => {
    test('returns success object with transactionId on happy path', async () => {
        mockPayoutUser.findByUserId.mockResolvedValue(activeUser);
        const service = new PayoutService(makeServices());

        const result = await service.initiatePayout(validPayoutData, validMetadata);

        expect(result.success).toBe(true);
        expect(result).toHaveProperty('transactionId');
        expect(result.status).toBe('initiated');
        expect(result.amount).toBe(100);
        expect(result.currency).toBe('USD');
    });

    test('publishes message to queue on success', async () => {
        mockPayoutUser.findByUserId.mockResolvedValue(activeUser);
        const services = makeServices();
        const service = new PayoutService(services);

        await service.initiatePayout(validPayoutData, validMetadata);

        expect(services.messagePublisher.publishPayoutMessage).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'user123', amount: 100, currency: 'USD' })
        );
    });

    test('emits websocket event on success', async () => {
        mockPayoutUser.findByUserId.mockResolvedValue(activeUser);
        const services = makeServices();
        const service = new PayoutService(services);

        await service.initiatePayout(validPayoutData, validMetadata);

        expect(services.websocketServer.emitPayoutInitiated).toHaveBeenCalledWith(
            'user123',
            expect.objectContaining({ status: 'initiated' })
        );
    });
});

// ── FAILED_TO_PUBLISH_MESSAGE ─────────────────────────────────────────────────
describe('initiatePayout — FAILED_TO_PUBLISH_MESSAGE', () => {
    test('throws QUEUE_ERROR when publisher returns false', async () => {
        mockPayoutUser.findByUserId.mockResolvedValue(activeUser);
        const services = makeServices({
            messagePublisher: {
                publishPayoutMessage: jest.fn().mockReturnValue(false),
            },
        });
        const service = new PayoutService(services);

        await expect(service.initiatePayout(validPayoutData, validMetadata))
            .rejects.toMatchObject({ code: 'QUEUE_ERROR', statusCode: 503 });
    });
});
