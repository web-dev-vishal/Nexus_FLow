import * as yup from "yup";

export const registerSchema = yup.object({
    username: yup
        .string()
        .trim()
        .min(3, "Username must be at least 3 characters")
        .required("Username is required"),
    email: yup
        .string()
        .email("Please provide a valid email")
        .required("Email is required"),
    password: yup
        .string()
        .min(6, "Password must be at least 6 characters")
        .required("Password is required"),
});

export const loginSchema = yup.object({
    email: yup
        .string()
        .email("Please provide a valid email")
        .required("Email is required"),
    password: yup.string().required("Password is required"),
});

// Middleware factory — pass any yup schema
export const validate = (schema) => async (req, res, next) => {
    try {
        await schema.validate(req.body, { abortEarly: false });
        next();
    } catch (err) {
        return res.status(400).json({
            success: false,
            errors: err.errors,
        });
    }
};
