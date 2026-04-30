import express from 'express';
import client from 'prom-client';

// Collect default Node.js metrics (event loop lag, memory, CPU, etc.)
client.collectDefaultMetrics();

const router = express.Router();

router.get('/', async (req, res) => {
    // In production, require a Bearer token to prevent public exposure
    if (process.env.NODE_ENV === 'production') {
        const auth = req.headers.authorization;
        const token = process.env.METRICS_TOKEN;
        if (!token || auth !== `Bearer ${token}`) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
    }

    res.set('Content-Type', client.register.contentType);
    res.end(await client.register.metrics());
});

export default router;
