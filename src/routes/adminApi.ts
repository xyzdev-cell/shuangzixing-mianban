import express from 'express';
import requireAdminAuth from '../middleware/adminAuth.js';
import * as configService from '../services/configService.js';
import * as geminiKeyService from '../services/geminiKeyService.js';
import * as vertexProxyService from '../services/vertexProxyService.js';
import * as batchTestService from '../services/batchTestService.js';
// Note: schedulerService is imported lazily when needed to avoid database initialization issues
import fetch from 'node-fetch';
import * as dbModule from '../db/index.js';
import * as proxyPool from '../utils/proxyPool.js'; // Import the proxy pool module
import { maskSensitiveValue } from '../utils/secrets.js';
const router = express.Router();

// Apply admin authentication middleware to all /api/admin routes
router.use(requireAdminAuth);

// --- Helper for parsing request body (already exists in helpers.js, but useful here) ---
// Ensure express.json() middleware is applied in the server entrypoint
function parseBody(req) {
    if (!req.body) {
        throw new Error("Request body not parsed. Ensure express.json() middleware is used.");
    }
    return req.body;
}

// --- Gemini Key Management --- (/api/admin/gemini-keys)
router.route('/gemini-keys')
    .get(async (req, res, next) => {
        try {
            const keys = await geminiKeyService.getAllGeminiKeysWithUsage();
            res.json(keys);
        } catch (error) {
            next(error);
        }
    })
    .post(async (req, res, next) => {
        try {
            const { key, name } = parseBody(req);
             if (!key || typeof key !== 'string') {
                return res.status(400).json({ error: 'Request body must include a valid API key (string)' });
            }
            const result = await geminiKeyService.addGeminiKey(key, name);
            res.status(201).json({ success: true, ...result });
        } catch (error) {
             if (error.message.includes('duplicate API key')) {
                return res.status(409).json({ error: 'Cannot add duplicate API key' });
            }
            next(error);
        }
    });

// --- Batch Add Gemini Keys --- (/api/admin/gemini-keys/batch)
router.post('/gemini-keys/batch', async (req, res, next) => {
    try {
        const { keys } = parseBody(req);
        if (!Array.isArray(keys) || keys.length === 0) {
            return res.status(400).json({ error: 'Request body must include a valid array of API keys' });
        }

        // Validate that all items are strings
        const invalidKeys = keys.filter(key => !key || typeof key !== 'string');
        if (invalidKeys.length > 0) {
            return res.status(400).json({ error: 'All API keys must be valid strings' });
        }

        const result = await geminiKeyService.addMultipleGeminiKeys(keys);
        res.status(201).json({
            success: true,
            ...result
        });
    } catch (error) {
        next(error);
    }
});

router.delete('/gemini-keys/:id', async (req, res, next) => {
    try {
        const keyId = req.params.id;
        if (!keyId) {
             return res.status(400).json({ error: 'Missing key ID in path' });
        }
        await geminiKeyService.deleteGeminiKey(keyId);
        res.json({ success: true, id: keyId });
    } catch (error) {
         if (error.message.includes('not found')) {
            return res.status(404).json({ error: error.message });
        }
        next(error);
    }
});

// Base Gemini API URL
const BASE_GEMINI_URL = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';

// Helper function to check if a 400 error should be marked for key error
function shouldMark400Error(responseBody) {
    try {
        // Only mark 400 errors if the message indicates invalid API key
        if (responseBody && responseBody.error) {
            const errorMessage = responseBody.error.message;

            // Check for the specific "API key not valid" error
            if (errorMessage && errorMessage.includes('API key not valid. Please pass a valid API key.')) {
                return true;
            }
        }
        return false;
    } catch (e) {
        // If we can't parse the error, don't mark it
        return false;
    }
}

