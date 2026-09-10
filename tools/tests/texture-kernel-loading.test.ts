import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadTextureKernel, dxtKernelUrl, dxtSimdKernelUrl } from '../../src/worker/backends/webgpu/shared/dxt-kernel';

const scalar = readFileSync(dxtKernelUrl);
const simd = readFileSync(dxtSimdKernelUrl);

test('SIMD selection fetches one asset; unsupported SIMD fetches only scalar', async () => {
    for (const supported of [false, true]) {
        const urls: string[] = [];
        const request = (async (url: URL) => { urls.push(url.href); return new Response(supported ? simd : scalar); }) as unknown as typeof fetch;
        const loaded = await loadTextureKernel(request,supported);
        assert.equal(loaded.variant,supported ? 'simd' : 'scalar');
        assert.equal(loaded.warning,null);
        assert.deepEqual(urls,[supported ? dxtSimdKernelUrl.href : dxtKernelUrl.href]);
    }
});

test('SIMD fetch, compile and ABI failures retry the working scalar module', async () => {
    for (const failure of ['http','compile','abi','network']) {
        let calls = 0;
        const request = (async () => {
            if (calls++ > 0) return new Response(scalar);
            if (failure === 'http') return new Response('',{status:404});
            if (failure === 'network') throw new TypeError('network down');
            return new Response(failure === 'compile' ? new Uint8Array([1,2,3]) : new Uint8Array([0,97,115,109,1,0,0,0]));
        }) as typeof fetch;
        const loaded = await loadTextureKernel(request,true);
        assert.equal(loaded.variant,'scalar');
        assert.equal(calls,2);
        assert.match(loaded.warning!,/SIMD unavailable/);
    }
});

test('both variants failing reject rather than installing a broken kernel', async () => {
    const request = (async () => new Response('',{status:404})) as typeof fetch;
    await assert.rejects(loadTextureKernel(request,true),/HTTP 404/);
});
