// Spending Limit Controller — lets users set and manage their own payout caps.
// Example: "don't let me spend more than $500 per day".

class SpendingLimitController {
    constructor(spendingLimitService) {
        this.spendingLimitService = spendingLimitService;
    }

    // GET /api/spending-limits — get all limits with current usage
    list = async (req, res, next) => {
        try {
            const limits = await this.spendingLimitService.getLimitsWithUsage(req.user.id);
            res.json({ success: true, limits });
        } catch (error) {
            next(error);
        }
    };

    // POST /api/spending-limits — create or update a spending limit
    set = async (req, res, next) => {
        try {
            const { period, limitAmount, currency } = req.body;

            if (!period || !limitAmount) {
                return res.status(400).json({ success: false, message: "period and limitAmount are required" });
            }

            const validPeriods = ["daily", "weekly", "monthly"];
            if (!validPeriods.includes(period)) {
                return res.status(400).json({
                    success: false,
                    message: `period must be one of: ${validPeriods.join(", ")}`,
                });
            }

            if (parseFloat(limitAmount) <= 0) {
                return res.status(400).json({ success: false, message: "limitAmount must be greater than 0" });
            }

            const limit = await this.spendingLimitService.setLimit(req.user.id, {
                period,
                limitAmount: parseFloat(limitAmount),
                currency,
                setBy: "user",
            });

            res.json({ success: true, message: "Spending limit saved", limit });
        } catch (error) {
            next(error);
        }
    };

    // DELETE /api/spending-limits/:period — remove a spending limit
    delete = async (req, res, next) => {
        try {
            const { period } = req.params;
            await this.spendingLimitService.deleteLimit(req.user.id, period);
            res.json({ success: true, message: `${period} spending limit removed` });
        } catch (error) {
            next(error);
        }
    };
}

export default SpendingLimitController;
