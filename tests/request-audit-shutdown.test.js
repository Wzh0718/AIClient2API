import plugin from '../src/plugins/request-audit/index.js';
import logger from '../src/utils/logger.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(expectation, timeoutMs = 1000) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      expectation();
      return;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

async function settlementWithin(promise, timeoutMs = 25) {
  return Promise.race([
    promise.then(() => 'fulfilled', () => 'rejected'),
    new Promise(resolve => setTimeout(() => resolve('pending'), timeoutMs))
  ]);
}

function requestContext(requestId, input = 'safe audit input') {
  return {
    _monitorRequestId: requestId,
    originalRequestBody: { model: 'gpt-5.5', input },
    model: 'gpt-5.5',
    toProvider: 'openai-codex-oauth'
  };
}

function usageResponse(promptTokens) {
  return {
    usage: {
      prompt_tokens: promptTokens,
      total_tokens: promptTokens
    }
  };
}

async function initPlugin(auditStore, rawCaptureStore = { cleanup: jest.fn(async () => {}) }) {
  await plugin.init({
    REQUEST_AUDIT_ENABLED: true,
    REQUEST_AUDIT_ANALYZER_ENABLED: false,
    _requestAuditStore: auditStore,
    _requestAuditRawCaptureStore: rawCaptureStore
  });
}

