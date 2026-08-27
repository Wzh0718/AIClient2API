import { describe, expect, test } from '@jest/globals';
import { CodexConverter } from '../src/converters/strategies/CodexConverter.js';

describe('Codex response service tier', () => {
    test('preserves the upstream service_tier in non-stream OpenAI Responses output', () => {
        const converter = new CodexConverter();
        const converted = converter.toOpenAIResponsesResponse({
            type: 'response.completed',
            response: {
                id: 'resp_test',
                model: 'gpt-5.6-sol',
                status: 'completed',
                service_tier: 'priority',
                output: [],
                usage: {
                    input_tokens: 1,
                    output_tokens: 1,
                    total_tokens: 2
                }
            }
        }, 'gpt-5.6-sol');

        expect(converted.service_tier).toBe('priority');
    });
});
