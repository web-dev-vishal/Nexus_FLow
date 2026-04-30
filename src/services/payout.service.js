import Transaction from "../models/transaction.model.js";
import PayoutUser from "../models/payout-user.model.js";
import AuditLog from "../models/audit-log.model.js";
import logger from "../utils/logger.js";
import { generateTransactionId, roundAmount } from "../utils/helpers.js";
import {
    payoutInitiatedCounter,
    payoutFailedCounter,
    fraudBlockedCounter,
    spendingLimitBlockedCounter,
    fraudScoringDuration,
} from "../utils/metrics.js";

// Map internal error codes to HTTP-friendly responses.
// Throwing a string key (e.g. throw new Error("USER_NOT_FOUND")) keeps the
// business logic clean — the catch block handles the translation.
const ERROR_MAP = {
    USER_NOT_FOUND:               { code: "USER_NOT_FOUND",               message: "User not found",                                              statusCode: 404 },
    USER_NOT_ACTIVE:              { code: "USER_NOT_ACTIVE",               message: "User account is not active",                                  statusCode: 403 },
    INSUFFICIENT_BALANCE:         { code: "INSUFFICIENT_BALANCE",          message: "Insufficient balance for this payout",                        statusCode: 400 },
    INVALID_CURRENCY:             { code: "INVALID_CURRENCY",              message: "Invalid or unsupported currency",                             statusCode: 400 },
    CURRENCY_SERVICE_UNAVAILABLE: { code: "CURRENCY_SERVICE_UNAVAILABLE",  message: "Currency service temporarily unavailable",                    statusCode: 503 },
    HIGH_FRAUD_RISK:              { code: "HIGH_FRAUD_RISK",               message: "Transaction flagged as high risk — requires manual review",   statusCode: 403 },
    CONCURRENT_REQUEST_DETECTED:  { code: "CONCURRENT_REQUEST",            message: "Another payout is being processed. Please wait.",             statusCode: 409 },
    FAILED_TO_PUBLISH_MESSAGE:    { code: "QUEUE_ERROR",                   message: "Failed to queue payout request",                             statusCode: 503 },
    SPENDING_LIMIT_EXCEEDED:      { code: "SPENDING_LIMIT_EXCEEDED",       message: "Payout would exceed your spending limit",                     statusCode: 400 },
};

class PayoutService {
    constructor({ balanceService, distributedLock, messagePublisher, websocketServer, ipValidator, currencyValidator, groqClient, webhookService, spendingLimitService, notificationService }) {
        this.balance             = balanceService;
        this.lock                = distributedLock;
        this.publisher           = messagePublisher;
        this.ws                  = websocketServer;
        this.ipValidator         = ipValidator;
        this.currencyValidator   = currencyValidator;
        this.groq                = groqClient;
        // Optional services — only used if provided (graceful degradation)
        this.webhooks            = webhookService || null;
        this.spendingLimits      = spendingLimitService || null;
        this.notifications       = notificationService || null;
    }

