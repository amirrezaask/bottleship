import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { ThunkGenerator } from "../../src/worker/core/thunking/thunk-generator";
import { createDeviceExports } from "../../src/worker/modules/d3d9/device";
import { devices, resourceToDevice, resetD3D9SharedState } from "../../src/worker/modules/d3d9/shared-state";
import { deviceBackBuffers, deviceRenderTargets, surfaceMeta } from "../../src/worker/modules/d3d9/resource-registry";

const system = System.getInstance();
const exports = createDeviceExports();
let previousProcess: typeof system.process;
let memory: Uint8Array;
let view: DataView;
let allocations: number;
const devicePtr = 0x800;
const parameters = 0x100;
const output = 0x200;
let width: number, height: number;
let boundTexture: number;

beforeEach(() => {
    previousProcess = system.process;
    memory = new Uint8Array(256 * 1024); view = new DataView(memory.buffer);
    Mem.bind(() => memory);
    allocations = 0; width = 640; height = 480; boundTexture = 0;
    const thunks = new ThunkGenerator(); thunks.setBaseAddress(0x10000, 128 * 1024);
    system.process = {
        thunkGenerator: thunks,
        getCurrentMemory: () => memory,
        memory: { alloc: () => 0x1000 + 4 * allocations++, allocAt() {} },
        dispatcher: { applyPendingRegistrations() {} },
    } as unknown as NonNullable<typeof system.process>;
    resetD3D9SharedState();
    devices.set(devicePtr, {
        reset: () => 0,
        resetSubsystemPerf() {},
        disposeTransientResources() {},
        getViewport: () => ({ width, height }),
        setRenderTarget: (_index: number, texture: number) => { boundTexture = texture; return 0; },
        noteRtResolve() {},
    } as never);
    view.setUint32(parameters + 8, 22, true);
});
afterEach(() => {
    resetD3D9SharedState();
    system.process = previousProcess;
    Mem.bind(() => previousProcess?.getCurrentMemory() ?? new Uint8Array());
});
function call(name: string, args: number[]): number {
    return exports[name]!({} as never, memory, args) as number;
}
function reset(): void { expect(call("IDirect3DDevice9_Reset", [devicePtr, parameters])).toBe(0); }
function target(index = 0): number {
    expect(call("IDirect3DDevice9_GetRenderTarget", [devicePtr, index, output])).toBe(0);
    return view.getUint32(output, true);
}

describe("D3D9 implicit render target", () => {
    test("returns a stable non-NULL backbuffer COM surface without per-query allocation", () => {
        reset(); const surface = target();
        expect(surface).not.toBe(0);
        expect(view.getUint32(surface, true)).not.toBe(0);
        expect(surfaceMeta.get(surface)).toMatchObject({ width: 640, height: 480, format: 22, usage: 1 });
        for (let i = 0; i < 100; i++) {
            expect(target()).toBe(surface);
            expect(call("IDirect3DDevice9_GetBackBuffer", [devicePtr, 0, 0, 0, output])).toBe(0);
            expect(view.getUint32(output, true)).toBe(surface);
        }
        expect(allocations).toBe(1);
    });
    test("round-trips a texture surface and restores the implicit backbuffer", () => {
        reset(); const backbuffer = target(); const surface = 0x4000;
        resourceToDevice.set(surface, devices.get(devicePtr)!);
        surfaceMeta.set(surface, { ...surfaceMeta.get(backbuffer)!, texturePtr: 0x5000 });
        expect(call("IDirect3DDevice9_SetRenderTarget", [devicePtr, 0, surface])).toBe(0);
        expect(target()).toBe(surface); expect(boundTexture).toBe(0x5000);
        expect(call("IDirect3DDevice9_SetRenderTarget", [devicePtr, 0, backbuffer])).toBe(0);
        expect(target()).toBe(backbuffer); expect(boundTexture).toBe(0);
    });
    test("rejects foreign surfaces, bad indices and absent targets", () => {
        reset(); const original = target();
        expect(call("IDirect3DDevice9_SetRenderTarget", [devicePtr, 0, 0x9000])).toBe(0x8876086c);
        expect(call("IDirect3DDevice9_SetRenderTarget", [devicePtr, 4, original])).toBe(0x8876086c);
        expect(target()).toBe(original);
        expect(call("IDirect3DDevice9_GetRenderTarget", [devicePtr, 1, output])).toBe(0x88760866);
        expect(view.getUint32(output, true)).toBe(0);
        expect(call("IDirect3DDevice9_GetBackBuffer", [devicePtr, 1, 0, 0, output])).toBe(0x8876086c);
        expect(call("IDirect3DDevice9_GetBackBuffer", [devicePtr, 0, 0, 0, 0])).toBe(0x8876086c);
    });
    test("reset refreshes metadata within one allocation, stop clears ownership", () => {
        reset(); const surface = target(); width = 800; height = 600; reset();
        expect(target()).toBe(surface); expect(allocations).toBe(1);
        expect(surfaceMeta.get(surface)).toMatchObject({ width: 800, height: 600 });
        resetD3D9SharedState();
        expect(deviceBackBuffers.size).toBe(0); expect(deviceRenderTargets.size).toBe(0);
        expect(surfaceMeta.size).toBe(0); expect(resourceToDevice.size).toBe(0);
    });
});
