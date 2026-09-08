import { expect, it } from 'bun:test';
import { BindGroupManager } from '../src/worker/backends/webgpu/ddraw/bind-group-manager';

(globalThis as any).GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };

function fixture(capacity = 64) {
    let created = 0;
    const device = {
        createBindGroupLayout: (descriptor: unknown) => ({ descriptor }),
        createBindGroup: (descriptor: unknown) => ({ descriptor, id: ++created }),
        createSampler: (descriptor: unknown) => ({ descriptor }),
    } as unknown as GPUDevice;
    const manager = new BindGroupManager(device, capacity);
    const buffer = {} as GPUBuffer;
    const views = [{}, {}, {}, {}] as GPUTextureView[];
    const samplers = Array.from({ length: 4 }, () => ({
        minFilter: 1, magFilter: 1, mipFilter: 1, addressU: 1, addressV: 1,
        maxAnisotropy: 1, maxMipLevel: 0,
    }));
    const bind = (mask = 1, offset = 0, size?: number, target = buffer) =>
        manager.createMegaBatchBindGroup(target, mask, views, samplers as any, null, offset, size);
    return { manager, buffer, views, samplers, bind, created: () => created };
}

it('reuses bindings across repeated draws and changing buffer contents', () => {
    const f = fixture();
    const group = f.bind(3);
    for (let i = 0; i < 1000; i++) {
        (f.buffer as any).contents = i;
        expect(f.bind(3)).toBe(group);
    }
    expect(f.created()).toBe(1);
});

it('keys every sampled stage, effective sampler, buffer range and buffer identity', () => {
    const f = fixture();
    const group = f.bind(15);
    for (let stage = 0; stage < 4; stage++) {
        const old = f.views[stage];
        f.views[stage] = {} as GPUTextureView;
        expect(f.bind(15)).not.toBe(group);
        f.views[stage] = old;
        expect(f.bind(15)).toBe(group);
        f.samplers[stage].addressU = 3;
        expect(f.bind(15)).not.toBe(group);
        f.samplers[stage].addressU = 1;
        expect(f.bind(15)).toBe(group);
    }
    expect(f.bind(1)).not.toBe(group);
    expect(f.bind(15, 256)).not.toBe(group);
    expect(f.bind(15, 0, 512)).not.toBe(group);
    expect(f.bind(15, 0, undefined, {} as GPUBuffer)).not.toBe(group);
    f.views[3] = {} as GPUTextureView;
    const single = f.bind(1);
    f.views[3] = {} as GPUTextureView;
    expect(f.bind(1)).toBe(single);
});

it('bounds retained groups and discards bindings when the manager is cleared', () => {
    const f = fixture(1); // Eight total entries.
    const first = f.bind();
    for (let i = 1; i <= 8; i++) f.bind(1, i * 256);
    expect(f.bind()).not.toBe(first);
    const beforeClear = f.bind();
    f.manager.clearCache();
    expect(f.bind()).not.toBe(beforeClear);
});

it('includes the fallback texture view identity in the cache key', () => {
    const f = fixture();
    const fallback = {} as GPUTextureView;
    const bind = (view: GPUTextureView) => f.manager.createMegaBatchBindGroup(
        f.buffer, 1, [null], f.samplers as any, view,
    );
    expect(bind(fallback)).toBe(bind(fallback));
    expect(bind({} as GPUTextureView)).not.toBe(bind(fallback));
});
