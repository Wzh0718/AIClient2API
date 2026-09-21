import { describe, expect, test } from '@jest/globals';
import fs from 'fs';
import path from 'path';

function read(relativePath) {
    return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8').replace(/\r\n/g, '\n');
}

describe('production image provenance and blue-green preflight', () => {
    test('Docker image embeds the requested source revision', () => {
        const dockerfile = read('Dockerfile');
        const buildScript = read('scripts/ops/build-image.sh');

        expect(dockerfile).toContain('ARG APP_REVISION=unknown');
        expect(dockerfile).toContain('LABEL yyn.base_commit=$APP_REVISION');
        expect(dockerfile).toContain('/app/REVISION');
        expect(buildScript).toContain('--build-arg APP_REVISION="$COMMIT"');
        expect(buildScript).toContain('docker image inspect');
        expect(buildScript).toContain('yyn.base_commit');
    });

    test('blue-green helper is dry-run by default and does not publish OAuth ports', () => {
        const script = read('scripts/ops/blue-green-deploy.sh');

        expect(script).toContain('APPLY=0');
        expect(script).toContain('PHASE=plan');
        expect(script).toContain('127.0.0.1:${CANDIDATE_PORT}:3000');
        expect(script).toContain('yyn.base_commit');
        expect(script).toContain('RUNTIME_DEPLOYMENT_EPOCH');
        expect(script).toContain('RUNTIME_MULTI_WORKER_ENABLED=true');
        expect(script).toContain('--env REDIS_URL');
        expect(script).toContain('nginx -t');
        expect(script).toContain('refusing unsafe snapshot path');
        expect(script).not.toMatch(/-p\s+1455:1455/);
        expect(script).not.toMatch(/-p\s+8085-8087/);
        expect(script).not.toMatch(/-p\s+19876-19880/);
        expect(script).not.toMatch(/-p\s+56121:56121/);
    });

    test('operations guide documents stateful and OAuth cutover boundaries', () => {
        const guide = read('docs/ops-blue-green-deploy.md');

        expect(guide).toContain('单写者');
        expect(guide).toContain('OAuth');
        expect(guide).toContain('不等于严格无缝双活');
        expect(guide).toContain('max-size');
        expect(guide).toContain('nginx -t');
    });

    test('candidate preflight gates on worker config convergence', () => {
        const script = read('scripts/ops/blue-green-deploy.sh');
        expect(script).toContain('/runtime/health');
        expect(script).toContain('pendingWorkerCount');
    });

    test('candidate containers enforce bounded json-file logging', () => {
        const script = read('scripts/ops/blue-green-deploy.sh');
        expect(script).toContain('--log-driver json-file');
        expect(script).toContain('--log-opt "max-size=$CANDIDATE_LOG_MAX_SIZE"');
        expect(script).toContain('--log-opt "max-file=$CANDIDATE_LOG_MAX_FILE"');
        expect(script).toContain('CANDIDATE_LOG_MAX_SIZE=${CANDIDATE_LOG_MAX_SIZE:-50m}');
        expect(script).toContain('CANDIDATE_LOG_MAX_FILE=${CANDIDATE_LOG_MAX_FILE:-5}');
        expect(script).toContain('candidate log configuration mismatch');
        expect(script).toContain('.HostConfig.LogConfig.Config');
    });

    test('candidate snapshot stays bounded and joins the Redis network', () => {
        const script = read('scripts/ops/blue-green-deploy.sh');

        expect(script).toContain('CANDIDATE_NETWORK');
        expect(script).toContain('--network "$CANDIDATE_NETWORK"');
        expect(script).toContain('--exclude=request-audit');
        expect(script).toContain('--exclude=app-logs');
        expect(script).toContain('SNAPSHOT_REQUIRED_BYTES');
        expect(script).toContain('insufficient disk space for candidate snapshot');
        expect(script).toContain('CANDIDATE_MEMORY');
        expect(script).toContain('CANDIDATE_CPUS');
        expect(script).toContain('--memory "$CANDIDATE_MEMORY"');
    });
});