describe('request audit shutdown drain', () => {
  afterEach(async () => {
    await plugin.destroy().catch(() => {});
  });

  test('destroy stops accepting new audit contexts before cleanup begins', async () => {
    const auditStore = {
      append: jest.fn(async () => {}),
      cleanup: jest.fn(async () => {})
    };
    await initPlugin(auditStore);

    await plugin.destroy();
    await plugin.hooks.onUnaryResponse({
      requestId: 'after-destroy',
      nativeResponse: { usage: { prompt_tokens: 10, total_tokens: 10 } }
    });
    await plugin.hooks.onContentGenerated(requestContext('after-destroy'));
    await new Promise(resolve => setImmediate(resolve));

    expect(auditStore.append).not.toHaveBeenCalled();
  });

  test('destroy waits for the active append and drains every queued audit event', async () => {
    const firstAppend = deferred();
    const auditStore = {
      append: jest.fn()
        .mockImplementationOnce(() => firstAppend.promise)
        .mockResolvedValue(undefined),
      cleanup: jest.fn(async () => {})
    };
    await initPlugin(auditStore);

    await plugin.hooks.onContentGenerated(requestContext('drain-1'));
    await waitFor(() => expect(auditStore.append).toHaveBeenCalledTimes(1));
    await plugin.hooks.onContentGenerated(requestContext('drain-2'));

    const destroyPromise = plugin.destroy();
    try {
      expect(await settlementWithin(destroyPromise)).toBe('pending');
    } finally {
      firstAppend.resolve();
      await destroyPromise.catch(() => {});
    }

    expect(auditStore.append).toHaveBeenCalledTimes(2);
    expect(auditStore.append.mock.calls.map(([event]) => event.requestId)).toEqual([
      'drain-1',
      'drain-2'
    ]);
  });

  test('destroy reports an append failure instead of silently losing the audit event', async () => {
    const auditStore = {
      append: jest.fn(async () => {
        throw new Error('simulated append failure');
      }),
      cleanup: jest.fn(async () => {})
    };
    await initPlugin(auditStore);

    await plugin.hooks.onContentGenerated(requestContext('append-failure'));
    await waitFor(() => expect(auditStore.append).toHaveBeenCalledTimes(1));

    await expect(plugin.destroy()).rejects.toThrow(/lost 1 audit event/i);
  });

  test('destroy reports queue overflow after persisting every event that fit in the bounded queue', async () => {
    const firstAppend = deferred();
    const auditStore = {
      append: jest.fn()
        .mockImplementationOnce(() => firstAppend.promise)
        .mockResolvedValue(undefined),
      cleanup: jest.fn(async () => {})
    };
    await initPlugin(auditStore);

    await plugin.hooks.onContentGenerated(requestContext('overflow-active'));
    await waitFor(() => expect(auditStore.append).toHaveBeenCalledTimes(1));
    for (let index = 0; index < 1001; index += 1) {
      const input = index === 1000 ? 'secret-that-must-not-appear-in-shutdown-errors' : 'safe';
      await plugin.hooks.onContentGenerated(requestContext(`overflow-${index}`, input));
    }

    const destroyPromise = plugin.destroy();
    firstAppend.resolve();

    let shutdownError;
    try {
      await destroyPromise;
    } catch (error) {
      shutdownError = error;
    }
    expect(shutdownError).toBeInstanceOf(Error);
    expect(shutdownError.message).toMatch(/lost 1 audit event/i);
    expect(String(shutdownError)).not.toContain('secret-that-must-not-appear-in-shutdown-errors');
    expect(auditStore.append).toHaveBeenCalledTimes(1001);
  });

  test('repeated destroy calls safely await the same in-progress drain', async () => {
    const append = deferred();
    const auditStore = {
      append: jest.fn(() => append.promise),
      cleanup: jest.fn(async () => {})
    };
    await initPlugin(auditStore);

    await plugin.hooks.onContentGenerated(requestContext('repeat-safe'));
    await waitFor(() => expect(auditStore.append).toHaveBeenCalledTimes(1));

    const firstDestroy = plugin.destroy();
    const secondDestroy = plugin.destroy();
    try {
      expect(await settlementWithin(Promise.all([firstDestroy, secondDestroy]))).toBe('pending');
    } finally {
      append.resolve();
      await Promise.allSettled([firstDestroy, secondDestroy]);
    }

    expect(auditStore.append).toHaveBeenCalledTimes(1);
  });

  test('destroy cancels an analyzer run that was only scheduled during init', async () => {
    const auditStore = {
      append: jest.fn(async () => {}),
      cleanup: jest.fn(async () => {}),
      query: jest.fn(async () => [])
    };
    const analysisStore = {
      writeDiagnostics: jest.fn(async () => {})
    };
    await plugin.init({
      REQUEST_AUDIT_ENABLED: true,
      REQUEST_AUDIT_ANALYZER_ENABLED: true,
      REQUEST_AUDIT_ANALYZER_RUN_ON_INIT: true,
      _requestAuditStore: auditStore,
      _requestAuditAnalysisStore: analysisStore,
      _requestAuditRawCaptureStore: { cleanup: jest.fn(async () => {}) }
    });

    await plugin.destroy();
    await new Promise(resolve => setImmediate(resolve));

    expect(auditStore.query).not.toHaveBeenCalled();
  });

  test('destroy waits for an analyzer run that already started', async () => {
    const query = deferred();
    const auditStore = {
      append: jest.fn(async () => {}),
      cleanup: jest.fn(async () => {}),
      query: jest.fn(() => query.promise)
    };
    const analysisStore = {
      writeDiagnostics: jest.fn(async () => {})
    };
    await plugin.init({
      REQUEST_AUDIT_ENABLED: true,
      REQUEST_AUDIT_ANALYZER_ENABLED: true,
      REQUEST_AUDIT_ANALYZER_RUN_ON_INIT: true,
      _requestAuditStore: auditStore,
      _requestAuditAnalysisStore: analysisStore,
      _requestAuditRawCaptureStore: { cleanup: jest.fn(async () => {}) }
    });
    await waitFor(() => expect(auditStore.query).toHaveBeenCalledTimes(1));

    const destroyPromise = plugin.destroy();
    try {
      expect(await settlementWithin(destroyPromise)).toBe('pending');
    } finally {
      query.resolve([]);
      await destroyPromise;
    }

    expect(analysisStore.writeDiagnostics).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['query', 'secret query details'],
    ['writeDiagnostics', 'secret diagnostics details']
  ])('destroy reports fixed analyzer failure when %s fails', async (failurePoint, sensitiveMessage) => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const auditStore = {
      append: jest.fn(async () => {}),
      cleanup: jest.fn(async () => {}),
      query: failurePoint === 'query'
        ? jest.fn(async () => { throw new Error(sensitiveMessage); })
        : jest.fn(async () => [])
    };
    const analysisStore = {
      writeDiagnostics: failurePoint === 'writeDiagnostics'
        ? jest.fn(async () => { throw new Error(sensitiveMessage); })
        : jest.fn(async () => {})
    };
    try {
      await plugin.init({
        REQUEST_AUDIT_ENABLED: true,
        REQUEST_AUDIT_ANALYZER_ENABLED: true,
        REQUEST_AUDIT_ANALYZER_RUN_ON_INIT: true,
        _requestAuditStore: auditStore,
        _requestAuditAnalysisStore: analysisStore,
        _requestAuditRawCaptureStore: { cleanup: jest.fn(async () => {}) }
      });
      await waitFor(() => expect(auditStore.query).toHaveBeenCalledTimes(1));
      if (failurePoint === 'writeDiagnostics') {
        await waitFor(() => expect(analysisStore.writeDiagnostics).toHaveBeenCalledTimes(1));
      }

      const shutdownError = await plugin.destroy().then(
        () => null,
        error => error
      );

      expect(shutdownError).toBeInstanceOf(Error);
      expect(shutdownError.message).toMatch(/analyzer failure/i);
      expect(shutdownError.message).not.toContain(sensitiveMessage);
      expect(warn).toHaveBeenCalledWith('[Request Audit] analyzer failure');
      expect(JSON.stringify(warn.mock.calls)).not.toContain(sensitiveMessage);
    } finally {
      warn.mockRestore();
    }
  });

  test('destroy waits for cleanup work that already started', async () => {
    const cleanup = deferred();
    const auditStore = {
      append: jest.fn(async () => {}),
      cleanup: jest.fn(async () => {})
    };
    const rawCaptureStore = {
      cleanup: jest.fn(() => cleanup.promise)
    };
    await initPlugin(auditStore, rawCaptureStore);
    await waitFor(() => expect(rawCaptureStore.cleanup).toHaveBeenCalledTimes(1));

    const destroyPromise = plugin.destroy();
    try {
      expect(await settlementWithin(destroyPromise)).toBe('pending');
    } finally {
      cleanup.resolve();
      await destroyPromise;
    }
  });

  test('cleanup drains every sibling before reporting fixed cleanup failures', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'setTimeout'] });
    const rawCleanup = deferred();
    const auditStore = {
      append: jest.fn(async () => {}),
      cleanup: jest.fn(async () => {
        throw new Error('sensitive audit cleanup failure');
      })
    };
    const rawCaptureStore = {
      cleanup: jest.fn()
        .mockResolvedValueOnce(undefined)
        .mockImplementationOnce(() => rawCleanup.promise)
    };
    try {
      await initPlugin(auditStore, rawCaptureStore);
      await new Promise(resolve => setImmediate(resolve));
      await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
      await waitFor(() => expect(auditStore.cleanup).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(rawCaptureStore.cleanup).toHaveBeenCalledTimes(2));

      const destroyPromise = plugin.destroy();
      expect(await settlementWithin(destroyPromise)).toBe('pending');
      rawCleanup.resolve();
      const shutdownError = await destroyPromise.then(
        () => null,
        error => error
      );

      expect(shutdownError).toBeInstanceOf(Error);
      expect(shutdownError.message).toMatch(/cleanup failure/i);
      expect(shutdownError.message).not.toContain('sensitive audit cleanup failure');
    } finally {
      rawCleanup.resolve();
      jest.useRealTimers();
    }
  });

  test('queued audit work is an immutable compact snapshot instead of the live request context', async () => {
    const firstAppend = deferred();
    const auditStore = {
      append: jest.fn()
        .mockImplementationOnce(() => firstAppend.promise)
        .mockResolvedValue(undefined),
      cleanup: jest.fn(async () => {})
    };
    await initPlugin(auditStore);

    await plugin.hooks.onContentGenerated(requestContext('snapshot-active'));
    await waitFor(() => expect(auditStore.append).toHaveBeenCalledTimes(1));
    const queuedContext = requestContext('snapshot-queued', 'sensitive-body');
    queuedContext.potluckApiKey = 'potluck-original';
    queuedContext.providerName = 'provider-original';
    await plugin.hooks.onContentGenerated(queuedContext);

    queuedContext.originalRequestBody.model = 'mutated-model';
    queuedContext.originalRequestBody.input = 'mutated-sensitive-body';
    queuedContext.potluckApiKey = 'potluck-mutated';
    queuedContext.providerName = 'provider-mutated';
    firstAppend.resolve();
    await plugin.destroy();

    const queuedEvent = auditStore.append.mock.calls[1][0];
    expect(queuedEvent.request.requestedModel).toBe('gpt-5.5');
    expect(queuedEvent.account.providerNameDisplay).toBe('provider-original');
    expect(JSON.stringify(queuedEvent)).not.toContain('sensitive-body');
    expect(JSON.stringify(queuedEvent)).not.toContain('mutated-sensitive-body');
  });

  test('matched raw capture is bounded before queueing and destroy waits for its write', async () => {
    const capture = deferred();
    const auditStore = {
      append: jest.fn(async () => {}),
      cleanup: jest.fn(async () => {})
    };
    const rawCaptureStore = {
      maxBytes: 256,
      cleanup: jest.fn(async () => {}),
      capture: jest.fn(() => capture.promise)
    };
    await plugin.init({
      REQUEST_AUDIT_ENABLED: true,
      REQUEST_AUDIT_ANALYZER_ENABLED: false,
      REQUEST_AUDIT_RAW_CAPTURE_ENABLED: true,
      REQUEST_AUDIT_RAW_CAPTURE_KEY_HASHES: ['sha256:4e94524859e9df4e'],
      _requestAuditStore: auditStore,
      _requestAuditRawCaptureStore: rawCaptureStore
    });

    const context = requestContext('raw-bounded', 'x'.repeat(1024 * 1024));
    context.potluckApiKey = 'potluck-original';
    await plugin.hooks.onContentGenerated(context);
    await waitFor(() => expect(rawCaptureStore.capture).toHaveBeenCalledTimes(1));

    let destroyPromise;
    try {
      const capturedEvent = rawCaptureStore.capture.mock.calls[0][0];
      expect(Buffer.byteLength(JSON.stringify(capturedEvent), 'utf8')).toBeLessThanOrEqual(1024);
      expect(capturedEvent.originalRequestBody).not.toBe(context.originalRequestBody);

      destroyPromise = plugin.destroy();
      expect(await settlementWithin(destroyPromise)).toBe('pending');
    } finally {
      capture.resolve({ captured: true });
      await (destroyPromise || plugin.destroy());
    }
  });

  test('pending usage has a hard entry cap that evicts the oldest request', async () => {
    const auditStore = {
      append: jest.fn(async () => {}),
      cleanup: jest.fn(async () => {})
    };
    await initPlugin(auditStore);

    for (let index = 0; index <= 10000; index += 1) {
      await plugin.hooks.onUnaryResponse({
        requestId: `pending-${index}`,
        nativeResponse: usageResponse(index + 1)
      });
    }
    await plugin.hooks.onContentGenerated(requestContext('pending-0'));
    await plugin.hooks.onContentGenerated(requestContext('pending-10000'));
    const shutdownError = await plugin.destroy().then(
      () => null,
      error => error
    );

    const byRequestId = new Map(auditStore.append.mock.calls.map(([event]) => [event.requestId, event]));
    expect(byRequestId.get('pending-0').usage.promptTokens).toBe(0);
    expect(byRequestId.get('pending-10000').usage.promptTokens).toBe(10001);
    expect(shutdownError).toBeInstanceOf(Error);
    expect(shutdownError.message).toMatch(/pending usage overflow/i);
  });

  test('periodic cleanup expires stale pending usage without waiting for another completed request', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    jest.setSystemTime(new Date('2026-07-23T00:00:00.000Z'));
    const auditStore = {
      append: jest.fn(async () => {}),
      cleanup: jest.fn(async () => {})
    };
    try {
      await initPlugin(auditStore);
      await plugin.hooks.onUnaryResponse({
        requestId: 'stale-pending',
        nativeResponse: usageResponse(44)
      });

      await jest.advanceTimersByTimeAsync(15 * 60 * 1000);
      await plugin.hooks.onUnaryResponse({
        requestId: 'stale-pending',
        nativeResponse: usageResponse(1)
      });
      await plugin.hooks.onContentGenerated(requestContext('stale-pending'));
      await plugin.destroy();

      expect(auditStore.append).toHaveBeenCalledWith(expect.objectContaining({
        requestId: 'stale-pending',
        usage: expect.objectContaining({ promptTokens: 1 })
      }));
    } finally {
      jest.useRealTimers();
    }
  });

  test('destroy reports cleanup failure after waiting for the failed cleanup', async () => {
    const auditStore = {
      append: jest.fn(async () => {}),
      cleanup: jest.fn(async () => {})
    };
    const rawCaptureStore = {
      cleanup: jest.fn(async () => {
        throw new Error('sensitive cleanup path');
      })
    };
    await initPlugin(auditStore, rawCaptureStore);
    await waitFor(() => expect(rawCaptureStore.cleanup).toHaveBeenCalledTimes(1));

    const shutdownError = await plugin.destroy().then(
      () => null,
      error => error
    );

    expect(shutdownError).toBeInstanceOf(Error);
    expect(shutdownError.message).toMatch(/cleanup failure/i);
    expect(shutdownError.message).not.toContain('sensitive cleanup path');
  });

  test('raw capture failure has its own fixed shutdown loss category', async () => {
    const auditStore = {
      append: jest.fn(async () => {}),
      cleanup: jest.fn(async () => {})
    };
    const rawCaptureStore = {
      maxBytes: 1024,
      cleanup: jest.fn(async () => {}),
      capture: jest.fn(async () => {
        throw new Error('raw body secret');
      })
    };
    await plugin.init({
      REQUEST_AUDIT_ENABLED: true,
      REQUEST_AUDIT_ANALYZER_ENABLED: false,
      REQUEST_AUDIT_RAW_CAPTURE_ENABLED: true,
      REQUEST_AUDIT_RAW_CAPTURE_KEY_HASHES: ['sha256:4e94524859e9df4e'],
      _requestAuditStore: auditStore,
      _requestAuditRawCaptureStore: rawCaptureStore
    });
    const context = requestContext('raw-failure');
    context.potluckApiKey = 'potluck-original';
    await plugin.hooks.onContentGenerated(context);
    await waitFor(() => expect(rawCaptureStore.capture).toHaveBeenCalledTimes(1));

    const shutdownError = await plugin.destroy().then(
      () => null,
      error => error
    );

    expect(auditStore.append).toHaveBeenCalledTimes(1);
    expect(shutdownError.message).toMatch(/raw capture failure/i);
    expect(shutdownError.message).not.toMatch(/persistence failure/i);
    expect(shutdownError.message).not.toContain('raw body secret');
  });

  test('raw snapshot getter failure still enqueues the safe base audit event', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const auditStore = {
      append: jest.fn(async () => {}),
      cleanup: jest.fn(async () => {})
    };
    const rawCaptureStore = {
      maxBytes: 1024,
      cleanup: jest.fn(async () => {}),
      capture: jest.fn(async () => ({ captured: true }))
    };
    await plugin.init({
      REQUEST_AUDIT_ENABLED: true,
      REQUEST_AUDIT_ANALYZER_ENABLED: false,
      REQUEST_AUDIT_RAW_CAPTURE_ENABLED: true,
      REQUEST_AUDIT_RAW_CAPTURE_KEY_HASHES: ['sha256:4e94524859e9df4e'],
      _requestAuditStore: auditStore,
      _requestAuditRawCaptureStore: rawCaptureStore
    });
    const context = requestContext('raw-snapshot-failure');
    context.potluckApiKey = 'potluck-original';
    Object.defineProperty(context.originalRequestBody, 'dangerousRawField', {
      enumerable: true,
      get() {
        throw new Error('sensitive raw getter');
      }
    });
    try {
      await plugin.hooks.onContentGenerated(context);
      await waitFor(() => expect(auditStore.append).toHaveBeenCalledTimes(1));
      const shutdownError = await plugin.destroy().then(
        () => null,
        error => error
      );

      expect(auditStore.append).toHaveBeenCalledWith(expect.objectContaining({
        requestId: 'raw-snapshot-failure'
      }));
      expect(rawCaptureStore.capture).not.toHaveBeenCalled();
      expect(shutdownError.message).toMatch(/raw snapshot failure/i);
      expect(shutdownError.message).not.toContain('sensitive raw getter');
      expect(warn).toHaveBeenCalledWith('[Request Audit] raw snapshot failure');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('sensitive raw getter');
    } finally {
      warn.mockRestore();
    }
  });

  test('raw capture queue has a total byte budget in addition to its event count limit', async () => {
    const firstAppend = deferred();
    const auditStore = {
      append: jest.fn()
        .mockImplementationOnce(() => firstAppend.promise)
        .mockResolvedValue(undefined),
      cleanup: jest.fn(async () => {})
    };
    const rawCaptureStore = {
      maxBytes: 1024 * 1024,
      cleanup: jest.fn(async () => {}),
      capture: jest.fn(async () => ({ captured: true }))
    };
    await plugin.init({
      REQUEST_AUDIT_ENABLED: true,
      REQUEST_AUDIT_ANALYZER_ENABLED: false,
      REQUEST_AUDIT_RAW_CAPTURE_ENABLED: true,
      REQUEST_AUDIT_RAW_CAPTURE_KEY_HASHES: ['sha256:4e94524859e9df4e'],
      _requestAuditStore: auditStore,
      _requestAuditRawCaptureStore: rawCaptureStore
    });

    const largeInput = 'large diagnostic prompt '.repeat(50_000);
    const firstContext = requestContext('byte-budget-active', largeInput);
    firstContext.potluckApiKey = 'potluck-original';
    await plugin.hooks.onContentGenerated(firstContext);
    await waitFor(() => expect(auditStore.append).toHaveBeenCalledTimes(1));
    for (let index = 0; index < 40; index += 1) {
      const context = requestContext(`byte-budget-${index}`, largeInput);
      context.potluckApiKey = 'potluck-original';
      await plugin.hooks.onContentGenerated(context);
    }

    firstAppend.resolve();
    const shutdownError = await plugin.destroy().then(
      () => null,
      error => error
    );

    expect(shutdownError).toBeInstanceOf(Error);
    expect(shutdownError.message).toMatch(/queue byte overflow/i);
    expect(auditStore.append.mock.calls.length).toBeLessThan(41);
    expect(rawCaptureStore.capture).toHaveBeenCalledTimes(auditStore.append.mock.calls.length);
  });
});