    async initiatePayout(payoutData, metadata = {}) {
        const { userId, amount, currency, description } = payoutData;
        const transactionId = generateTransactionId();
        const roundedAmount = roundAmount(amount);

        // We need the lock value later to release the lock — keep it in scope
        let lockValue = null;

        try {
            // Make sure the user exists in the payout system (separate from auth)
            const user = await PayoutUser.findByUserId(userId);
            if (!user) throw new Error("USER_NOT_FOUND");

            // IP check is informational — we log suspicious IPs but don't block the payout
            const ipResult = await this.ipValidator.validateIP(metadata.ipAddress, user.country || "US");

            if (ipResult.suspicious) {
                await AuditLog.logAction(transactionId, userId, "IP_MISMATCH_DETECTED", {
                    userCountry: user.country,
                    ipCountry:   ipResult.country,
                    ipAddress:   metadata.ipAddress,
                });
                logger.warn("Suspicious IP detected", { userId, userCountry: user.country, ipCountry: ipResult.country });
            }

            // Validate the currency and get the exchange rate
            const currencyResult = await this.currencyValidator.validateCurrency(currency, roundedAmount);
            if (!currencyResult.valid) throw new Error(currencyResult.error || "INVALID_CURRENCY");

            // Acquire a distributed lock so two concurrent requests for the same user
            // can't both pass the balance check and double-spend
            lockValue = await this.lock.acquireWithRetry(
                userId,
                parseInt(process.env.LOCK_TTL_MS) || 30000,
                3,
                100
            );

            if (!lockValue) throw new Error("CONCURRENT_REQUEST_DETECTED");

            await AuditLog.logAction(transactionId, userId, "LOCK_ACQUIRED", { lockValue });

            // Check account status after acquiring the lock — status could have changed
            if (user.status !== "active") throw new Error("USER_NOT_ACTIVE");

            // Check spending limits before touching the balance
            // This prevents the payout from going through if the user is over their cap
            if (this.spendingLimits) {
                const limitCheck = await this.spendingLimits.checkLimits(userId, roundedAmount);
                if (!limitCheck.allowed) {
                    await AuditLog.logAction(transactionId, userId, "PAYOUT_FAILED", {
                        reason: "SPENDING_LIMIT_EXCEEDED",
                        detail: limitCheck.reason,
                    });
                    spendingLimitBlockedCounter.inc();
                    throw Object.assign(new Error("SPENDING_LIMIT_EXCEEDED"), { detail: limitCheck });
                }
            }

            // Sync balance from MongoDB to Redis on first access
            let balance = await this.balance.getBalance(userId);
            if (balance === null) {
                await this.balance.syncBalance(userId, user.balance);
                balance = user.balance;
            }

            const hasFunds = await this.balance.hasSufficientBalance(userId, roundedAmount);
            if (!hasFunds) throw new Error("INSUFFICIENT_BALANCE");

            // AI fraud scoring — uses transaction history to assess risk
            const txCount = await Transaction.countDocuments({ userId });
            const fraudTimerEnd = fraudScoringDuration.startTimer();
            const fraudScore = await this.groq.scoreFraudRisk({
                userId,
                amount:           roundedAmount,
                currency,
                ipCountry:        ipResult.country,
                userCountry:      user.country || "US",
                transactionCount: txCount,
            });
            fraudTimerEnd();

            await AuditLog.logAction(transactionId, userId, "FRAUD_SCORE_CALCULATED", {
                riskScore:      fraudScore.riskScore,
                reasoning:      fraudScore.reasoning,
                recommendation: fraudScore.recommendation,
                aiAvailable:    fraudScore.aiAvailable,
            });

            // Block high-risk transactions — they go to manual review
            const riskThreshold = parseInt(process.env.FRAUD_RISK_THRESHOLD) || 70;
            if (fraudScore.riskScore >= riskThreshold) {
                await AuditLog.logAction(transactionId, userId, "HIGH_FRAUD_RISK_DETECTED", {
                    riskScore: fraudScore.riskScore,
                    threshold: riskThreshold,
                });
                fraudBlockedCounter.inc();
                throw new Error("HIGH_FRAUD_RISK");
            }

            // Create transaction record
            const transaction = await Transaction.create({
                transactionId,
                userId,
                amount:        roundedAmount,
                currency,
                status:        "initiated",
                type:          "payout",
                balanceBefore: balance,
                balanceAfter:  balance - roundedAmount,
                metadata: {
                    ipAddress:    metadata.ipAddress,
                    userAgent:    metadata.userAgent,
                    source:       metadata.source || "api",
                    description,
                    ipCountry:    ipResult.country,
                    ipCity:       ipResult.city,
                    exchangeRate: currencyResult.exchangeRate,
                    amountInUSD:  currencyResult.amountInUSD,
                },
                processingDetails: {
                    initiatedAt:  new Date(),
                    fraudScore:   fraudScore.riskScore,
                    fraudReasoning: fraudScore.reasoning,
                    ipSuspicious: ipResult.suspicious,
                },
                lockInfo: { lockAcquired: true },
            });

            await AuditLog.logAction(transactionId, userId, "PAYOUT_INITIATED", {
                amount:     roundedAmount,
                currency,
                balance,
                fraudScore: fraudScore.riskScore,
            });

            // Publish to RabbitMQ — the worker picks this up and does the actual deduction
            const published = this.publisher.publishPayoutMessage({
                transactionId,
                userId,
                amount:    roundedAmount,
                currency,
                lockValue,
                metadata:  { source: metadata.source || "api", description },
            });

            if (!published) throw new Error("FAILED_TO_PUBLISH_MESSAGE");

            await AuditLog.logAction(transactionId, userId, "MESSAGE_PUBLISHED", { queue: "payout_queue" });

            this.ws.emitPayoutInitiated(userId, {
                transactionId,
                amount:    roundedAmount,
                currency,
                status:    "initiated",
                timestamp: new Date().toISOString(),
            });

            // Fire webhook and notification in the background — don't await them
            // A failed webhook/notification should never block or fail the payout
            const eventPayload = { transactionId, amount: roundedAmount, currency, userId };

            if (this.webhooks) {
                this.webhooks.deliverEvent(userId, "payout.initiated", eventPayload)
                    .catch((err) => logger.error("Webhook delivery error (initiated):", err.message));
            }

            if (this.notifications) {
                this.notifications.notifyPayoutInitiated(
                    { email: user.email, phone: user.phone },
                    { transactionId, amount: roundedAmount, currency }
                ).catch((err) => logger.error("Notification error (initiated):", err.message));
            }

            logger.info("Payout initiated", { transactionId, userId, amount: roundedAmount, fraudScore: fraudScore.riskScore });

            // Increment business metric
            payoutInitiatedCounter.inc({ currency, source: metadata.source || "api" });

            return {
                success:       true,
                transactionId,
                status:        "initiated",
                amount:        roundedAmount,
                currency,
                message:       "Payout request initiated successfully",
                fraudScore:    fraudScore.riskScore,
            };
        } catch (error) {
            logger.error("Payout initiation failed", { userId, transactionId, error: error.message });

            // Always release the lock on failure — otherwise the user is stuck until TTL expires
            if (lockValue) {
                await this.lock.release(userId, lockValue);
                await AuditLog.logAction(transactionId, userId, "LOCK_RELEASED", { reason: "error" });
            }

            // Map known error strings to structured HTTP responses
            const mapped = ERROR_MAP[error.message] || {
                code:       "INTERNAL_ERROR",
                message:    "An error occurred while processing your request",
                statusCode: 500,
            };

            // Increment failure metric — label by error code for dashboard breakdown
            payoutFailedCounter.inc({ reason: mapped.code });

            throw { ...mapped, originalError: error.message };
        }
    }

    async getTransactionStatus(transactionId) {
        const transaction = await Transaction.findByTransactionId(transactionId);

        if (!transaction) {
            throw { code: "TRANSACTION_NOT_FOUND", message: "Transaction not found", statusCode: 404 };
        }

        return {
            success: true,
            transaction: {
                transactionId:     transaction.transactionId,
                userId:            transaction.userId,
                amount:            transaction.amount,
                currency:          transaction.currency,
                status:            transaction.status,
                createdAt:         transaction.createdAt,
                processingDetails: transaction.processingDetails,
            },
        };
    }

    async getUserBalance(userId) {
        let balance = await this.balance.getBalance(userId);

        if (balance === null) {
            const user = await PayoutUser.findByUserId(userId);
            if (!user) {
                throw { code: "USER_NOT_FOUND", message: "User not found", statusCode: 404 };
            }
            balance = user.balance;
            await this.balance.syncBalance(userId, balance);
        }

        return { success: true, userId, balance, currency: "USD" };
    }
}

export default PayoutService;