// --- Test Gemini Key --- (/api/admin/test-gemini-key)
router.post('/test-gemini-key', async (req, res, next) => {
     try {
        const { keyId, modelId } = parseBody(req);
        if (!keyId || !modelId) {
             return res.status(400).json({ error: 'Request body must include keyId and modelId' });
        }

        // Fetch the actual key from the database
        const keyInfo = await configService.getDb('SELECT api_key FROM gemini_keys WHERE id = ?', [keyId]);
        if (!keyInfo || !keyInfo.api_key) {
            return res.status(404).json({ error: `API Key with ID '${keyId}' not found or invalid.` });
        }
        const apiKey = keyInfo.api_key;

        // Fetch model category for potential usage increment
        const modelsConfig = await configService.getModelsConfig();
        let modelCategory = modelsConfig[modelId]?.category;

        // If model is not configured, infer category from model name
        if (!modelCategory) {
            if (modelId.includes('flash')) {
                modelCategory = 'Flash';
            } else if (modelId.includes('pro')) {
                modelCategory = 'Pro';
            } else {
                // Default to Flash for unknown models (most common case)
                modelCategory = 'Flash';
            }
            console.log(`Model ${modelId} not configured, inferred category: ${modelCategory}`);
        }

        const testGeminiRequestBody = { contents: [{ role: "user", parts: [{ text: "Hi" }] }] };
        const geminiUrl = `${BASE_GEMINI_URL}/v1beta/models/${modelId}:generateContent`;

        let testResponseStatus = 500;
        let testResponseBody = null;
        let isSuccess = false;

        try {
            // Get proxy agent
            const agent = proxyPool.getNextProxyAgent();
            const fetchOptions: any = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': apiKey
                },
                body: JSON.stringify(testGeminiRequestBody)
            };
            if (agent) {
                fetchOptions.agent = agent;
                console.log(`Admin API (Test Key): Sending request via proxy ${agent.proxy.href}`);
            } else {
                 console.log(`Admin API (Test Key): Sending request directly.`);
            }

            const response = await fetch(geminiUrl, fetchOptions);
            testResponseStatus = response.status;
            testResponseBody = await response.json(); // Attempt to parse JSON
            isSuccess = response.ok;

if (isSuccess) {
                 // Increment usage and sync to GitHub
                 await geminiKeyService.incrementKeyUsage(keyId, modelId, modelCategory);

                 // Clear error status if the key was previously marked with an error
                 // This allows previously failed keys to be restored when they work again during batch testing
                 try {
                     const wasCleared = await geminiKeyService.clearKeyError(keyId);
                     if (wasCleared) {
                         console.log(`Restored key ${keyId} - cleared previous error status during testing.`);
                     }
                 } catch (clearError) {
                     // Log but don't fail the test if clearing error status fails
                     console.warn(`Failed to clear error status for key ${keyId}:`, clearError);
                 }
            } else {
                 // Record 400/401/403 errors (invalid API key, unauthorized, forbidden)
                 // But only mark 400 errors if they indicate invalid API key
                 if (testResponseStatus === 401 || testResponseStatus === 403) {
                     await geminiKeyService.recordKeyError(keyId, testResponseStatus);
                 } else if (testResponseStatus === 400) {
                     // Check if this is an invalid API key 400 error that should be marked
                     if (shouldMark400Error(testResponseBody)) {
                         await geminiKeyService.recordKeyError(keyId, testResponseStatus);
                     } else {
                         console.log(`Skipping error marking for key ${keyId} - 400 error not related to invalid API key.`);
                     }
                 }
            }

        } catch (fetchError) {
             console.error(`Error testing Gemini API key ${keyId}:`, fetchError);
             testResponseBody = { error: `Fetch error: ${fetchError.message}` };
             isSuccess = false;
             // Don't assume network error means key is bad, could be temporary
        }

        res.status(isSuccess ? 200 : testResponseStatus).json({
            success: isSuccess,
            status: testResponseStatus,
            content: testResponseBody
        });

    } catch (error) {
        // Errors from fetching keyInfo etc.
        next(error);
    }
});

