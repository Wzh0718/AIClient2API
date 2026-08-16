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

  test('executes one durable usage projection and propagates its failure', async () => {
    const manager = new PluginManager();
    const potluckHook = jest.fn().mockResolvedValue(undefined);
    const modelHook = jest.fn().mockRejectedValue(new Error('model projection failed'));
    manager.register({
      name: 'api-potluck',
      _enabled: true,
      hooks: { onContentGenerated: potluckHook }
    });
    manager.register({
      name: 'model-usage-stats',
      _enabled: true,
      hooks: { onContentGenerated: modelHook }
    });

    await manager.executeUsageProjection(
      'api-potluck',
      'onContentGenerated',
      [{ requestId: 'request-one' }],
      'event-one'
    );
    await expect(manager.executeUsageProjection(
      'model-usage-stats',
      'onContentGenerated',
      [{ requestId: 'request-one' }],
      'event-one'
    )).rejects.toThrow('model projection failed');

    expect(potluckHook).toHaveBeenCalledWith({
      requestId: 'request-one',
      _runtimeEventId: 'event-one'
    });
    expect(modelHook).toHaveBeenCalledTimes(1);
  });
});
