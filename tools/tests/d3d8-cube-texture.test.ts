import { describe, expect, test } from 'bun:test';
import { D3D8CubeTexture } from '../../src/worker/backends/webgpu/d3d8/cube-texture';
import { decodeD3DTextureToRgba8, getD3DTextureLayout } from '../../src/worker/backends/webgpu/shared/texture-formats';
import { IDirect3DCubeTexture8 } from '../../src/worker/api/d3d8.api';

const dxt1 = 0x31545844;
function memory() {
    const allocated: number[] = [], freed: number[] = [];
    return { allocated, freed, alloc: (size: number) => { allocated.push(size); return 4096; },
        free: (ptr: number) => { freed.push(ptr); } };
}

describe('D3D8 cube textures', () => {
    test('six compressed faces retain independent, non-overlapping mip storage', () => {
        const allocator = memory();
        const cube = new D3D8CubeTexture(8, 4, dxt1, allocator);
        const bytes = new Uint8Array(8192);
        let end = cube.guestPtr;
        for (let face = 0; face < 6; face++) for (let level = 0; level < 4; level++) {
            const surface = cube.getFace(face, level)!;
            expect(surface.surfacePtr).toBe(end);
            const layout = getD3DTextureLayout(dxt1, surface.width, surface.height);
            expect(surface.pitch).toBe(layout.pitch);
            // Red DXT1 block, including sub-4x4 mip tails.
            bytes[surface.surfacePtr] = 0x00; bytes[surface.surfacePtr + 1] = 0xf8;
            decodeD3DTextureToRgba8(bytes, surface.surfacePtr, surface.width, surface.height, dxt1,
                { pitch: surface.pitch, out: surface.rgbaScratch });
            expect([...surface.rgbaScratch.slice(0, 4)]).toEqual([255, 0, 0, 255]);
            end += layout.bytes;
        }
        expect(allocator.allocated).toEqual([end - cube.guestPtr]);
        expect(cube.getFace(6, 0)).toBeUndefined();
        expect(cube.getFace(0, 4)).toBeUndefined();
        cube.destroy(); cube.destroy();
        expect(allocator.freed).toEqual([4096]);
        expect(cube.faces).toHaveLength(0);
    });
    test('uploads each dirty face/mip to a cube layer once, and destroys its GPU allocation', () => {
        (globalThis as any).GPUTextureUsage = { TEXTURE_BINDING: 4, COPY_DST: 2 };
        const writes: any[] = [], descriptors: any[] = []; let destroyed = 0;
        const texture = { createView: (desc: any) => { expect(desc.dimension).toBe('cube'); return {}; },
            destroy: () => { destroyed++; } };
        const device = { createTexture: (desc: any) => { descriptors.push(desc); return texture; },
            queue: { writeTexture: (...args: any[]) => writes.push(args) } } as any;
        const cube = new D3D8CubeTexture(8, 4, dxt1, memory());
        for (const surface of cube.faces) surface.gpuNeedsUpload = true;
        cube.ensureView(device); cube.ensureView(device);
        expect(descriptors).toHaveLength(1); expect(writes).toHaveLength(24);
        for (let i = 0; i < writes.length; i++) {
            expect(writes[i][0].origin).toEqual([0, 0, Math.floor(i / 4)]);
            expect(writes[i][0].mipLevel).toBe(i % 4);
        }
        cube.getFace(5, 3)!.gpuNeedsUpload = true;
        cube.ensureView(device); expect(writes).toHaveLength(25);
        cube.destroy(); expect(destroyed).toBe(1);
    });
    test('refuses oversized or invalid allocations before touching guest memory', () => {
        const allocator = memory();
        for (const [edge, levels] of [[4096, 13], [8, 5], [0, 1], [7, 1]])
            expect(() => new D3D8CubeTexture(edge, levels, dxt1, allocator)).toThrow();
        expect(allocator.allocated).toHaveLength(0);
    });
    test('cube vtable has the DX8 resource/base/face method order', () => {
        expect(IDirect3DCubeTexture8.methods!.map(m => m.name)).toEqual([
            'QueryInterface', 'AddRef', 'Release', 'GetDevice', 'SetPrivateData', 'GetPrivateData',
            'FreePrivateData', 'SetPriority', 'GetPriority', 'PreLoad', 'GetType', 'SetLOD', 'GetLOD',
            'GetLevelCount', 'GetLevelDesc', 'GetCubeMapSurface', 'LockRect', 'UnlockRect', 'AddDirtyRect',
        ]);
    });
});
