import { PluginManager } from '../src/core/plugin-manager.js';

describe('execution worker local raw capture hook', () => {
  test('runs request-audit locally only for prepared upstream requests', async () => {
    const manager = new PluginManager();
    const localHook = jest.fn();
    const bridged = [];
    manager.runtimeHookBridge = { handle: jest.fn((name, value) => bridged.push([name, value])) };
    manager.register({
      name: 'request-audit',
      _enabled: true,
      hooks: {
        onUpstreamRequestPrepared: localHook,
        onContentGenerated: localHook
      }
    });

    await manager.executeHook('onUpstreamRequestPrepared', { requestId: 'one' });
    await manager.executeHook('onContentGenerated', { requestId: 'one' });

    expect(manager.runtimeHookBridge.handle).toHaveBeenCalledTimes(2);
    expect(localHook).toHaveBeenCalledTimes(1);
    expect(localHook).toHaveBeenCalledWith({ requestId: 'one' });
  });
});
