import { test } from "bun:test";
import assert from "node:assert/strict";
import { DxSamplerCache, type SamplerSpec } from "../../src/worker/backends/webgpu/shared/dx-sampler";
import { EmulatorConfig } from "../../src/worker/core/emulator-config-manager";

const spec = (extra: Partial<SamplerSpec> = {}): SamplerSpec => ({
    min: "linear", mag: "linear", mip: "nearest", mipNone: true,
    addressU: "repeat", addressV: "repeat", ...extra,
});

test("numeric sampler cache has no collisions across effective descriptors", () => {
    const config = EmulatorConfig.getInstance(), original = config.quality;
    const seen = new Map<string, GPUSampler>();
    let count = 0;
    const cache = new DxSamplerCache({ createSampler: (d: GPUSamplerDescriptor) => ({ ...d, id: ++count }) } as unknown as GPUDevice);
    try {
        for (const quality of [{ anisotropy: 1, forceTrilinear: false }, { anisotropy: 8, forceTrilinear: false }, { anisotropy: 1, forceTrilinear: true }]) {
            config.quality = { ...original, ...quality };
            for (const min of ["nearest", "linear"] as const) for (const mag of ["nearest", "linear"] as const) {
                for (const mip of ["nearest", "linear"] as const) for (const mipNone of [false, true]) {
                    for (const addressU of ["repeat", "mirror-repeat", "clamp-to-edge"] as const) {
                        for (const addressV of ["repeat", "mirror-repeat", "clamp-to-edge"] as const) {
                            for (const addressW of ["repeat", "mirror-repeat", "clamp-to-edge"] as const) {
                                for (const gameAnisotropy of [1, 2, 4, 8, 16, 999]) for (const maxMipLevel of [0, 1, 1.5, 2, 32]) {
                                    const s = spec({ min, mag, mip, mipNone, addressU, addressV, addressW, gameAnisotropy, maxMipLevel });
                                    const expected = DxSamplerCache.resolveDescriptor(s, quality);
                                    const key = JSON.stringify(expected);
                                    const actual = cache.acquire(s);
                                    const { id: _id, ...descriptor } = actual as unknown as Record<string, unknown>;
                                    assert.deepEqual(descriptor, expected);
                                    if (seen.has(key)) assert.strictEqual(actual, seen.get(key));
                                    else { assert.equal(count, seen.size + 1); seen.set(key, actual); }
                                }
                            }
                        }
                    }
                }
            }
        }
        assert.equal(count, seen.size);
        const before = cache.acquire(spec());
        cache.clear();
        assert.notStrictEqual(cache.acquire(spec()), before);
    } finally { config.quality = original; }
});

test("reused descriptor clears LOD fields and observes in-place quality updates", () => {
    const config = EmulatorConfig.getInstance(), original = config.quality;
    config.quality = { ...original, anisotropy: 1, forceTrilinear: false };
    const cache = new DxSamplerCache({ createSampler: (d: GPUSamplerDescriptor) => ({ ...d }) } as unknown as GPUDevice);
    try {
        const pinned = cache.acquire(spec({ maxMipLevel: 2 }));
        const open = cache.acquire(spec({ mipNone: false }));
        assert.equal((open as GPUSamplerDescriptor).lodMinClamp, undefined);
        assert.equal((open as GPUSamplerDescriptor).lodMaxClamp, undefined);
        assert.equal((pinned as GPUSamplerDescriptor).lodMaxClamp, 2);
        config.quality.anisotropy = 8;
        const enhanced = cache.acquire(spec({ mipNone: false }));
        assert.notStrictEqual(enhanced, open);
        assert.equal((enhanced as GPUSamplerDescriptor).maxAnisotropy, 8);
        config.quality.anisotropy = 1;
        assert.strictEqual(cache.acquire(spec({ mipNone: false })), open);
    } finally { config.quality = original; }
});