// --- Get Available Gemini Models --- (/api/admin/gemini-models)
router.get('/gemini-models', async (req, res, next) => {
     try {
         // Helper function to fetch models with a specific key
         const fetchModelsWithKey = async (key) => {
             const geminiUrl = `${BASE_GEMINI_URL}/v1beta/models`;

             // Get proxy agent
             const agent = proxyPool.getNextProxyAgent();
             const fetchOptions: any = {
                 method: 'GET',
                 headers: {
                     'Content-Type': 'application/json',
                     'x-goog-api-key': key.key
                 }
             };
             if (agent) {
                fetchOptions.agent = agent;
                console.log(`Admin API (Get Models): Sending request via proxy ${agent.proxy.href}`);
             } else {
                 console.log(`Admin API (Get Models): Sending request directly.`);
             }

             const response = await fetch(geminiUrl, fetchOptions);
             return { response, keyId: key.id };
         };

         // Try to get models with up to 3 different keys
         let lastError = null;
         for (let attempt = 1; attempt <= 3; attempt++) {
             // Find *any* valid key to make the models list request, without updating the rotation index
             // This prevents writing to the database and GitHub sync on page refreshes
             const availableKey = await geminiKeyService.getNextAvailableGeminiKey(null, false);
             if (!availableKey) {
                 console.warn(`Attempt ${attempt}: No available Gemini key found to fetch models list.`);
                 break;
             }

             console.log(`Attempt ${attempt}: Fetching models with key ${availableKey.id}`);

             try {
                 const { response, keyId } = await fetchModelsWithKey(availableKey);

                 if (response.ok) {
                     // Success! Process and return the models
                     const data = await response.json();
                     const processedModels = (data.models || [])
                        .filter(model => model.name?.startsWith('models/')) // Ensure correct format
                        .map((model) => ({
                             id: model.name.substring(7), // Extract ID
                             name: model.displayName || model.name.substring(7), // Prefer displayName
                             description: model.description,
                             // Add other potentially useful fields: supportedGenerationMethods, version, etc.
                         }));

                     console.log(`Successfully fetched ${processedModels.length} models with key ${keyId}`);
                     return res.json(processedModels);
                 } else {
                     // Handle error response
                     const errorBody = await response.text();
                     console.error(`Attempt ${attempt}: Error fetching Gemini models list (key ${keyId}): ${response.status} ${response.statusText}`, errorBody);

                     // Mark key as invalid if it's a persistent error (401/403/400)
                     if (response.status === 401 || response.status === 403) {
                         console.log(`Marking key ${keyId} as invalid due to ${response.status} error during model list fetch`);
                         await geminiKeyService.recordKeyError(keyId, response.status);
                     } else if (response.status === 400) {
                         // Check if this is an invalid API key 400 error that should be marked
                         try {
                             const errorBodyJson = JSON.parse(errorBody);
                             if (shouldMark400Error(errorBodyJson)) {
                                 console.log(`Marking key ${keyId} as invalid due to 400 error during model list fetch`);
                                 await geminiKeyService.recordKeyError(keyId, response.status);
                             } else {
                                 console.log(`Skipping error marking for key ${keyId} during model list fetch - 400 error not related to invalid API key.`);
                             }
                         } catch (parseError) {
                             // If we can't parse the error body, don't mark it as error
                             console.log(`Skipping error marking for key ${keyId} during model list fetch - unparseable 400 response`);
                         }
                     }

                     lastError = { status: response.status, body: errorBody };
                     // Continue to next attempt with a different key
                 }
             } catch (fetchError) {
                 console.error(`Attempt ${attempt}: Network error fetching models with key ${availableKey.id}:`, fetchError);
                 lastError = fetchError;
                 // Continue to next attempt
             }
         }

         // If we get here, all attempts failed
         console.warn("All attempts to fetch Gemini models failed. Returning empty list.");
         return res.json([]); // Return empty list if all attempts fail

     } catch (error) {
         console.error('Error handling /api/admin/gemini-models:', error);
         next(error);
     }
});


// --- Error Key Management ---
router.get('/error-keys', async (req, res, next) => {
    try {
        const errorKeys = await geminiKeyService.getErrorKeys();
        res.json(errorKeys);
    } catch (error) {
        next(error);
    }
});

router.post('/clear-key-error', async (req, res, next) => {
    try {
        const { keyId } = parseBody(req);
         if (!keyId || typeof keyId !== 'string') {
            return res.status(400).json({ error: 'Request body must include a valid keyId (string)' });
        }
        await geminiKeyService.clearKeyError(keyId);
        res.json({ success: true, id: keyId });
    } catch (error) {
         if (error.message.includes('not found')) {
            return res.status(404).json({ error: error.message });
        }
        next(error);
    }
});

