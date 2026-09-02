const MODEL_MODIFIERS = {
    search: 'search',
    pseudoStream: 'pseudo-stream',
    nonThinking: 'non-thinking',
} as const;

type ModelModifier = typeof MODEL_MODIFIERS[keyof typeof MODEL_MODIFIERS];

function parseModelModifiers(modelId: string) {
    let baseModelId = (modelId || '').trim();
    const modifiers: ModelModifier[] = [];

    while (true) {
        const match = baseModelId.match(/\(([^()]*)\)$/);
        if (!match) {
            break;
        }

        const modifier = match[1].trim() as ModelModifier;
        if (Object.values(MODEL_MODIFIERS).includes(modifier)) {
            modifiers.unshift(modifier);
        }
        baseModelId = baseModelId.slice(0, match.index);
    }

    return {
        baseModelId,
        modifiers,
        hasModifier: (modifier: ModelModifier) => modifiers.includes(modifier),
    };
}

function stripModelModifiers(modelId: string) {
    return parseModelModifiers(modelId).baseModelId;
}

function appendModelModifiers(modelId: string, modifiers: ModelModifier[]) {
    const parsedModelId = parseModelModifiers(modelId);
    const mergedModifiers = [...parsedModelId.modifiers];

    modifiers.forEach(modifier => {
        if (!mergedModifiers.includes(modifier)) {
            mergedModifiers.push(modifier);
        }
    });

    return `${parsedModelId.baseModelId}${mergedModifiers.map(modifier => `(${modifier})`).join('')}`;
}

export {
    MODEL_MODIFIERS,
    type ModelModifier,
    parseModelModifiers,
    stripModelModifiers,
    appendModelModifiers,
};
