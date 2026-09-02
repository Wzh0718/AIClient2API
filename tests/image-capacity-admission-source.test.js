import fs from 'fs';
import path from 'path';

describe('image capacity admission order', () => {
    test('generation and edit reserve capacity before provider selection and never acquire after output', () => {
        const source = fs.readFileSync(path.join(process.cwd(), 'src/services/api-manager.js'), 'utf8').replace(/\r\n/g, '\n');
        const generation = source.slice(
            source.indexOf('async function handleImageGenerationRequest'),
            source.indexOf('function extractAssistantRejectionText')
        );
        const edits = source.slice(
            source.indexOf('async function handleImageEditsRequest'),
            source.indexOf('function extractImagesFromServiceResponse')
        );

        expect(generation.indexOf('runtimeImageCapacity.acquire')).toBeGreaterThan(0);
        expect(generation.indexOf('runtimeImageCapacity.acquire')).toBeLessThan(generation.indexOf('getApiServiceWithFallback'));
        expect(generation).toContain('await runtimeImageCapacity.resize(capacityTicket');
        expect(generation).toContain("slotProviderType !== 'gemini-antigravity'");

        expect(edits.indexOf('runtimeImageCapacity.acquire')).toBeGreaterThan(0);
        expect(edits.indexOf('runtimeImageCapacity.acquire')).toBeLessThan(edits.indexOf('buffer.toString(\'base64\')'));
        expect(edits.indexOf('runtimeImageCapacity.acquire')).toBeLessThan(edits.indexOf('getApiServiceWithFallback'));
        expect(edits).toContain('await runtimeImageCapacity.resize(capacityTicket');
    });
});
