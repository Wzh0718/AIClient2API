import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import fs from 'fs';
import path from 'path';

describe('usage refresh feedback', () => {
    beforeAll(() => {
        globalThis.window = {
            location: { origin: 'http://localhost' }
        };
        globalThis.localStorage = {
            getItem: jest.fn(() => null),
            setItem: jest.fn(),
            removeItem: jest.fn()
        };
    });

    afterAll(() => {
        delete globalThis.window;
        delete globalThis.localStorage;
    });

    test('waits for the background refresh before reporting completion', async () => {
        const usageManager = await import('../static/app/usage-manager.js');

        expect(typeof usageManager.waitForUsageRefreshCompletion).toBe('function');

        const fetchUsage = jest.fn()
            .mockResolvedValueOnce({ refreshPending: true, timestamp: 'old' })
            .mockResolvedValueOnce({ refreshPending: false, timestamp: 'fresh' });
        const sleep = jest.fn().mockResolvedValue(undefined);

        const result = await usageManager.waitForUsageRefreshCompletion({
            fetchUsage,
            sleep,
            intervalMs: 1,
            timeoutMs: 1000
        });

        expect(result).toEqual({
            completed: true,
            data: { refreshPending: false, timestamp: 'fresh' }
        });
        expect(fetchUsage).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalledTimes(1);
    });

    test('does not claim success when the background refresh is still running at timeout', async () => {
        const usageManager = await import('../static/app/usage-manager.js');
        let now = 0;
        const fetchUsage = jest.fn().mockResolvedValue({ refreshPending: true, timestamp: 'old' });
        const sleep = jest.fn().mockImplementation(async () => { now += 50; });

        const result = await usageManager.waitForUsageRefreshCompletion({
            fetchUsage,
            sleep,
            now: () => now,
            intervalMs: 50,
            timeoutMs: 100
        });

        expect(result).toEqual({
            completed: false,
            data: { refreshPending: true, timestamp: 'old' }
        });
        expect(fetchUsage).toHaveBeenCalledTimes(2);
    });

    test('keeps visible button feedback for the entire refresh', async () => {
        const usageManager = await import('../static/app/usage-manager.js');
        expect(typeof usageManager.setUsageRefreshButtonState).toBe('function');
        const button = {
            disabled: false,
            innerHTML: '<i class="fas fa-sync-alt"></i> <span>刷新用量</span>',
            dataset: {}
        };

        usageManager.setUsageRefreshButtonState(button, true);
        expect(button.disabled).toBe(true);
        expect(button.innerHTML).toContain('fa-spin');
        expect(button.innerHTML).toContain('正在刷新');

        usageManager.setUsageRefreshButtonState(button, false);
        expect(button.disabled).toBe(false);
        expect(button.innerHTML).toContain('刷新用量');
        expect(button.innerHTML).not.toContain('fa-spin');
    });

    test('styles a disabled provider refresh button as an active wait state', () => {
        const css = fs.readFileSync(path.join(process.cwd(), 'static/components/section-usage.css'), 'utf8').replace(/\r\n/g, '\n');
        expect(css).toContain('.btn-refresh-provider:disabled');
        expect(css).toContain('cursor: wait');
    });

    test('allows refresh success feedback to remain visible longer than the default toast', async () => {
        jest.useFakeTimers();
        const remove = jest.fn();
        const toastContainer = { appendChild: jest.fn() };
        globalThis.document = {
            createElement: jest.fn(() => ({ className: '', innerHTML: '', remove })),
            getElementById: jest.fn(() => toastContainer),
            querySelector: jest.fn(() => null)
        };
        const { showToast } = await import('../static/app/utils.js');

        showToast('成功', '刷新成功', 'success', 6000);
        jest.advanceTimersByTime(3000);
        expect(remove).not.toHaveBeenCalled();
        jest.advanceTimersByTime(3000);
        expect(remove).toHaveBeenCalledTimes(1);

        delete globalThis.document;
        jest.useRealTimers();
    });

    test('builds an encoded provider-only refresh URL', async () => {
        const usageManager = await import('../static/app/usage-manager.js');

        expect(typeof usageManager.buildProviderUsageRefreshUrl).toBe('function');
        expect(usageManager.buildProviderUsageRefreshUrl('gemini custom/provider')).toBe(
            '/api/usage/gemini%20custom%2Fprovider?refresh=true'
        );
    });

    test('shows and restores provider refresh button busy state', async () => {
        const usageManager = await import('../static/app/usage-manager.js');
        const button = {
            disabled: false,
            innerHTML: '<i class="fas fa-rotate"></i><span>刷新</span>',
            dataset: {},
            setAttribute: jest.fn(),
            removeAttribute: jest.fn()
        };

        usageManager.setProviderUsageRefreshButtonState(button, true);
        expect(button.disabled).toBe(true);
        expect(button.innerHTML).toContain('fa-spin');
        expect(button.innerHTML).toContain('正在刷新');
        expect(button.setAttribute).toHaveBeenCalledWith('aria-busy', 'true');

        usageManager.setProviderUsageRefreshButtonState(button, false);
        expect(button.disabled).toBe(false);
        expect(button.innerHTML).toContain('刷新');
        expect(button.innerHTML).not.toContain('fa-spin');
        expect(button.removeAttribute).toHaveBeenCalledWith('aria-busy');
    });

    test('exposes visible provider refresh controls instead of a page-wide or gesture-only action', () => {
        const html = fs.readFileSync(path.join(process.cwd(), 'static/components/section-usage.html'), 'utf8').replace(/\r\n/g, '\n');
        const source = fs.readFileSync(path.join(process.cwd(), 'static/app/usage-manager.js'), 'utf8').replace(/\r\n/g, '\n');
        const css = fs.readFileSync(path.join(process.cwd(), 'static/components/section-usage.css'), 'utf8').replace(/\r\n/g, '\n');

        expect(html).not.toContain('id="refreshUsageBtn"');
        expect(source).toContain('class="btn-refresh-provider"');
        expect(source).toContain("refreshButton.addEventListener('click'");
        expect(source).toContain('event.stopPropagation()');
        expect(source).toContain('Array.isArray(data.instances) ? data : null');
        expect(source).not.toContain("tag.addEventListener('dblclick'");
        expect(css).toMatch(/\.btn-refresh-provider\s*\{[^}]*min-height:\s*36px;/s);
        expect(css).toContain('.btn-refresh-provider:focus-visible');
        expect(css).toMatch(/@media \(max-width: 520px\)[\s\S]*\.btn-refresh-provider\s*\{[^}]*min-height:\s*44px;/s);
        expect(css).toMatch(/@media \(max-width: 520px\)[\s\S]*\.btn-refresh-provider \.button-label\s*\{[^}]*display:\s*none;/s);
    });
});
