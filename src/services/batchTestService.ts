import fetch from 'node-fetch';
import * as configService from './configService.js';
import * as geminiKeyService from './geminiKeyService.js';
import * as proxyPool from '../utils/proxyPool.js';

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

/**
 * Tests a single Gemini API key
 * @param {string} keyId - The key ID to test
 * @param {string} modelId - The model ID to test with
 * @returns {Promise<{keyId: string, success: boolean, status: number|string, error?: string}>}
 */
async function testSingleKey(keyId, modelId) {
    try {
        // Fetch the actual key from the database
        const keyInfo = await configService.getDb('SELECT api_key FROM gemini_keys WHERE id = ?', [keyId]);
        if (!keyInfo || !keyInfo.api_key) {
            return {
                keyId,
                success: false,
                status: 'not_found',
                error: `API Key with ID '${keyId}' not found or invalid.`
            };
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
        }

        const testGeminiRequestBody = { contents: [{ role: "user", parts: [{ text: "Hi" }] }] };
        const geminiUrl = `${BASE_GEMINI_URL}/v1beta/models/${modelId}:generateContent`;

        let testResponseStatus: any = 500;
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
                console.log(`Batch Test (Key ${keyId}): Sending request via proxy ${agent.proxy.href}`);
            } else {
                console.log(`Batch Test (Key ${keyId}): Sending request directly.`);
            }

            const response = await fetch(geminiUrl, fetchOptions);
            testResponseStatus = response.status;
            testResponseBody = await response.json(); // Attempt to parse JSON
            isSuccess = response.ok;

            if (isSuccess) {
                // Increment usage and sync to GitHub
                await geminiKeyService.incrementKeyUsage(keyId, modelId, modelCategory);

                // Clear error status if the key was previously marked with an error
                try {
                    const wasCleared = await geminiKeyService.clearKeyError(keyId);
                    if (wasCleared) {
                        console.log(`Batch Test: Restored key ${keyId} - cleared previous error status.`);
                    }
                } catch (clearError) {
                    // Log but don't fail the test if clearing error status fails
                    console.warn(`Batch Test: Failed to clear error status for key ${keyId}:`, clearError);
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
                        console.log(`Batch Test: Skipping error marking for key ${keyId} - 400 error not related to invalid API key.`);
                    }
                }
            }

        } catch (fetchError) {
            console.error(`Batch Test: Error testing Gemini API key ${keyId}:`, fetchError);
            testResponseBody = { error: `Fetch error: ${fetchError.message}` };
            isSuccess = false;
            testResponseStatus = 'network_error';
            // Don't assume network error means key is bad, could be temporary
        }

        return {
            keyId,
            success: isSuccess,
            status: testResponseStatus,
            error: isSuccess ? null : (testResponseBody?.error?.message || testResponseBody?.error || 'Test failed')
        };

    } catch (error) {
        console.error(`Batch Test: Error processing key ${keyId}:`, error);
        return {
            keyId,
            success: false,
            status: 'processing_error',
            error: error.message || 'Processing error'
        };
    }
}

/**
 * Runs batch test on all Gemini keys
 * @returns {Promise<{totalKeys: number, successCount: number, failureCount: number, results: Array}>}
 */
async function runBatchTest() {
    console.log('Starting automated batch test...');
    
    try {
        // Get all Gemini keys
        const keys = await geminiKeyService.getAllGeminiKeysWithUsage();
        if (!keys || keys.length === 0) {
            console.log('Batch Test: No Gemini keys found to test.');
            return {
                totalKeys: 0,
                successCount: 0,
                failureCount: 0,
                results: []
            };
        }

        const totalKeys = keys.length;
        const testModel = 'gemini-2.0-flash'; // Fixed model for testing
        const results = [];
        let successCount = 0;
        let failureCount = 0;

        console.log(`Batch Test: Testing ${totalKeys} keys with model ${testModel}`);

        // Process keys in batches to balance performance and server load
        const batchSize = 5; // Optimal batch size for testing
        for (let i = 0; i < keys.length; i += batchSize) {
            const batch = keys.slice(i, i + batchSize);
            
            console.log(`Batch Test: Processing batch ${Math.floor(i / batchSize) + 1} (${batch.length} keys)`);

            // Run tests for current batch concurrently
            const batchPromises = batch.map(key => testSingleKey(key.id, testModel));
            const batchResults = await Promise.allSettled(batchPromises);

            // Process results
            batchResults.forEach((result, index) => {
                if (result.status === 'fulfilled') {
                    const testResult = result.value;
                    results.push(testResult);
                    
                    if (testResult.success) {
                        successCount++;
                        console.log(`Batch Test: Key ${testResult.keyId} - SUCCESS`);
                    } else {
                        failureCount++;
                        console.log(`Batch Test: Key ${testResult.keyId} - FAILED (${testResult.status}): ${testResult.error}`);
                    }
                } else {
                    const keyId = batch[index].id;
                    failureCount++;
                    results.push({
                        keyId,
                        success: false,
                        status: 'promise_rejected',
                        error: result.reason?.message || 'Promise rejected'
                    });
                    console.log(`Batch Test: Key ${keyId} - PROMISE REJECTED: ${result.reason?.message}`);
                }
            });

            // Delay between batches to reduce server load
            if (i + batchSize < keys.length) {
                console.log('Batch Test: Waiting 1 second before next batch...');
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        const summary = {
            totalKeys,
            successCount,
            failureCount,
            results
        };

        console.log(`Batch Test completed: ${successCount} successful, ${failureCount} failed out of ${totalKeys} total keys.`);
        return summary;

    } catch (error) {
        console.error('Batch Test: Error during batch test execution:', error);
        throw error;
    }
}

export {
    testSingleKey,
    runBatchTest
};

