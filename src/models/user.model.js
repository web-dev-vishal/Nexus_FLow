// This is the User model — it defines what a user looks like in the database.
// This model is only for authentication (login, register, email verify).
// Payout-specific data (balance, country) lives in the PayoutUser model.

import mongoose from "mongoose";
import bcrypt from "bcryptjs";

// Define the shape of a user document in MongoDB
const userSchema = new mongoose.Schema(
    {
        username: {
            type:     String,
            required: [true, "Username is required"],
            trim:     true, // remove leading/trailing spaces automatically
        },
        email: {
            type:      String,
            required:  [true, "Email is required"],
            unique:    true,      // no two users can have the same email
            lowercase: true,      // always store emails in lowercase
            trim:      true,
        },
        password: {
            type:      String,
            required:  [true, "Password is required"],
            minlength: [6, "Password must be at least 6 characters long"],
            // Note: we never store the plain password — the pre-save hook hashes it
        },
        role: {
            type:    String,
            enum:    ["customer", "admin"], // only these two values are allowed
            default: "customer",            // everyone starts as a regular customer
        },
        isVerified: {
            type:    Boolean,
            default: false, // users must verify their email before they can log in
        },
    },
    {
        timestamps: true, // automatically adds createdAt and updatedAt fields
    }
);

// ── Password hashing ──────────────────────────────────────────────────────────
// This hook runs automatically before every save() call.
// If the password field was changed (new user or password reset), we hash it.
// We never store plain text passwords — only the bcrypt hash.
userSchema.pre("save", async function (next) {
    // If the password wasn't changed, skip hashing — no need to re-hash on every save
    if (!this.isModified("password")) return next();

    try {
        // Salt rounds = 10 is the standard — higher is more secure but slower
        const salt = await bcrypt.genSalt(10);
        this.password = await bcrypt.hash(this.password, salt);
        next();
    } catch (error) {
        next(error);
    }
});

// ── Instance method: compare passwords ───────────────────────────────────────
// Used during login to check if the entered password matches the stored hash.
// bcrypt.compare handles the salt automatically — we just pass both strings.
userSchema.methods.comparePassword = async function (password) {
    return bcrypt.compare(password, this.password);
};

// Create and export the model
const User = mongoose.model("User", userSchema);

export default User;
