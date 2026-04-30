// Notification input validators — Zod schemas for notification-related request bodies.

import { z } from "zod";
import { validate } from "./user.validate.js";

export const updatePreferencesSchema = z.object({
    email: z.boolean().optional(),
    push: z.boolean().optional(),
    sms: z.boolean().optional(),
}).refine(data => Object.keys(data).length > 0, {
    message: "Provide at least one preference to update",
});

export const markReadSchema = z.object({
    notificationIds: z.array(z.string().min(1)).min(1, "Provide at least one notification ID"),
});

export { validate };
