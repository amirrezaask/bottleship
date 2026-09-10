import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DxtKernel, dxtKernelUrl, dxtSimdKernelUrl, initializeDxtKernel, supportsTextureSimd } from '../../src/worker/backends/webgpu/shared/dxt-kernel';
import { convertSurfaceToRGBA, type FormatInfo } from '../../src/worker/modules/ddraw/gpu-texture-utils';
import { convertSurfaceToRGBA as reference } from '../../src/worker/modules/ddraw/gpu-texture-reference';

const formats: Record<number, FormatInfo> = {
    1: { bpp: 16, rMask: 0xf800, gMask: 0x7e0, bMask: 31, aMask: 0 },
    2: { bpp: 16, rMask: 0x7c00, gMask: 0x3e0, bMask: 31, aMask: 0 },
    3: { bpp: 16, rMask: 0x7c00, gMask: 0x3e0, bMask: 31, aMask: 0x8000 },
    6: { bpp: 32, rMask: 0xff0000, gMask: 0xff00, bMask: 255, aMask: 0xff000000 },
    7: { bpp: 32, rMask: 0xff0000, gMask: 0xff00, bMask: 255, aMask: 0 },
};
const keys = [undefined, {low: 0, high: 0}, {low: 0xf800, high: 0xf8ff}, {low: 0xffff0000, high: 0xffffffff}, {low: 300, high: 7}];
function bytes(n: number, seed = 42): Uint8Array {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; out[i] = seed; }
    return out;
}
function fresh(url: URL) {
    const module = new WebAssembly.Module(readFileSync(url));
    assert.deepEqual(WebAssembly.Module.imports(module), []);
    const instance = new WebAssembly.Instance(module);
    return { instance, kernel: new DxtKernel(instance) };
}

for (const [variant, url] of [['scalar', dxtKernelUrl], ['SIMD', dxtSimdKernelUrl]] as const) {
    test(`${variant}: every 16-bit pixel matches the original converter, with and without keying`, () => {
        const {kernel} = fresh(url);
        const src = new Uint8Array(65536 * 2);
        new Uint16Array(src.buffer).forEach((_, i, a) => { a[i] = i; });
        for (const kind of [1, 2, 3]) for (const key of keys) {
            const expected = reference(src, 0, 256, 256, 512, formats[kind], undefined, key);
            const out = new Uint8Array(expected.length + 7).fill(173);
            assert.equal(kernel.tryConvert(kind, src, 0, 512, 256, 256, out.subarray(3, -4), key), true);
            assert.deepEqual(out.subarray(3, -4), expected);
            assert.ok(out.subarray(0, 3).every(x => x === 173));
            assert.ok(out.subarray(-4).every(x => x === 173));
        }
    });

    test(`${variant}: odd pitches, offsets, SIMD tails, all formats and repeated growth`, () => {
        const {kernel, instance} = fresh(url);
        const memory = instance.exports.memory as WebAssembly.Memory;
        const original = memory.buffer;
        for (const kind of [1, 2, 3, 6, 7]) for (const width of [4, 5, 7, 16, 31, 257]) {
            const height = 65, bpp = formats[kind].bpp / 8;
            for (const padding of [0, 1, 7, 32]) {
                const pitch = width * bpp + padding;
                const src = bytes(pitch * (height - 1) + width * bpp + 5).subarray(3);
                const packed = new Uint8Array(width * bpp * height);
                for (let y = 0; y < height; y++) packed.set(src.subarray(2 + y * pitch, 2 + y * pitch + width * bpp), y * width * bpp);
                for (const key of keys) {
                    const expected = reference(packed, 0, width, height, width * bpp, formats[kind], undefined, key);
                    const out = new Uint8Array(width * height * 4);
                    assert.equal(kernel.tryConvert(kind, src, 2, pitch, width, height, out, key), true);
                    assert.deepEqual(out, expected, `${kind} ${width} pad=${padding}`);
                }
            }
        }
        const large = bytes(1024*1024*4), out = new Uint8Array(large.length);
        assert.equal(kernel.tryConvert(6, large, 0, 4096, 1024, 1024, out), true);
        assert.notStrictEqual(memory.buffer, original);
        const grown = memory.buffer;
        assert.equal(kernel.tryConvert(6, large, 0, 4096, 1024, 1024, out), true);
        assert.strictEqual(memory.buffer, grown);
        assert.deepEqual(out, reference(large, 0, 1024, 1024, 4096, formats[6]));
    });

    test(`${variant}: raw ABI rejects invalid geometry, overlap, overflow and protected spans before writing`, () => {
        const {instance} = fresh(url);
        const memory = instance.exports.memory as WebAssembly.Memory;
        const base = Number((instance.exports.__heap_base as WebAssembly.Global).value);
        memory.grow(1);
        const view = new Uint8Array(memory.buffer), dst = base + 4096;
        view.fill(173, dst, dst + 1024);
        const run = instance.exports.convert_pixels as (...args: number[]) => number;
        const args = [6, base, 1024, 64, 16, 16, dst, 1024, 1, 0, 0];
        for (const [index, value] of [[0, 4], [0, 5], [1, 0], [1, view.length-8], [2, 1023], [3, 63], [4, 0xffffffff], [5, 0xffffffff], [6, 0], [6, view.length-8], [6, base+1], [7, 1023], [8, 2]]) {
            const input = [...args]; input[index] = value;
            assert.notEqual(run(...input), 0, JSON.stringify(input));
            assert.ok(view.subarray(dst, dst + 1024).every(x => x === 173));
        }
        assert.equal(run(6, base+1, 1024, 64, 16, 16, dst+1, 1024, 0, 0, 0), 0);
    });
}

