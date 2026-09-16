import { afterEach, beforeEach, expect, test } from 'bun:test';
import { System } from '../../src/worker/core/system';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { ThunkGenerator } from '../../src/worker/core/thunking/thunk-generator';
import { createResourcesExports } from '../../src/worker/modules/d3d9/resources';
import { devices, resetD3D9SharedState } from '../../src/worker/modules/d3d9/shared-state';
import { indexBufferMeta, vertexBufferMeta } from '../../src/worker/modules/d3d9/resource-registry';
import { D3D9Device } from '../../src/worker/backends/webgpu/d3d9/d3d9-device';
const system = System.getInstance(), exports = createResourcesExports();
let previous: typeof system.process, memory: Uint8Array, view: DataView;
const call = (name: string, args: number[]) => exports[name]!({} as never, memory, args);
beforeEach(() => {
    previous = system.process;
    memory = new Uint8Array(256 * 1024); view = new DataView(memory.buffer); Mem.bind(() => memory);
    let pointer = 0x1000;
    const thunks = new ThunkGenerator(); thunks.setBaseAddress(0x10000, 128 * 1024);
    system.process = { thunkGenerator: thunks, getCurrentMemory: () => memory,
        memory: { alloc: () => pointer += 4, allocAt() {} }, dispatcher: { applyPendingRegistrations() {} },
    } as never;
    resetD3D9SharedState();
    devices.set(0x800, { createVertexBuffer: () => 0x2000, createIndexBuffer: () => 0x3000,
        releaseVertexBuffer() {}, releaseIndexBuffer() {}, disposeTransientResources() {}, resetSubsystemPerf() {},
    } as never);
});
afterEach(() => { resetD3D9SharedState(); system.process = previous; Mem.bind(() => previous?.getCurrentMemory() ?? new Uint8Array()); });

test('buffer descriptors preserve native size, format, usage and lifetime for the guest reuse cache', () => {
    for (const [kind, size, usage, format, pool, type] of [
        ['Index', 512, 8, 101, 1, 7], ['Index', 7548, 0x208, 102, 0, 7], ['Vertex', 8192, 0x200, 0x112, 2, 6],
    ] as const) {
        expect(call(`IDirect3DDevice9_Create${kind}Buffer`, [0x800, size, usage, format, pool, 0x200])).toBe(0);
        const pointer = view.getUint32(0x200, true), bytes = type === 6 ? 24 : 20;
        memory.fill(0xcc, 0x2fc, 0x320);
        expect(call(`IDirect3D${kind}Buffer9_GetDesc`, [pointer, 0x300])).toBe(0);
        const expected = [type === 6 ? 100 : format, type, usage, pool, size];
        if (type === 6) expected.push(format);
        expect(Array.from(new Uint32Array(memory.buffer, 0x300, bytes / 4))).toEqual(expected);
        expect(view.getUint32(0x2fc, true)).toBe(0xcccccccc);
        expect(view.getUint32(0x300 + bytes, true)).toBe(0xcccccccc);
        expect(call(`IDirect3D${kind}Buffer9_GetDesc`, [pointer, memory.length - bytes + 1])).toBe(0x8876086c);
        expect(call(`IDirect3D${kind}Buffer9_AddRef`, [pointer])).toBe(2);
        expect(call(`IDirect3D${kind}Buffer9_Release`, [pointer])).toBe(1);
        expect(call(`IDirect3D${kind}Buffer9_GetDesc`, [pointer, 0x300])).toBe(0);
        expect(call(`IDirect3D${kind}Buffer9_Release`, [pointer])).toBe(0);
        expect(call(`IDirect3D${kind}Buffer9_GetDesc`, [pointer, 0x300])).toBe(0x8876086c);
    }
    expect(indexBufferMeta.size).toBe(0); expect(vertexBufferMeta.size).toBe(0);
});

test('rejects the observed oversized index draw before it can invalidate the GPU frame', () => {
    const device = Object.create(D3D9Device.prototype) as any;
    device.captureDrawIfArmed = () => {};
    device.stateTracker = { getStreamSource: () => ({ index: 0 }), getIndexSource: () => 0 };
    device.vertexBuffers = { getData: () => new Uint8Array(4096) };
    device.indexBuffers = { getData: () => new Uint8Array(512), getFormat: () => 101 };
    expect(device.drawIndexedPrimitive(4, 77, 0, 4096, 0, 1258)).toBe(0x8876086c);
    expect(device.drawIndexedPrimitive(5, 0, 0, 4096, 255, 1)).toBe(0x8876086c);
    expect(device.drawIndexedPrimitive(6, 0, 0, 4096, -1, 1)).toBe(0x8876086c);
});
