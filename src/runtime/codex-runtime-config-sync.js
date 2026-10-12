/**
 * Codex 运行时全局开关在 control worker 与 execution worker 之间的同步。
 * 管理后台只写 control worker 的 CONFIG；execution worker 的 Codex adapter 在构造时
 * 捕获全局配置，因此需要显式下发并清理 adapter 缓存，否则开关要重启才生效。
 */

export const CODEX_RUNTIME_CONFIG_SYNC_TYPE = 'codex_runtime_config_sync';
export const CODEX_RUNTIME_CONFIG_KEYS = Object.freeze([
    'CODEX_FINGERPRINT_ENABLED',
    'CODEX_CLOAKING_ENABLED'
]);

const CODEX_ADAPTER_KEY_PREFIX = 'openai-codex-oauth';

let lastPublishedRevision = 0;
let lastAppliedRevision = 0;

export function buildCodexRuntimeConfigEvent(config = {}) {
    lastPublishedRevision = Math.max(lastPublishedRevision + 1, Date.now());
    const values = {};
    for (const key of CODEX_RUNTIME_CONFIG_KEYS) {
        if (config[key] !== undefined) values[key] = config[key];
    }
    return { type: CODEX_RUNTIME_CONFIG_SYNC_TYPE, revision: lastPublishedRevision, config: values };
}

/**
 * 应用 control worker 下发的开关值。revision 必须严格递增，旧事件被拒绝。
 */
export function applyCodexRuntimeConfigEvent(event, config, serviceInstances = {}) {
    if (!event || event.type !== CODEX_RUNTIME_CONFIG_SYNC_TYPE) {
        return { applied: false, revision: lastAppliedRevision };
    }
    const revision = Number(event.revision);
    if (!Number.isFinite(revision) || revision <= lastAppliedRevision) {
        return { applied: false, revision: lastAppliedRevision };
    }
    for (const key of CODEX_RUNTIME_CONFIG_KEYS) {
        if (event.config && event.config[key] !== undefined) config[key] = event.config[key];
    }
    let invalidated = 0;
    for (const key of Object.keys(serviceInstances)) {
        if (key.startsWith(CODEX_ADAPTER_KEY_PREFIX)) {
            delete serviceInstances[key];
            invalidated += 1;
        }
    }
    lastAppliedRevision = revision;
    return { applied: true, revision, invalidated };
}

export function resetCodexRuntimeConfigSyncForTests() {
    lastPublishedRevision = 0;
    lastAppliedRevision = 0;
}
