import logger from '../../utils/logger.js';
import { handleModelUsageStatsRoutes } from './api-routes.js';
import {
    finalizeRequest,
    getStats,
    recordStreamChunkUsage,
    recordUnaryUsage,
    resetStats,
    resetTokenStats,
    setConfigGetter,
    shutdownStatsPersistence
} from './stats-manager.js';

const modelUsageStatsPlugin = {
    name: 'model-usage-stats',
    version: '1.0.0',
    description: '模型用量统计插件<br>接口：<code>/api/model-usage-stats</code><br>页面：<a href="model-usage-stats.html" target="_blank">model-usage-stats.html</a>',
    type: 'middleware',
    _builtin: true,
    _priority: 9000,

    async init(config) {
        setConfigGetter(() => ({
            persistDebounceMs: config.MODEL_USAGE_STATS_PERSIST_DEBOUNCE_MS,
            persistInterval: config.MODEL_USAGE_STATS_PERSIST_INTERVAL,
            maxDirtyAgeMs: config.MODEL_USAGE_STATS_MAX_DIRTY_AGE_MS
        }));
        logger.info('[Model Usage Stats] Initialized');
    },

    async destroy() {
        const persisted = await shutdownStatsPersistence();
        if (!persisted) {
            throw new Error('Failed to flush model usage stats during shutdown');
        }
        logger.info('[Model Usage Stats] Destroyed');
    },

    async middleware(req, res, requestUrl, config) {
        const aiPaths = ['/v1/chat/completions', '/v1/responses', '/v1/messages', '/v1beta/models'];
        const isAiPath = aiPaths.some(path => requestUrl.pathname.includes(path));

        if (isAiPath && req.method === 'POST' && !config._monitorRequestId) {
            config._monitorRequestId = Date.now() + Math.random().toString(36).substring(2, 10);
        }

        return { handled: false };
    },

    routes: [
        {
            method: '*',
            path: '/api/model-usage-stats',
            handler: handleModelUsageStatsRoutes
        }
    ],

    staticPaths: ['model-usage-stats.html'],

    hooks: {
        async onUnaryResponse({ requestId, model, fromProvider, toProvider, providerUuid, providerName, accountIdentity, accountEmail, nativeResponse, clientResponse }) {
            recordUnaryUsage({
                requestId,
                model,
                provider: toProvider,
                providerUuid,
                providerName,
                accountIdentity,
                accountEmail,
                fromProvider,
                nativeResponse,
                clientResponse
            });
        },

        async onStreamChunk({ requestId, model, fromProvider, toProvider, providerUuid, providerName, accountIdentity, accountEmail, nativeChunk, chunkToSend }) {
            recordStreamChunkUsage({
                requestId,
                model,
                provider: toProvider,
                providerUuid,
                providerName,
                accountIdentity,
                accountEmail,
                fromProvider,
                nativeChunk,
                clientChunk: chunkToSend
            });
        },

        async onContentGenerated(config) {
            if (config._runtimeUsage) {
                recordUnaryUsage({
                    requestId: config._monitorRequestId,
                    model: config.model,
                    provider: config.toProvider,
                    providerUuid: config.providerUuid,
                    providerName: config.providerName,
                    accountIdentity: config.accountIdentity,
                    accountEmail: config.accountEmail,
                    fromProvider: config.fromProvider,
                    nativeResponse: { usage: config._runtimeUsage }
                });
            }
            await finalizeRequest({
                requestId: config._monitorRequestId,
                model: config.model,
                provider: config.toProvider,
                providerUuid: config.providerUuid,
                providerName: config.providerName,
                accountIdentity: config.accountIdentity,
                accountEmail: config.accountEmail,
                fromProvider: config.fromProvider,
                isStream: config.isStream,
                runtimeEventId: config._runtimeEventId || null
            });
        }
    },

    exports: {
        getStats,
        resetStats,
        resetTokenStats
    }
};

export default modelUsageStatsPlugin;
export {
    getStats,
    resetStats,
    resetTokenStats
};
