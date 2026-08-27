import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

function read(relativePath) {
    return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8').replace(/\r\n/g, '\n');
}

describe('stable image build operations', () => {
    test('build script enables reproducible proxy, retries and stage timing', () => {
        const script = read('scripts/ops/build-image.sh');

        expect(script).toContain('BUILD_HTTP_PROXY=${BUILD_HTTP_PROXY:-http://192.168.4.242:7890}');
        expect(script).toContain('BUILD_RETRIES=${BUILD_RETRIES:-2}');
        expect(script).toContain('stage_start()');
        expect(script).toContain('build attempt');
        expect(script).toContain('docker build --progress=plain');
        expect(script).toContain('NODE_BASE_IMAGE');
        expect(script).toContain('DOCKER_BUILDKIT=1');
    });

    test('Dockerfile caches Go and npm dependency downloads without weakening native checks', () => {
        const dockerfile = read('Dockerfile');

        expect(dockerfile).not.toContain('# syntax=docker/dockerfile:');
        expect(dockerfile).toContain('--mount=type=cache,target=/go/pkg/mod');
        expect(dockerfile).toContain('--mount=type=cache,target=/root/.cache/go-build');
        expect(dockerfile).toContain('--mount=type=cache,target=/root/.npm');
        expect(dockerfile).toContain('better-sqlite3 runtime ok');
        expect(dockerfile).toContain('sharp runtime ok');
        expect(dockerfile).toContain('ALPINE_MIRROR=mirrors.aliyun.com');
    });

    test('provides an explicit internal base image workflow for cold builds', () => {
        const script = read('scripts/ops/build-base-image.sh');
        const dockerfile = read('docker/Dockerfile.build-base');

        expect(script).toContain('aiclient2api:node20-alpine-build-base');
        expect(script).toContain('docker build --progress=plain');
        expect(dockerfile).toContain('FROM node:20-alpine');
        expect(dockerfile).toContain('python3 make g++');
        expect(dockerfile).toContain('git tar procps');
        expect(dockerfile).toContain('ALPINE_MIRROR');
    });
});
