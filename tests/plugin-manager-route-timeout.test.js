import { PluginManager } from '../src/core/plugin-manager.js';

function responseMock() {
    return {
        headersSent: false,
        writableEnded: false,
        statusCode: null,
        body: '',
        writeHead(statusCode) {
            if (this.headersSent) throw new Error('headers already sent');
            this.headersSent = true;
            this.statusCode = statusCode;
        },
        end(body = '') {
            if (this.writableEnded) throw new Error('response already ended');
            this.body += body;
            this.writableEnded = true;
        }
    };
}

describe('PluginManager route timeout handling', () => {
    test('terminates a timed-out route without falling through to another auth path', async () => {
        const manager = new PluginManager();
        const res = responseMock();
        let lateHandlerCompleted = false;
        const plugin = {
            name: 'slow-plugin',
            _enabled: true,
            routes: [{
                method: 'PUT',
                path: '/api/slow',
                operationTimeoutMs: 10,
                handler: async (_method, _path, _req, response) => {
                    await new Promise(resolve => setTimeout(resolve, 30));
                    if (!response.writableEnded) response.writeHead(200);
                    lateHandlerCompleted = true;
                    return true;
                }
            }]
        };
        manager.plugins = new Map([[plugin.name, plugin]]);

        await expect(manager.executeRoutes('PUT', '/api/slow', {}, res, {})).resolves.toBe(true);
        expect(res.statusCode).toBe(504);
        await new Promise(resolve => setTimeout(resolve, 40));
        expect(lateHandlerCompleted).toBe(true);
        expect(res.statusCode).toBe(504);
    });
});
