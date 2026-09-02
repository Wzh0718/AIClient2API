import { describe, expect, test } from '@jest/globals';
import fs from 'fs';

describe('temporary key model route configuration', () => {
    test('ships disabled by default and documents the operations-only rule shape', () => {
        const managerSource = fs.readFileSync('src/core/config-manager.js', 'utf8');
        const example = JSON.parse(fs.readFileSync('configs/config.json.example', 'utf8'));

        expect(managerSource).toContain('temporaryKeyModelRoutes: []');
        expect(managerSource).toContain('workdayCalendars: {}');
        expect(example.workdayCalendars['cn-statutory-workday'].years['2026']).toEqual({
            holidays: [
                '2026-01-01', '2026-01-02', '2026-01-03',
                '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
                '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
                '2026-04-04', '2026-04-05', '2026-04-06',
                '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
                '2026-06-19', '2026-06-20', '2026-06-21',
                '2026-09-25', '2026-09-26', '2026-09-27',
                '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
                '2026-10-05', '2026-10-06', '2026-10-07'
            ],
            makeupWorkdays: [
                '2026-01-04', '2026-02-14', '2026-02-28',
                '2026-05-09', '2026-09-20', '2026-10-10'
            ]
        });
        expect(example.temporaryKeyModelRoutes).toEqual([
            {
                id: 'temporary-antigravity-flash',
                enabled: false,
                keyHash: 'sha256:<full-64-character-hex-digest>',
                paths: ['/openai-codex-oauth/v1/responses'],
                modelFamilies: ['gpt-5.3', 'gpt-5.4'],
                targetProviderType: 'gemini-antigravity',
                targetModel: 'gemini-2.5-flash',
                fallbackModel: 'gpt-5.6-luna',
                fallbackToOriginal: true,
                preserveResponseModel: true,
                targetBlackout: {
                    timezone: 'Asia/Shanghai',
                    calendar: 'cn-statutory-workday',
                    start: '10:00',
                    end: '19:00',
                    modelFamilies: ['gpt-5.4', 'gpt-5.3-codex-spark'],
                    fallbackProviderType: 'openai-codex-oauth',
                    fallbackModel: 'gpt-5.6-luna'
                }
            }
        ]);
        expect(JSON.stringify(example.temporaryKeyModelRoutes)).not.toContain('maki_');
    });
});
