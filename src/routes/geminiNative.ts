import express from 'express';
import requireWorkerAuth from '../middleware/workerAuth.js';
import * as geminiNativeProxyService from '../services/geminiNativeProxyService.js';

const router = express.Router();

router.use(requireWorkerAuth);

router.all('*', async (req, res, next) => {
    try {
        const result = await geminiNativeProxyService.proxyNativeRequest(req, 'v1beta');

        if (result.error) {
            return res.status(result.status || 500).json({ error: result.error });
        }

        const { response, selectedKeyId } = result;
        res.status(response.status);
        res.setHeader('X-Proxied-By', 'gemini-proxy-panel-native');
        res.setHeader('X-Selected-Key-ID', selectedKeyId);

        response.headers.forEach((value, key) => {
            const lowerKey = key.toLowerCase();
            if (
                lowerKey === 'content-encoding' ||
                lowerKey === 'content-length' ||
                lowerKey === 'transfer-encoding' ||
                lowerKey === 'connection'
            ) {
                return;
            }
            res.setHeader(key, value);
        });

        if (!response.body || typeof response.body.pipe !== 'function') {
            const text = await response.text();
            return res.send(text);
        }

        response.body.on('error', (error) => {
            console.error('Gemini native upstream stream error:', error);
            if (!res.writableEnded) {
                res.end();
            }
        });

        response.body.pipe(res);
    } catch (error) {
        next(error);
    }
});

export default router;