router.delete('/error-keys', async (req, res, next) => {
    try {
        const result = await geminiKeyService.deleteAllErrorKeys();
        res.json({
            success: true,
            deletedCount: result.deletedCount,
            deletedKeys: result.deletedKeys
        });
    } catch (error) {
        next(error);
    }
});

router.post('/clear-all-errors', async (req, res, next) => {
    try {
        const result = await geminiKeyService.clearAllErrorKeys();
        res.json({
            success: true,
            clearedCount: result.clearedCount,
            clearedKeys: result.clearedKeys
        });
    } catch (error) {
        next(error);
    }
});


// --- Worker Key Management --- (/api/admin/worker-keys)
router.route('/worker-keys')
    .get(async (req, res, next) => {
        try {
            const keys = await configService.getAllWorkerKeys();
            res.json(keys);
        } catch (error) {
            next(error);
        }
    })
    .post(async (req, res, next) => {
        try {
            const { key, description } = parseBody(req);
            if (!key || typeof key !== 'string' || key.trim() === '') {
                 return res.status(400).json({ error: 'Request body must include a valid non-empty string: key' });
            }
            await configService.addWorkerKey(key.trim(), description);
            res.status(201).json({ success: true, key: key.trim() });
        } catch (error) {
            if (error.message.includes('already exists')) {
                return res.status(409).json({ error: error.message });
            }
            next(error);
        }
    });

router.delete('/worker-keys/:key', async (req, res, next) => { // Use key in path param
     try {
        const keyToDelete = decodeURIComponent(req.params.key); // Decode URL component
         if (!keyToDelete) {
             return res.status(400).json({ error: 'Missing worker key in path' });
         }
        await configService.deleteWorkerKey(keyToDelete);
        res.json({ success: true, key: keyToDelete });
    } catch (error) {
         if (error.message.includes('not found')) {
            return res.status(404).json({ error: error.message });
        }
        next(error);
    }
});

router.post('/worker-keys/safety-settings', async (req, res, next) => { // Specific path for safety
    try {
        const { key, safetyEnabled } = parseBody(req);
        if (!key || typeof key !== 'string' || typeof safetyEnabled !== 'boolean') {
            return res.status(400).json({ error: 'Request body must include key (string) and safetyEnabled (boolean)' });
        }
        await configService.updateWorkerKeySafety(key, safetyEnabled);
        res.json({ success: true, key: key, safetyEnabled: safetyEnabled });
    } catch (error) {
         if (error.message.includes('not found')) {
            return res.status(404).json({ error: error.message });
        }
        next(error);
    }
});


// --- Model Configuration Management --- (/api/admin/models)
router.route('/models')
    .get(async (req, res, next) => {
        try {
            const config = await configService.getModelsConfig();
            // Convert to array format expected by UI
            const modelList = Object.entries(config).map(([id, data]) => ({ id, ...data }));
            res.json(modelList);
        } catch (error) {
            next(error);
        }
    })
    .post(async (req, res, next) => { // Add or Update
        try {
             const { id, category, dailyQuota, individualQuota } = parseBody(req);
             if (!id || !category || !['Pro', 'Flash', 'Custom'].includes(category)) {
                 return res.status(400).json({ error: 'Request body must include valid id and category (Pro, Flash, or Custom)' });
             }
             // Basic validation for quotas (more in service layer)
             const dailyQuotaNum = (dailyQuota === null || dailyQuota === undefined || dailyQuota === '') ? null : Number(dailyQuota);
             const individualQuotaNum = (individualQuota === null || individualQuota === undefined || individualQuota === '') ? null : Number(individualQuota);

             if ((dailyQuotaNum !== null && isNaN(dailyQuotaNum)) || (individualQuotaNum !== null && isNaN(individualQuotaNum))) {
                 return res.status(400).json({ error: 'Quotas must be numbers or null/empty.' });
             }

             await configService.setModelConfig(id, category, dailyQuotaNum, individualQuotaNum);
             res.status(200).json({ success: true, id, category, dailyQuota: dailyQuotaNum, individualQuota: individualQuotaNum }); // Use 200 for add/update simplicity
        } catch (error) {
             if (error.message.includes('must be a non-negative integer')) {
                return res.status(400).json({ error: error.message });
             }
            next(error);
        }
    });

