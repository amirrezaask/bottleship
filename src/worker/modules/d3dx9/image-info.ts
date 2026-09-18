import { Mem } from '../../core/memory/mem-accessor';

/** D3DXIMAGE_INFO is seven DWORDs, not D3DSURFACE_DESC (which contains Pool).
 * https://learn.microsoft.com/en-us/windows/win32/direct3d9/d3dximage-info
 */
export function writeImageInfo(ptr: number, image: {
    width: number; height: number; sourceMipLevels: number; imageFileFormat: number;
}): boolean {
    if (!ptr) return false;
    return Mem.writeUint32(ptr, image.width)
        && Mem.writeUint32(ptr + 4, image.height)
        && Mem.writeUint32(ptr + 8, 1)
        && Mem.writeUint32(ptr + 12, image.sourceMipLevels)
        && Mem.writeUint32(ptr + 16, 21) // Existing RGBA8 decoder's A8R8G8B8 output.
        && Mem.writeUint32(ptr + 20, 3) // D3DRTYPE_TEXTURE; decoder exposes 2D images.
        && Mem.writeUint32(ptr + 24, image.imageFileFormat);
}
