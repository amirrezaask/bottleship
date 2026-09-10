import { decodeDxtToRgba, dxtRowPitch } from "../../src/worker/backends/webgpu/shared/dxt";
import { DxSamplerCache, type SamplerSpec } from "../../src/worker/backends/webgpu/shared/dx-sampler";
import { EmulatorConfig } from "../../src/worker/core/emulator-config-manager";

function median(values: number[]): number { return [...values].sort((a, b) => a - b)[values.length >> 1]; }
function measure(before: () => void, after: () => void, iterations: number) {
    for (let i = 0; i < Math.min(100, iterations); i++) { before(); after(); }
    const run = (fn: () => void) => {
        const start = performance.now();
        for (let i = 0; i < iterations; i++) fn();
        return (performance.now() - start) / iterations;
    };
    const b: number[] = [], a: number[] = [];
    for (let round = 0; round < 9; round++) {
        if (round & 1) { a.push(run(after)); b.push(run(before)); }
        else { b.push(run(before)); a.push(run(after)); }
    }
    return { beforeMs: median(b), afterMs: median(a), speedup: median(b) / median(a), beforeSamplesMs: b, afterSamplesMs: a, iterations };
}
export function benchmarkFastpaths(
    baselineDxt: { decodeDxtToRgba: typeof decodeDxtToRgba },
    baselineSampler: { DxSamplerCache: typeof DxSamplerCache },
) {
    const results = [];
    let seed = 65537;
    for (const kind of [1, 3, 5]) for (const [width, height] of [[4, 4], [16, 16], [64, 64], [257, 129], [1024, 1024]]) {
        const format = 0x00545844 | ((kind + 0x30) << 24);
        const pitch = dxtRowPitch(format, width) + (width % 4 ? 7 : 0);
        const src = new Uint8Array(Math.ceil(height / 4) * pitch);
        for (let i = 0; i < src.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; src[i] = seed; }
        const old = new Uint8Array(width * height * 4), next = new Uint8Array(old.length);
        const before = () => baselineDxt.decodeDxtToRgba(format, src, pitch, width, height, old);
        const after = () => decodeDxtToRgba(format, src, pitch, width, height, next);
        before(); after();
        if (!next.every((value, i) => value === old[i])) throw new Error("DXT output mismatch");
        const iterations = Math.max(8, Math.min(2000, Math.floor(1500000 / (width * height))));
        results.push({ case: `DXT${kind} ${width}x${height}`, ...measure(before, after, iterations) });
    }
    const config = EmulatorConfig.getInstance(), saved = config.quality;
    config.quality = { ...saved, anisotropy: 1, forceTrilinear: false };
    try {
        const fakeDevice = { createSampler: (d: GPUSamplerDescriptor) => ({ ...d }) } as unknown as GPUDevice;
        const old = new baselineSampler.DxSamplerCache(fakeDevice), next = new DxSamplerCache(fakeDevice);
        const states: SamplerSpec[] = Array.from({ length: 64 }, (_, i) => ({
            min: i & 1 ? "nearest" : "linear", mag: "linear", mip: i & 2 ? "nearest" : "linear",
            mipNone: !!(i & 4), addressU: i & 8 ? "repeat" : "clamp-to-edge", addressV: "repeat",
            maxMipLevel: i >> 4,
        }));
        let a = 0, b = 0;
        results.push({ case: "Sampler cache hit (64 rotating states)", ...measure(
            () => { old.acquire(states[a++ & 63]); }, () => { next.acquire(states[b++ & 63]); }, 200000,
        ) });
    } finally { config.quality = saved; }
    return results;
}
