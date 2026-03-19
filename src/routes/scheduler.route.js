// Scheduler routes — create and manage scheduled payouts.
// All routes require authentication.

import express from "express";
import { isAuthenticated } from "../middleware/auth.middleware.js";

const createSchedulerRouter = (schedulerController) => {
    const router = express.Router();

    router.use(isAuthenticated);

    router.post("/",        schedulerController.create);
    router.get("/",         schedulerController.list);
    router.get("/:id",      schedulerController.get);
    router.delete("/:id",   schedulerController.cancel);

    return router;
};

export default createSchedulerRouter;
