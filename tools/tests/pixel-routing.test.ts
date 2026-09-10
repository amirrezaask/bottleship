import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DxtKernel, dxtSimdKernelUrl, initializeDxtKernel } from '../../src/worker/backends/webgpu/shared/dxt-kernel';
import { convertSurfaceToRGBA } from '../../src/worker/modules/ddraw/gpu-texture-utils';
import { convertSurfaceToRGBA as reference } from '../../src/worker/modules/ddraw/gpu-texture-reference';

test('unkeyed RGB565 keeps the LUT path; keying uses fused WASM', async () => {
    assert.equal(await initializeDxtKernel(readFileSync(dxtSimdKernelUrl)), true);
    const original = DxtKernel.prototype.tryConvert;
    let calls = 0;
    DxtKernel.prototype.tryConvert = function (...args) { calls++; return original.apply(this,args); };
    try {
        const format = {bpp:16,rMask:0xf800,gMask:0x7e0,bMask:31,aMask:0};
        const src = new Uint8Array(512).fill(42), out = new Uint8Array(1024);
        convertSurfaceToRGBA(src,0,16,16,32,format,out);
        assert.deepEqual(out,reference(src,0,16,16,32,format));
        assert.equal(calls,0);
        const key = {low:0,high:0};
        convertSurfaceToRGBA(src,0,16,16,32,format,out,key);
        assert.deepEqual(out,reference(src,0,16,16,32,format,undefined,key));
        assert.equal(calls,1);
    } finally { DxtKernel.prototype.tryConvert = original; }
});
