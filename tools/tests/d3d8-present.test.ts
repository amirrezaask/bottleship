import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { D3D8DeviceAdapter } from '../../src/worker/backends/webgpu/d3d8/d3d8-device-adapter';
import { System } from '../../src/worker/core/system';
import { framePacer } from '../../src/worker/core/frame-pacer';
import { statsOverlay } from '../../src/worker/core/stats-overlay';

const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

function fixture(dirty: boolean) {
    const order: string[] = [];
    let gpuPixel = 0xff332211;
    const cpuPixel = 0xffeeccaa;
    const target = {
        surfaceType: 'render_surface', mode: 'CPU', surfacePtr: 4096,
        width: 1, height: 1, format: { bpp: 32 }, gpuTexture: {}, gpuTextureView: {},
        gpuDirty: dirty, version: dirty ? 2 : 1, lastUploadVersion: 1,
    };
    const encoder = { finish: () => ({}) };
    const device = { createCommandEncoder: () => encoder };
    const queue = { submit: () => order.push('submit') };
    const context = { getCurrentTexture: () => ({ createView: () => ({}) }) };
    const backend = {
        kind: 'webgpu', getDevice: () => device, getQueue: () => queue,
        getContext: () => context,
        drawTexture: () => { order.push('copy'); expect(gpuPixel).toBe(dirty ? cpuPixel : 0xff332211); },
    };
    const adapter = Object.create(D3D8DeviceAdapter.prototype) as D3D8DeviceAdapter;
    Object.assign(adapter, {
        renderTarget: target, drawDiagCount: 0, drawDiagMaxPerFrame: 0,
        presentCount: 10, prevPresentTime: 0, frameSnapshot: {},
        flushProgrammablePending: () => order.push('flush'),
        renderer: {
            syncSurfaceFromMemory: (surface: typeof target) => {
                expect(surface).toBe(target); order.push('upload');
                gpuPixel = cpuPixel; surface.gpuDirty = false; surface.lastUploadVersion = surface.version;
            },
            finalizePendingDraws: () => { order.push('finalize'); return encoder; },
            ringBufferManager: { flushUniforms() {}, flushStorageBuffer() {}, nextFrame() {} },
            sampleFrameStats() {}, postSubmitCleanup() {},
        },
    });
    const system = {
        services: { render: { getBackend: () => backend, getActive: () => adapter, notifyPresent() {} } },
        gdiContext: { getOverlayCanvas: () => null },
        videoRouting: { getOverlayService: () => ({ getCanvas: () => null }) },
    };
    spies.push(spyOn(System, 'getInstance').mockReturnValue(system as unknown as System));
    spies.push(spyOn(framePacer, 'waitForFrameSlot').mockResolvedValue(undefined));
    spies.push(spyOn(framePacer, 'reserveFrameSlot').mockImplementation(() => {}));
    spies.push(spyOn(framePacer, 'releaseFrameSlot').mockImplementation(() => {}));
    spies.push(spyOn(statsOverlay, 'isEnabled').mockReturnValue(false));
    return { adapter, order, target };
}

describe('D3D8 backbuffer presentation', () => {
    test('presents CPU sprites written after GPU terrain in the same frame', async () => {
        const { adapter, order, target } = fixture(true);
        expect(await adapter.present()).toBe(0);
        expect(order).toEqual(['flush', 'upload', 'finalize', 'copy', 'submit']);
        expect(target.gpuDirty).toBe(false);
    });

    test('preserves GPU content when the CPU backbuffer has not changed', async () => {
        const { adapter, order } = fixture(false);
        expect(await adapter.present()).toBe(0);
        expect(order).toEqual(['flush', 'finalize', 'copy', 'submit']);
    });

    test('never overwrites a GPU-only target with stale CPU backing', async () => {
        const { adapter, order, target } = fixture(false);
        target.mode = 'GPU_ONLY';
        target.gpuDirty = true;
        target.version = 2;
        expect(await adapter.present()).toBe(0);
        expect(order).toEqual(['flush', 'finalize', 'copy', 'submit']);
    });
});
