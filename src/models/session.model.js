import mongoose from "mongoose";

const sessionSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },
        // TTL: auto-delete session documents after 30 days (matches refresh token expiry)
        expiresAt: {
            type: Date,
            default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            index: { expires: 0 },
        },
    },
    { timestamps: true }
);

const Session = mongoose.model("Session", sessionSchema);

export default Session;
