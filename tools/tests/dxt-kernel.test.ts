import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DxtKernel, dxtKernelUrl, initializeDxtKernel, getDxtKernelStatus } from "../../src/worker/backends/webgpu/shared/dxt-kernel";
import { decodeDxtToRgba, decodeDxtToRgbaReference, dxtRowPitch } from "../../src/worker/backends/webgpu/shared/dxt";

const binary = readFileSync(dxtKernelUrl);
const module = new WebAssembly.Module(binary);
const instance = () => new WebAssembly.Instance(module);
const format = (kind: number) => 0x00545844 | ((kind + 0x30) << 24);
const fill = (size: number, seed: number) => {
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; out[i] = seed; }
    return out;
};

test("Rust DXT has no host imports and preserves the fallback for small images", () => {
    assert.deepEqual(WebAssembly.Module.imports(module), []);
    const runtime = new DxtKernel(instance());
    assert.equal(runtime.tryDecode(1, new Uint8Array(8), 8, 4, 4, new Uint8Array(64), 8), false);
    const src = new Uint8Array(8); src.fill(255, 4);
    const out = new Uint8Array(65).fill(173);
    decodeDxtToRgba(format(1), src, 8, 4, 4, out.subarray(1));
    assert.equal(out[0], 173);
    assert.ok(out.subarray(1).every(x => x === 0), "BC1 transparent black");
});

test("WASM agrees byte-for-byte with the TS reference across five formats, pitches and partial blocks", async () => {
    assert.equal(await initializeDxtKernel(binary), true);
    assert.equal(getDxtKernelStatus().ready, true);
    const runtime = new DxtKernel(instance());
    for (let kind = 1; kind <= 5; kind++) {
        for (const [width, height] of [[1, 1], [3, 5], [16, 16], [31, 17], [64, 33], [129, 65]]) {
            for (const pad of [0, 7, 19]) {
                const pitch = dxtRowPitch(format(kind), width) + pad;
                const size = (Math.ceil(height / 4) - 1) * pitch + pitch - pad;
                for (let seed = 1; seed <= 16; seed++) {
                    const source = fill(size + 5, seed * 65537 + kind).subarray(5);
                    const expected = new Uint8Array(width * height * 4);
                    decodeDxtToRgbaReference(format(kind), source, pitch, width, height, expected);
                    const buffer = new Uint8Array(expected.length + 11).fill(173);
                    const actual = buffer.subarray(3, 3 + expected.length);
                    decodeDxtToRgba(format(kind), source, pitch, width, height, actual);
                    assert.deepEqual(actual, expected, `kind=${kind} ${width}x${height} pitch=${pitch} seed=${seed}`);
                    assert.ok(buffer.subarray(0, 3).every(x => x === 173));
                    assert.ok(buffer.subarray(3 + expected.length).every(x => x === 173));
                    if (width * height >= 256) {
                        actual.fill(0);
                        assert.equal(runtime.tryDecode(kind, source, pitch, width, height, actual, size), true);
                        assert.deepEqual(actual, expected);
                    }
                }
            }
        }
    }
});

test("WASM reuses its arena and refreshes detached views after growth", () => {
    const wasm = instance();
    const runtime = new DxtKernel(wasm);
    const memory = wasm.exports.memory as WebAssembly.Memory;
    const before = memory.buffer;
    const width = 1024, height = 512, pitch = width * 4;
    const src = fill(pitch * (height / 4), 793);
    const dst = new Uint8Array(width * height * 4);
    assert.equal(runtime.tryDecode(5, src, pitch, width, height, dst, src.length), true);
    assert.notStrictEqual(memory.buffer, before);
    const after = memory.buffer;
    const reference = new Uint8Array(dst.length);
    decodeDxtToRgbaReference(format(5), src, pitch, width, height, reference);
    assert.deepEqual(dst, reference);
    assert.equal(runtime.tryDecode(5, src, pitch, width, height, dst, src.length), true);
    assert.strictEqual(memory.buffer, after, "steady-state calls must not grow memory");
    assert.equal(runtime.tryDecode(5, src, 16384, 16384, 16384, dst, src.length), false);
});

test("borrowed decode output is exact and cannot escape through reentrant reuse", () => {
    const runtime = new DxtKernel(instance());
    const width = 16, height = 16, pitch = dxtRowPitch(format(5), width);
    const src = fill(pitch * Math.ceil(height / 4), 117);
    const expected = new Uint8Array(width * height * 4);
    decodeDxtToRgbaReference(format(5), src, pitch, width, height, expected);
    let observed: Uint8Array | undefined;
    assert.equal(runtime.tryDecodeLease(5, src, pitch, width, height, src.length, rgba => {
        observed = new Uint8Array(rgba);
        assert.equal(runtime.tryDecodeLease(5, src, pitch, width, height, src.length, () => {}), false);
    }), true);
    assert.deepEqual(observed, expected);
});

test("the public decoder rejects malformed spans without writing output", () => {
    const src = new Uint8Array(32), dst = new Uint8Array(256).fill(173);
    for (const [pitch, width, height] of [[7, 4, 4], [8, -1, 4], [8, 1.5, 4], [8, NaN, 4], [8, Infinity, 4], [8, 4, 9999]]) {
        assert.throws(() => decodeDxtToRgba(format(1), src, pitch, width, height, dst), RangeError);
        assert.ok(dst.every(x => x === 173));
    }
    assert.throws(() => decodeDxtToRgba(0, src, 8, 4, 4, dst), RangeError);
    assert.throws(() => decodeDxtToRgba(format(1), src.subarray(0, 7), 8, 4, 4, dst), RangeError);
    assert.throws(() => decodeDxtToRgba(format(1), src, 8, 4, 4, dst.subarray(0, 63)), RangeError);
    assert.throws(() => decodeDxtToRgba(format(1), dst.subarray(0, 8), 8, 4, 4, dst), RangeError);
    decodeDxtToRgba(format(1), src, 0, 0, 0, dst);
    assert.ok(dst.every(x => x === 173));
});

test("the raw Rust ABI independently checks bounds, overflow, stack protection and overlap", () => {
    const wasm = instance();
    const memory = wasm.exports.memory as WebAssembly.Memory;
    const base = Number((wasm.exports.__heap_base as WebAssembly.Global).value);
    memory.grow(1);
    const bytes = new Uint8Array(memory.buffer);
    const decode = wasm.exports.decode_dxt as (...args: number[]) => number;
    const dst = base + 1024;
    bytes.fill(173, dst, dst + 64);
    const bad = [
        [0, base, 8, 8, 4, 4, dst, 64],
        [1, base, 7, 8, 4, 4, dst, 64],
        [1, base, 8, 7, 4, 4, dst, 64],
        [1, base, 8, 8, 4, 4, dst, 63],
        [1, 0, 8, 8, 4, 4, dst, 64],
        [1, base, 8, 8, 4, 4, 0, 64],
        [1, base, 8, 8, 4, 4, base + 4, 64],
        [1, bytes.length - 4, 8, 8, 4, 4, dst, 64],
        [1, base, 8, 8, 4, 4, bytes.length - 4, 64],
        [5, base, 0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff, dst, 0xffffffff],
    ];
    for (const args of bad) {
        assert.notEqual(decode(...args), 0, JSON.stringify(args));
        assert.ok(bytes.subarray(dst, dst + 64).every(x => x === 173));
    }
    assert.equal(decode(1, base + 1, 8, 8, 4, 4, dst + 1, 64), 0, "unaligned byte spans are legal");
});
