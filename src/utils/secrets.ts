function maskSensitiveValue(value) {
    if (typeof value !== 'string' || value.length === 0) {
        return '...';
    }

    return `...${value.slice(-4)}`;
}

export {
    maskSensitiveValue,
};
