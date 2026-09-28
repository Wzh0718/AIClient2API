import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GptRequestStore } from '../src/plugins/request-audit/gpt-request-store.js';
import { handleRequestAuditRoutes, setGptRequestStore } from '../src/plugins/request-audit/api-routes.js';
import { hashSecret } from '../src/plugins/request-audit/audit-event.js';

test('GLM usage API returns one detail per configured key and a separate historical node', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-usage-api-'));
    const poolsPath = path.join(dir, 'pools.json');
    const store = await new GptRequestStore({ dbPath: ':memory:' }).init();
    try {
        fs.writeFileSync(poolsPath, JSON.stringify({ 'glm-coding-plan': [
            { uuid: 'key-a', customName: 'same', GLM_API_KEY: 'secret-a' },
            { uuid: 'key-b', customName: 'same', GLM_API_KEY: 'secret-b' },
            { uuid: 'key-c', customName: 'unused', GLM_API_KEY: 'secret-c' }
        ] }));
        for (const [id, uuid] of [['a', 'key-a'], ['b', 'key-b'], ['old', 'deleted']]) {
            store.append({ eventId: id, requestId: id, timestamp: new Date().toISOString(),
                request: { toProvider: 'glm-coding-plan' }, account: { providerUuidHash: hashSecret(uuid) },
                status: { outcome: 'success' }, usage: { totalTokens: 5 } });
        }
        setGptRequestStore(store);
        const res = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
        await handleRequestAuditRoutes('GET', '/api/request-audit/glm-usage',
            { url: '/api/request-audit/glm-usage', headers: {} }, res,
            { _requestAuditSkipAuth: true, PROVIDER_POOLS_FILE_PATH: poolsPath });
        expect(res.status).toBe(200);
        expect(res.body.data.nodes.map(node => node.periods.today?.requestCount || 0)).toEqual([1, 1, 0]);
        expect(res.body.data.historical).toHaveLength(1);
        expect(res.body.data.total.today.requestCount).toBe(3);
        expect(JSON.stringify(res.body)).not.toMatch(/secret-[abc]/);
    } finally {
        setGptRequestStore(null);
        store.close();
        fs.rmSync(dir, { recursive: true });
    }
});
