import { createTextureSurface } from '../shared/surface-factory';
import { getD3DTextureLayout } from '../shared/texture-formats';
import type { BitmapTextureSurface } from '../../../modules/ddraw/com-objects';

/** One bounded six-face resource. CPU subresources retain their native compressed
 * layout; uploads use the existing surface decoder's reusable RGBA scratch. */
export class D3D8CubeTexture {
    readonly faces: BitmapTextureSurface[] = [];
    private texture: GPUTexture | null = null;
    private view: GPUTextureView | null = null;
    readonly guestPtr: number;
    private destroyed = false;

    constructor(
        readonly edge: number,
        readonly levels: number,
        readonly format: number,
        private readonly memory: { alloc(size: number): number; free(ptr: number): unknown },
    ) {
        if (!Number.isInteger(edge) || edge < 1 || edge > 4096 || (edge & (edge - 1)) ||
            !Number.isInteger(levels) || levels < 1 || levels > Math.floor(Math.log2(edge)) + 1)
            throw new Error('Invalid cube dimensions or mip count');
        let guestBytes = 0;
        let rgbaBytes = 0;
        for (let level = 0; level < levels; level++) {
            const dim = Math.max(1, edge >>> level);
            guestBytes += 6 * getD3DTextureLayout(format, dim, dim).bytes;
            rgbaBytes += 6 * dim * dim * 4;
        }
        // Counts native pixels, decoded scratch and GPU storage, not just transport.
        if (guestBytes + 2 * rgbaBytes > 64 * 1024 * 1024) throw new Error('Cube texture exceeds 64 MiB');
        this.guestPtr = memory.alloc(guestBytes);
        let offset = this.guestPtr;
        try {
            for (let face = 0; face < 6; face++) {
                for (let level = 0; level < levels; level++) {
                    const dim = Math.max(1, edge >>> level);
                    const surface = createTextureSurface(dim, dim, format);
                    surface.surfacePtr = offset;
                    offset += getD3DTextureLayout(format, dim, dim).bytes;
                    this.faces.push(surface);
                }
            }
        } catch (error) {
            memory.free(this.guestPtr);
            throw error;
        }
    }

    getFace(face: number, level: number): BitmapTextureSurface | undefined {
        return !this.destroyed && face >= 0 && face < 6 && level >= 0 && level < this.levels ? this.faces[face * this.levels + level] : undefined;
    }

    ensureView(device: GPUDevice): GPUTextureView {
        if (this.destroyed) throw new Error("Cube texture was released");
        if (!this.texture) {
            this.texture = device.createTexture({
                size: [this.edge, this.edge, 6], mipLevelCount: this.levels,
                format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });
            this.view = this.texture.createView({ dimension: 'cube', arrayLayerCount: 6 });
        }
        for (let face = 0; face < 6; face++) {
            for (let level = 0; level < this.levels; level++) {
                const surface = this.faces[face * this.levels + level];
                if (!surface.gpuNeedsUpload) continue;
                device.queue.writeTexture(
                    { texture: this.texture, mipLevel: level, origin: [0, 0, face] },
                    surface.rgbaScratch as Uint8Array<ArrayBuffer>,
                    { bytesPerRow: surface.width * 4, rowsPerImage: surface.height },
                    [surface.width, surface.height, 1],
                );
                surface.gpuNeedsUpload = false;
            }
        }
        return this.view!;
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.texture?.destroy();
        this.texture = null;
        this.view = null;
        this.memory.free(this.guestPtr);
        this.faces.length = 0;
    }
}