router.delete('/models/:id', async (req, res, next) => { // Use ID in path
    try {
        const modelIdToDelete = decodeURIComponent(req.params.id);
         if (!modelIdToDelete) {
             return res.status(400).json({ error: 'Missing model ID in path' });
         }
        await configService.deleteModelConfig(modelIdToDelete);
        res.json({ success: true, id: modelIdToDelete });
    } catch (error) {
        if (error.message.includes('not found')) {
            return res.status(404).json({ error: error.message });
        }
        next(error);
    }
});


// --- Category Quota Management --- (/api/admin/category-quotas)
router.route('/category-quotas')
    .get(async (req, res, next) => {
        try {
            const quotas = await configService.getCategoryQuotas();
            res.json(quotas);
        } catch (error) {
            next(error);
        }
    })
    .post(async (req, res, next) => {
        try {
            const { proQuota, flashQuota } = parseBody(req);
            // Service layer handles detailed validation
             await configService.setCategoryQuotas(proQuota, flashQuota);
             res.json({ success: true, proQuota, flashQuota });
        } catch (error) {
             if (error.message.includes('must be non-negative numbers')) {
                 return res.status(400).json({ error: error.message });
             }
            next(error);
        }
    });

// --- Vertex Configuration Management --- (/api/admin/vertex-config)
router.route('/vertex-config')
    .get(async (req, res, next) => {
        try {
            const config = await configService.getSetting('vertex_config', null);
            if (config?.expressApiKey) {
                return res.json({
                    ...config,
                    expressApiKey: maskSensitiveValue(config.expressApiKey),
                });
            }
            res.json(config);
        } catch (error) {
            next(error);
        }
    })
    .post(async (req, res, next) => {
        try {
            const { expressApiKey, vertexJson } = parseBody(req);

            // Validate that at least one authentication method is provided
            if (!expressApiKey && !vertexJson) {
                return res.status(400).json({ error: 'Either Express API Key or Vertex JSON must be provided' });
            }

            // Validate that only one authentication method is provided
            if (expressApiKey && vertexJson) {
                return res.status(400).json({ error: 'Only one authentication method can be configured at a time' });
            }

            let configData: any = {};

            if (expressApiKey) {
                // Validate Express API Key format (basic validation)
                if (typeof expressApiKey !== 'string' || expressApiKey.trim().length === 0) {
                    return res.status(400).json({ error: 'Express API Key must be a non-empty string' });
                }
                configData.expressApiKey = expressApiKey.trim();
            }

            if (vertexJson) {
                // Validate JSON format
                try {
                    const jsonData = JSON.parse(vertexJson);

                    // Basic validation of required fields
                    const requiredKeys = ["type", "project_id", "private_key_id", "private_key", "client_email", "client_id"];
                    const missingKeys = requiredKeys.filter(key => !(key in jsonData));

                    if (missingKeys.length > 0) {
                        return res.status(400).json({
                            error: `Invalid Service Account JSON. Missing required keys: ${missingKeys.join(', ')}`
                        });
                    }

                    if (jsonData.type !== "service_account") {
                        return res.status(400).json({
                            error: "Invalid Service Account JSON. 'type' must be 'service_account'"
                        });
                    }

                    configData.vertexJson = vertexJson.trim();
                } catch (e) {
                    return res.status(400).json({ error: 'Invalid JSON format for Vertex configuration' });
                }
            }

            // Save configuration to database
            await configService.setSetting('vertex_config', configData);

            // Reinitialize Vertex service with new configuration
            await vertexProxyService.reinitializeWithDatabaseConfig();

            res.json({ success: true, message: 'Vertex configuration saved successfully' });
        } catch (error) {
            next(error);
        }
    })
    .delete(async (req, res, next) => {
        try {
            // Clear the configuration
            await configService.setSetting('vertex_config', null);

            // Reinitialize Vertex service to clear configuration
            await vertexProxyService.reinitializeWithDatabaseConfig();

            res.json({ success: true, message: 'Vertex configuration cleared successfully' });
        } catch (error) {
            next(error);
        }
    });

