import fetch from 'node-fetch';
import * as configService from './configService.js';
import * as geminiKeyService from './geminiKeyService.js';
import * as proxyPool from '../utils/proxyPool.js';

const BASE_GEMINI_URL = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';

const HOP_BY_HOP_HEADERS = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
]);

function shouldMark400Error(errorObject) {
    try {
        const errorMessage = errorObject?.error?.message || errorObject?.message;
        return !!errorMessage && errorMessage.includes('API key not valid. Please pass a valid API key.');
    } catch {
        return false;
    }
}

function inferModelCategory(modelId) {
    if (!modelId) return undefined;
    if (modelId.includes('pro')) return 'Pro';
    if (modelId.includes('flash')) return 'Flash';
    return 'Flash';
}

async function getModelCategory(modelId) {
    if (!modelId) return undefined;
    const modelsConfig = await configService.getModelsConfig();
    return modelsConfig[modelId]?.category || inferModelCategory(modelId);
}

function extractModelIdFromPath(pathname) {
    const match = pathname.match(/^\/models\/([^/:]+)(?::[^/]+)?(?:\/.*)?$/);
    return match ? decodeURIComponent(match[1]) : undefined;
}

function buildUpstreamUrl(apiVersion, path, query) {
    const upstreamUrl = new URL(`${BASE_GEMINI_URL}/${apiVersion}${path}`);

    for (const [key, value] of Object.entries(query || {})) {
        if (key === 'key') continue;
        if (Array.isArray(value)) {
            value.forEach((item) => {
                if (item !== undefined && item !== null) {
                    upstreamUrl.searchParams.append(key, String(item));
                }
            });
        } else if (value !== undefined && value !== null && typeof value !== 'object') {
            upstreamUrl.searchParams.set(key, String(value));
        }
    }

    return upstreamUrl.toString();
}

function buildForwardHeaders(req, geminiApiKey) {
    const headers: Record<string, string> = {};

    for (const [key, value] of Object.entries(req.headers)) {
        const lowerKey = key.toLowerCase();
        if (
            HOP_BY_HOP_HEADERS.has(lowerKey) ||
            lowerKey === 'host' ||
            lowerKey === 'authorization' ||
            lowerKey === 'x-goog-api-key' ||
            lowerKey === 'content-length'
        ) {
            continue;
        }

        if (Array.isArray(value)) {
            headers[key] = value.join(', ');
        } else if (value !== undefined) {
            headers[key] = String(value);
        }
    }

    headers['x-goog-api-key'] = geminiApiKey;
    if (!headers['content-type'] && req.body !== undefined && req.method !== 'GET' && req.method !== 'HEAD') {
        headers['content-type'] = 'application/json';
    }

    return headers;
}

function buildRequestBody(req) {
    if (req.method === 'GET' || req.method === 'HEAD') {
        return undefined;
    }
    if (req.body === undefined || req.body === null) {
        return undefined;
    }
    if (Buffer.isBuffer(req.body) || typeof req.body === 'string') {
        return req.body;
    }
    return JSON.stringify(req.body);
}

async function proxyNativeRequest(req, apiVersion = 'v1beta') {
    const modelId = extractModelIdFromPath(req.path);
    const selectedKey = await geminiKeyService.getNextAvailableGeminiKey(modelId, req.method !== 'GET');

    if (!selectedKey) {
        return {
            error: { message: 'No available Gemini API Key configured or all keys are currently rate-limited/invalid.' },
            status: 503,
        };
    }

    const upstreamUrl = buildUpstreamUrl(apiVersion, req.path, req.query);
    const agent = proxyPool.getNextProxyAgent();
    const fetchOptions: any = {
        method: req.method,
        headers: buildForwardHeaders(req, selectedKey.key),
        body: buildRequestBody(req),
        size: 100 * 1024 * 1024,
        timeout: 300000,
    };

    if (agent) {
        fetchOptions.agent = agent;
    }

    console.log(`Gemini native passthrough: ${req.method} /${apiVersion}${req.path}${agent ? ` via proxy ${agent.proxy.href}` : ''}`);
    const response = await fetch(upstreamUrl, fetchOptions);
    const modelCategory = await getModelCategory(modelId);

    if (response.ok && req.method !== 'GET' && modelId) {
        geminiKeyService.incrementKeyUsage(selectedKey.id, modelId, modelCategory)
            .catch(err => console.error(`Error incrementing native usage for key ${selectedKey.id}:`, err));
    } else if (!response.ok) {
        const responseClone = response.clone();
        const errorBodyText = await responseClone.text();
        let errorBody: any = { message: errorBodyText };

        try {
            errorBody = JSON.parse(errorBodyText);
        } catch {
            // Keep text fallback.
        }

        if (response.status === 429) {
            geminiKeyService.handle429Error(selectedKey.id, modelCategory, modelId, errorBody?.error || errorBody)
                .catch(err => console.error(`Error handling native 429 for key ${selectedKey.id}:`, err));
        } else if (response.status === 401 || response.status === 403) {
            geminiKeyService.recordKeyError(selectedKey.id, response.status)
                .catch(err => console.error(`Error recording native ${response.status} for key ${selectedKey.id}:`, err));
        } else if (response.status === 400 && shouldMark400Error(errorBody)) {
            geminiKeyService.recordKeyError(selectedKey.id, 400)
                .catch(err => console.error(`Error recording native 400 for key ${selectedKey.id}:`, err));
        }
    }

    return {
        response,
        selectedKeyId: selectedKey.id,
    };
}

export {
    proxyNativeRequest,
};