test('fallback: byte views and aliased output are safe before WASM initialization', () => {
    for (const kind of [1, 2, 3, 6, 7]) for (const width of [1, 4, 7]) {
        const height = 3, bpp = formats[kind].bpp/8, pitch = width*bpp+1;
        const src = bytes(2+(height-1)*pitch+width*bpp).subarray(1);
        const packed = new Uint8Array(width*bpp*height);
        for (let y=0; y<height; y++) packed.set(src.subarray(1+y*pitch, 1+y*pitch+width*bpp), y*width*bpp);
        for (const key of keys) {
            const expected = reference(packed,0,width,height,width*bpp,formats[kind],undefined,key);
            const out = new Uint8Array(expected.length+5).fill(173);
            assert.strictEqual(convertSurfaceToRGBA(src,1,width,height,pitch,formats[kind],out.subarray(1,-4),key).buffer,out.buffer);
            assert.deepEqual(out.subarray(1,-4),expected);
            assert.equal(out[0],173);
            assert.ok(out.subarray(-4).every(x=>x===173));
        }
        const alias = bytes(width*height*4+16), original = alias.slice();
        const expected = reference(original,0,width,height,width*bpp,formats[kind]);
        convertSurfaceToRGBA(alias,0,width,height,width*bpp,formats[kind],alias.subarray(4));
        assert.deepEqual(alias.subarray(4,4+expected.length),expected);
    }
});

test('public path: safe views, empty images, malformed dimensions and SIMD selection', async () => {
    assert.equal(supportsTextureSimd(), true);
    assert.equal(await initializeDxtKernel(readFileSync(dxtSimdKernelUrl)), true);
    const src = bytes(65536), out = new Uint8Array(65536);
    for (const kind of [1,2,3,6,7]) {
        const pitch = 64 * formats[kind].bpp/8;
        const expected = reference(src,0,64,64,pitch,formats[kind],undefined,keys[2]);
        convertSurfaceToRGBA(src,0,64,64,pitch,formats[kind],out,keys[2]);
        assert.deepEqual(out.subarray(0,expected.length),expected);
    }
    out.fill(173);
    for (const [w,h,p,offset] of [[-1,4,16,0],[1.5,4,16,0],[NaN,4,16,0],[4,Infinity,16,0],[Number.MAX_SAFE_INTEGER,4,16,0],[4,4,NaN,0],[4,4,16,Infinity]]) {
        assert.throws(()=>convertSurfaceToRGBA(src,offset,w,h,p,formats[6],out),RangeError);
        assert.ok(out.every(x=>x===173));
    }
    assert.strictEqual(convertSurfaceToRGBA(src,0,0,16,0,formats[6],out),out);
});

for (const [variant, url] of [['scalar', dxtKernelUrl], ['SIMD', dxtSimdKernelUrl]] as const) {
    test(`${variant}: DXT and pixels safely alternate through one arena`, async () => {
        const { decodeDxtToRgba } = await import('../../src/worker/backends/webgpu/shared/dxt-reference');
        const { kernel } = fresh(url);
        for (const kind of [1, 2, 3, 4, 5]) for (const [w, h] of [[17, 31], [64, 16], [257, 129]]) {
            const pitch = Math.ceil(w/4) * (kind === 1 ? 8 : 16) + 7;
            const src = bytes((Math.ceil(h/4)-1)*pitch+pitch-7, kind*1009);
            const expected = new Uint8Array(w*h*4), out = new Uint8Array(expected.length);
            const fmt = 0x00545844 | ((kind + 0x30) << 24);
            decodeDxtToRgba(fmt,src,pitch,w,h,expected);
            assert.equal(kernel.tryDecode(kind,src,pitch,w,h,out,src.length),true);
            assert.deepEqual(out,expected);
            const pixels = bytes(1024*1024*2, kind);
            const converted = new Uint8Array(1024*1024*4);
            assert.equal(kernel.tryConvert(1,pixels,0,2048,1024,1024,converted),true);
            assert.deepEqual(converted,reference(pixels,0,1024,1024,2048,formats[1]));
            out.fill(173);
            assert.equal(kernel.tryDecode(kind,src,pitch,w,h,out,src.length),true);
            assert.deepEqual(out,expected,'output view must follow layout changes after growth');
        }
    });
}
