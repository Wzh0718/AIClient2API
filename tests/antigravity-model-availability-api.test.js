import fs from 'fs';

function readSource(path) {
    return fs.readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

describe('Antigravity model availability API wiring', () => {
    test('registers a credential-scoped POST route', () => {
        const source = readSource('src/services/ui-manager.js');

        expect(source).toContain('/model-availability');
        expect(source).toContain('handlePostAntigravityModelAvailability');
    });

    test('probes only Antigravity credentials and updates the single-instance cache', () => {
        const source = readSource('src/ui-modules/usage-api.js');

        expect(source).toContain("probeAntigravityModelAvailability");
        expect(source).toContain("providerType !== MODEL_PROVIDER.ANTIGRAVITY");
        expect(source).toContain('antigravityModelAvailability: availability');
        expect(source).toContain('await updateSingleInstanceInCache(providerType, uuid, refreshedInstanceResult)');
    });

    test('preserves the latest availability scan through usage cache fallback', () => {
        const source = readSource('src/ui-modules/usage-cache.js');

        expect(source).toContain('antigravityModelAvailability: incomingInstance.antigravityModelAvailability || cachedInstance.antigravityModelAvailability || null');
    });
});
