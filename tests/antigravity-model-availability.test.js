import { describe, expect, jest, test } from '@jest/globals';
import {
    classifyAntigravityProbeError,
    probeAntigravityModelAvailability
} from '../src/services/antigravity-model-availability.js';

describe('Antigravity model availability probe', () => {
    test('tests listed models serially and skips an active model cooldown', async () => {
        const active = [];
        let maxActive = 0;
        const adapter = {
            listModels: jest.fn().mockResolvedValue({
                models: [
                    { name: 'models/gemini-3-flash' },
                    { name: 'models/gemini-2.5-flash' },
                    { name: 'models/gemini-3.1-pro-high' }
                ]
            }),
            generateContent: jest.fn(async model => {
                active.push(model);
                maxActive = Math.max(maxActive, active.length);
                await new Promise(resolve => setTimeout(resolve, 5));
                active.pop();
                return { candidates: [{ content: { parts: [{ text: 'OK' }] } }] };
            })
        };
        const recoveryTime = '2026-08-24T06:23:59.000Z';

        const result = await probeAntigravityModelAvailability({
            adapter,
            quotaHealth: {
                models: {
                    'gemini-2.5-flash': {
                        isHealthy: false,
                        scheduledRecoveryTime: recoveryTime,
                        lastErrorMessage: '429 Too Many Requests - model cooldown'
                    }
                }
            },
            now: new Date('2026-08-24T02:20:00.000Z'),
            delayMs: 0
        });

        expect(maxActive).toBe(1);
        expect(adapter.generateContent).toHaveBeenCalledTimes(2);
        expect(result).toMatchObject({
            totalModels: 3,
            availableModels: 2,
            availabilityPercent: 66.7
        });
        expect(result.models).toEqual([
            expect.objectContaining({ model: 'gemini-3-flash', status: 'available' }),
            expect.objectContaining({
                model: 'gemini-2.5-flash',
                status: 'cooldown',
                scheduledRecoveryTime: recoveryTime
            }),
            expect.objectContaining({ model: 'gemini-3.1-pro-high', status: 'available' })
        ]);
    });

    test('classifies temporary capacity and model errors without exposing response bodies', () => {
        const capacity = Object.assign(new Error('No capacity available for model; secret-response-body'), {
            response: { status: 503 }
        });
        const unsupported = Object.assign(new Error('Requested entity was not found'), {
            response: { status: 404 }
        });

        expect(classifyAntigravityProbeError(capacity)).toEqual(expect.objectContaining({
            status: 'capacity',
            httpStatus: 503
        }));
        expect(classifyAntigravityProbeError(capacity).message).not.toContain('secret-response-body');
        expect(classifyAntigravityProbeError(unsupported)).toEqual(expect.objectContaining({
            status: 'unsupported',
            httpStatus: 404
        }));
    });

    test('records a 429 as cooldown with the supplied recovery time', async () => {
        const recoveryTime = '2026-08-24T06:23:59.000Z';
        const error = Object.assign(new Error('quota exhausted'), {
            response: { status: 429 },
            scheduledRecoveryTime: recoveryTime
        });
        const adapter = {
            listModels: jest.fn().mockResolvedValue({ models: [{ name: 'gemini-3-flash' }] }),
            generateContent: jest.fn().mockRejectedValue(error)
        };

        const result = await probeAntigravityModelAvailability({ adapter, delayMs: 0 });

        expect(result.availableModels).toBe(0);
        expect(result.models[0]).toEqual(expect.objectContaining({
            model: 'gemini-3-flash',
            status: 'cooldown',
            scheduledRecoveryTime: recoveryTime
        }));
    });
});
