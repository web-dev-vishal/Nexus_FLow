// Scheduler Service — polls the database every minute for payouts that are due.
// When a scheduled payout's time arrives, we kick it off just like a normal payout.
// This runs inside the API gateway process (started in app.js) — no separate process needed.

import ScheduledPayout from "../models/scheduled-payout.model.js";
import logger from "../utils/logger.js";

class SchedulerService {
    constructor(payoutService) {
        // We need the payout service to actually execute the payouts
        this.payoutService = payoutService;
        this.timer = null;
        this.running = false;

        // How often to check for due payouts (default: every 60 seconds)
        this.intervalMs = parseInt(process.env.SCHEDULER_INTERVAL_MS) || 60000;
    }

    // Start the polling loop
    start() {
        if (this.running) return;
        this.running = true;

        logger.info("Scheduler started — checking for due payouts every", { intervalMs: this.intervalMs });

        // Run immediately on start, then on the interval
        this._tick();
        this.timer = setInterval(() => this._tick(), this.intervalMs);
    }

    // Stop the polling loop — called during graceful shutdown
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.running = false;
        logger.info("Scheduler stopped");
    }

    // One polling cycle — find all due payouts and process them
    async _tick() {
        try {
            // Find all pending payouts where the scheduled time has passed
            // We use findOneAndUpdate to atomically claim each one — prevents two
            // instances of the scheduler from processing the same payout
            const now = new Date();

            // Grab up to 50 due payouts per tick to avoid overloading the system
            const duePayout = await ScheduledPayout.findOneAndUpdate(
                { status: "pending", scheduledAt: { $lte: now } },
                { $set: { status: "processing" } },
                { new: true }
            );

            if (!duePayout) return; // nothing due right now

            logger.info("Processing scheduled payout", {
                scheduledPayoutId: duePayout._id,
                userId:            duePayout.userId,
                amount:            duePayout.amount,
                scheduledAt:       duePayout.scheduledAt,
            });

            await this._executeScheduledPayout(duePayout);

            // Immediately check for more — don't wait for the next interval
            // This handles the case where many payouts are due at the same time
            setImmediate(() => this._tick());
        } catch (error) {
            logger.error("Scheduler tick error:", error.message);
        }
    }

    // Execute a single scheduled payout by calling the normal payout flow
    async _executeScheduledPayout(scheduledPayout) {
        try {
            const result = await this.payoutService.initiatePayout(
                {
                    userId:      scheduledPayout.userId,
                    amount:      scheduledPayout.amount,
                    currency:    scheduledPayout.currency,
                    description: scheduledPayout.description || "Scheduled payout",
                },
                { source: "scheduler" }
            );

            // Mark the scheduled payout as completed and link the transaction
            await ScheduledPayout.updateOne(
                { _id: scheduledPayout._id },
                {
                    $set: {
                        status:        "completed",
                        transactionId: result.transactionId,
                        executedAt:    new Date(),
                    },
                }
            );

            logger.info("Scheduled payout executed", {
                scheduledPayoutId: scheduledPayout._id,
                transactionId:     result.transactionId,
            });
        } catch (error) {
            // Mark it as failed so we don't retry it endlessly
            await ScheduledPayout.updateOne(
                { _id: scheduledPayout._id },
                {
                    $set: {
                        status:        "failed",
                        failureReason: error.message || "Unknown error",
                        executedAt:    new Date(),
                    },
                }
            );

            logger.error("Scheduled payout failed", {
                scheduledPayoutId: scheduledPayout._id,
                error:             error.message,
            });
        }
    }
}

export default SchedulerService;
