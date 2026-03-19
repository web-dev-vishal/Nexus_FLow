// Scheduler Controller — handles HTTP requests for scheduled payouts.
// Users can schedule a payout for a future date/time and manage their scheduled payouts.

import ScheduledPayout from "../models/scheduled-payout.model.js";

class SchedulerController {
    // POST /api/scheduled-payouts — create a new scheduled payout
    create = async (req, res, next) => {
        try {
            const userId = req.user.id;
            const { amount, currency, description, scheduledAt } = req.body;

            if (!amount || !scheduledAt) {
                return res.status(400).json({ success: false, message: "amount and scheduledAt are required" });
            }

            const scheduledDate = new Date(scheduledAt);

            // Make sure the scheduled time is in the future
            if (scheduledDate <= new Date()) {
                return res.status(400).json({ success: false, message: "scheduledAt must be a future date/time" });
            }

            const scheduled = await ScheduledPayout.create({
                userId,
                amount:      parseFloat(amount),
                currency:    currency || "USD",
                description,
                scheduledAt: scheduledDate,
            });

            res.status(201).json({
                success: true,
                message: "Payout scheduled successfully",
                scheduledPayout: scheduled,
            });
        } catch (error) {
            next(error);
        }
    };

    // GET /api/scheduled-payouts — list all scheduled payouts for the current user
    list = async (req, res, next) => {
        try {
            const { status, page = 1, limit = 20 } = req.query;
            const query = { userId: req.user.id };

            if (status) query.status = status;

            const skip = (parseInt(page) - 1) * Math.min(parseInt(limit), 100);
            const safeLimit = Math.min(parseInt(limit), 100);

            const [payouts, total] = await Promise.all([
                ScheduledPayout.find(query)
                    .sort({ scheduledAt: 1 })
                    .skip(skip)
                    .limit(safeLimit)
                    .lean(),
                ScheduledPayout.countDocuments(query),
            ]);

            res.json({
                success: true,
                scheduledPayouts: payouts,
                pagination: {
                    page:       parseInt(page),
                    limit:      safeLimit,
                    total,
                    totalPages: Math.ceil(total / safeLimit),
                },
            });
        } catch (error) {
            next(error);
        }
    };

    // GET /api/scheduled-payouts/:id — get a single scheduled payout
    get = async (req, res, next) => {
        try {
            const payout = await ScheduledPayout.findOne({
                _id:    req.params.id,
                userId: req.user.id,
            });

            if (!payout) {
                return res.status(404).json({ success: false, message: "Scheduled payout not found" });
            }

            res.json({ success: true, scheduledPayout: payout });
        } catch (error) {
            next(error);
        }
    };

    // DELETE /api/scheduled-payouts/:id — cancel a pending scheduled payout
    cancel = async (req, res, next) => {
        try {
            const payout = await ScheduledPayout.findOne({
                _id:    req.params.id,
                userId: req.user.id,
            });

            if (!payout) {
                return res.status(404).json({ success: false, message: "Scheduled payout not found" });
            }

            // Can only cancel payouts that haven't started yet
            if (payout.status !== "pending") {
                return res.status(400).json({
                    success: false,
                    message: `Cannot cancel a payout with status '${payout.status}'`,
                });
            }

            payout.status = "cancelled";
            await payout.save();

            res.json({ success: true, message: "Scheduled payout cancelled" });
        } catch (error) {
            next(error);
        }
    };
}

export default SchedulerController;
