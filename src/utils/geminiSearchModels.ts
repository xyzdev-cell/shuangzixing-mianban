import { MODEL_MODIFIERS, appendModelModifiers, stripModelModifiers } from './modelModifiers.js';

const DEFAULT_FREE_TIER_SEARCH_MODEL_IDS = [
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
];

function normalizeModelId(modelId: string) {
    let normalized = stripModelModifiers(modelId.trim());
    if (normalized.startsWith('models/')) {
        normalized = normalized.slice('models/'.length);
    }
    return normalized;
}

function getSearchBaseModelIds() {
    const configuredIds = process.env.GEMINI_SEARCH_MODEL_ALLOWLIST;
    const modelIds = configuredIds
        ? configuredIds.split(',').map(id => id.trim()).filter(Boolean)
        : DEFAULT_FREE_TIER_SEARCH_MODEL_IDS;

    return new Set(modelIds.map(normalizeModelId));
}

function isGeminiSearchModelSupported(modelId: string) {
    if (!modelId || modelId.startsWith('[v]')) {
        return false;
    }

    return getSearchBaseModelIds().has(normalizeModelId(modelId));
}

function getGeminiSearchModelIds(modelIds: string[]) {
    return modelIds
        .map(normalizeModelId)
        .filter((modelId, index, normalizedIds) =>
            isGeminiSearchModelSupported(modelId) &&
            normalizedIds.indexOf(modelId) === index
        )
        .map(modelId => appendModelModifiers(modelId, [MODEL_MODIFIERS.search]));
}

export {
    DEFAULT_FREE_TIER_SEARCH_MODEL_IDS,
    isGeminiSearchModelSupported,
    getGeminiSearchModelIds,
};