// Test Vertex Configuration
router.post('/vertex-config/test', async (req, res, next) => {
    try {
        // Get current configuration
        const config = await configService.getSetting('vertex_config', null);

        if (!config || (!config.expressApiKey && !config.vertexJson)) {
            return res.status(400).json({ error: 'No Vertex configuration found. Please configure Vertex first.' });
        }

        // Test the configuration by checking if Vertex is enabled
        const isEnabled = vertexProxyService.isVertexEnabled();
        const supportedModels = vertexProxyService.getVertexSupportedModels();

        if (!isEnabled || supportedModels.length === 0) {
            return res.status(400).json({ error: 'Vertex configuration test failed. Service is not properly initialized.' });
        }

        res.json({
            success: true,
            message: 'Vertex configuration test successful',
            supportedModels: supportedModels.length,
            authMode: config.expressApiKey ? 'Express Mode' : 'Service Account'
        });
    } catch (error) {
        next(error);
    }
});

// --- System Settings Management --- (/api/admin/system-settings)
router.route('/system-settings')
    .get(async (req, res, next) => {
        try {
            // Get settings from database
            const keepalive = await configService.getSetting('keepalive', '0');
            const maxRetry = await configService.getSetting('max_retry', '3');
            const webSearch = await configService.getSetting('web_search', '0');
            const autoTest = await configService.getSetting('auto_test', '0');

            // Ensure consistent data types
            res.json({
                keepalive: String(keepalive), // Ensure it's a string
                maxRetry: parseInt(maxRetry) || 3,
                webSearch: String(webSearch),
                autoTest: String(autoTest)
            });
        } catch (error) {
            next(error);
        }
    })
    .post(async (req, res, next) => {
        try {
            const { keepalive, maxRetry, webSearch, autoTest } = parseBody(req);

            // Validate inputs
            if (keepalive !== '0' && keepalive !== '1') {
                return res.status(400).json({ error: 'KEEPALIVE must be "0" or "1"' });
            }

            const maxRetryNum = parseInt(maxRetry);
            if (isNaN(maxRetryNum) || maxRetryNum < 0 || maxRetryNum > 10) {
                return res.status(400).json({ error: 'MAX_RETRY must be a number between 0 and 10' });
            }

            if (webSearch !== '0' && webSearch !== '1') {
                return res.status(400).json({ error: 'WEB_SEARCH must be "0" or "1"' });
            }

            if (autoTest !== '0' && autoTest !== '1') {
                return res.status(400).json({ error: 'AUTO_TEST must be "0" or "1"' });
            }

            // Save to database (skip sync for first three, sync on the last one)
            await configService.setSetting('keepalive', keepalive, true); // Skip sync
            await configService.setSetting('max_retry', maxRetryNum.toString(), true); // Skip sync
            await configService.setSetting('web_search', webSearch, true); // Skip sync
            await configService.setSetting('auto_test', autoTest); // Trigger sync on last setting

            // Update scheduler service when auto_test setting changes
            try {
                const { default: schedulerService } = await import('../services/schedulerService.js');
                await schedulerService.updateBatchTestSchedule();
                console.log('Scheduler updated after auto_test setting change');
            } catch (schedulerError) {
                console.error('Failed to update scheduler:', schedulerError);
                // Don't fail the request if scheduler update fails
            }

            res.json({
                success: true,
                keepalive: keepalive,
                maxRetry: maxRetryNum,
                webSearch: webSearch,
                autoTest: autoTest
            });
        } catch (error) {
            next(error);
        }
    });

// --- Batch Test Management --- (/api/admin/batch-test)
router.post('/batch-test/run', async (req, res, next) => {
    try {
        console.log('Manual batch test triggered via API');
        const result = await batchTestService.runBatchTest();

        res.json({
            success: true,
            message: 'Batch test completed',
            ...result
        });
    } catch (error) {
        console.error('Error running manual batch test:', error);
        next(error);
    }
});

router.get('/batch-test/status', async (req, res, next) => {
    try {
        const { default: schedulerService } = await import('../services/schedulerService.js');
        const schedulerStatus = schedulerService.getStatus();
        const autoTestEnabled = await configService.getSetting('auto_test', '0');

        res.json({
            success: true,
            autoTestEnabled: autoTestEnabled === '1',
            schedulerStatus: schedulerStatus
        });
    } catch (error) {
        console.error('Error getting batch test status:', error);
        next(error);
    }
});


export default router;

