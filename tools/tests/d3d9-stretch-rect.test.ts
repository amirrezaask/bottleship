import { afterEach, expect, test } from "bun:test";
import { readSurfaceRect } from "../../src/worker/backends/webgpu/d3d9/surface-blitter";
import { createDeviceExports } from "../../src/worker/modules/d3d9/device";
import { devices, resourceToDevice } from "../../src/worker/modules/d3d9/shared-state";
import { deviceBackBuffers, surfaceMeta } from "../../src/worker/modules/d3d9/resource-registry";

const mem = new Uint8Array(128);
const stretch = createDeviceExports().IDirect3DDevice9_StretchRect!;
afterEach(() => { devices.delete(1); resourceToDevice.delete(2); resourceToDevice.delete(3); deviceBackBuffers.delete(1); surfaceMeta.delete(2); surfaceMeta.delete(3); });

test("rectangle reads honor byte offsets and reject truncated or out-of-surface regions", () => {
    const bytes = new Uint8Array(80).subarray(16);
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    [1, 2, 8, 9].forEach((v, i) => view.setInt32(4 + i * 4, v, true));
    expect(readSurfaceRect(bytes, 0, 10, 10)).toEqual({ left: 0, top: 0, right: 10, bottom: 10 });
    expect(readSurfaceRect(bytes, 4, 10, 10)).toEqual({ left: 1, top: 2, right: 8, bottom: 9 });
    expect(readSurfaceRect(bytes, 4, 7, 10)).toBeNull();
    expect(readSurfaceRect(bytes, 60, 10, 10)).toBeNull();
    view.setInt32(4, -1, true);
    expect(readSurfaceRect(bytes, 4, 10, 10)).toBeNull();
});

test("screen copies resolve owning textures and return real backend failures", () => {
    let recorded: unknown;
    const device = { stretchRect: (...args: unknown[]) => { recorded = args; return 123; } } as any;
    devices.set(1, device); resourceToDevice.set(2, device); resourceToDevice.set(3, device); deviceBackBuffers.set(1, 2);
    const meta = { format: 22, type: 1, usage: 1, pool: 0, multiSampleType: 0, multiSampleQuality: 0, width: 800, height: 600 };
    surfaceMeta.set(2, meta); surfaceMeta.set(3, { ...meta, width: 512, height: 512, texturePtr: 4 });
    expect(stretch({} as never, mem, [1, 2, 0, 3, 0, 2])).toBe(123);
    expect(recorded).toEqual([0, 4, { left: 0, top: 0, right: 800, bottom: 600 }, { left: 0, top: 0, right: 512, bottom: 512 }, 2]);
    for (const args of [[1, 2, 0, 2, 0, 0], [1, 2, 0, 3, 0, 3], [1, 2, 120, 3, 0, 0]]) {
        expect(stretch({} as never, mem, args)).toBe(0x8876086c);
    }
    surfaceMeta.set(3, { ...meta, texturePtr: 4, level: 1 });
    expect(stretch({} as never, mem, [1, 2, 0, 3, 0, 2])).toBe(0x8876086c);
});
