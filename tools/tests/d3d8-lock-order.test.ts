import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { System } from '../../src/worker/core/system';
import { createResourcesExports } from '../../src/worker/modules/d3d8/resources';
import { resourceToDevice, surfaceInfo } from '../../src/worker/modules/d3d8/shared-state';
import type { RenderSurface } from '../../src/worker/modules/ddraw/com-objects';
import type { D3D8DeviceAdapter } from '../../src/worker/backends/webgpu/d3d8/d3d8-device-adapter';

let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; resourceToDevice.delete(100); surfaceInfo.delete(100); });

function fixture() {
    const memory = new Uint8Array(8192), view = new DataView(memory.buffer), order: string[] = [];
    const surface = {
        surfaceType: 'render_surface', mode: 'CPU', surfacePtr: 4096,
        width: 1, height: 1, pitch: 4, format: { bpp: 32 }, gpuTexture: {},
        version: 1, lastUploadVersion: 1, gpuWrittenVersion: 0, gpuDirty: false,
    } as RenderSurface;
    const adapter = {
        renderTarget: surface,
        flushProgrammablePending: () => order.push('programmable'),
        renderer: {
            flush: () => {
                order.push('ffp'); surface.version++;
                surface.gpuWrittenVersion = surface.version;
                surface.lastUploadVersion = surface.version;
            },
            syncSurfaceToMemory: async () => { order.push('readback'); view.setUint32(4096, 0xff123456, true); },
        },
    } as unknown as D3D8DeviceAdapter;
    resourceToDevice.set(100, adapter);
    surfaceInfo.set(100, { texturePtr: 0, level: 0, surface, d3dFormat: 22, role: 'backbuffer' });
    const spy = spyOn(System, 'getInstance').mockReturnValue({ process: {} } as System);
    restore = () => spy.mockRestore();
    return { memory, view, order };
}

describe('D3D8 render-surface lock ordering', () => {
    test('flushes queued GPU terrain before deciding whether the lock needs readback', async () => {
        const { memory, view, order } = fixture();
        expect(await createResourcesExports().IDirect3DSurface8_LockRect({} as any, memory, [100, 128, 0, 0])).toBe(0);
        expect(order).toEqual(['programmable', 'ffp', 'readback']);
        expect(view.getUint32(128, true)).toBe(4);
        expect(view.getUint32(132, true)).toBe(4096);
        expect(view.getUint32(4096, true)).toBe(0xff123456);
    });
    test('orders a discard after queued draws without reading discarded GPU pixels', async () => {
        const { memory, view, order } = fixture();
        view.setUint32(4096, 0xffffffff, true);
        expect(await createResourcesExports().IDirect3DSurface8_LockRect({} as any, memory, [100, 128, 0, 0x2000])).toBe(0);
        expect(order).toEqual(['programmable', 'ffp']);
        expect(view.getUint32(4096, true)).toBe(0);
    });
});
