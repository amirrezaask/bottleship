import { convertSurfaceToRGBA as convertSurfaceReference, detectPixelFormat, type FormatInfo } from './gpu-texture-reference';
import { toPlainGuestMemory } from '../../core/memory/guest-memory';
import { tryConvertPixelKernel } from '../../backends/webgpu/shared/dxt-kernel';

export * from './gpu-texture-reference';

/** One bulk boundary; the original converter remains the compatibility fallback. */
export function convertSurfaceToRGBA(
    mem: Uint8Array, surfacePtr: number, width: number, height: number, pitch: number,
    format: FormatInfo, outBuffer?: Uint8Array, colorkey?: { low: number; high: number }, palette?: Uint32Array,
): Uint8Array {
    mem = toPlainGuestMemory(mem);
    const bytes = width * height * 4;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 0 || height < 0 ||
        !Number.isSafeInteger(bytes) || !Number.isSafeInteger(surfacePtr) || !Number.isSafeInteger(pitch)) {
        throw new RangeError('Invalid surface dimensions, address or pitch');
    }
    const out = outBuffer && outBuffer.length >= bytes ? outBuffer : new Uint8Array(bytes);
    if (bytes === 0) return out;
    const kind = detectPixelFormat(format);
    if (tryConvertPixelKernel(kind, mem, surfacePtr, pitch, width, height, out, colorkey)) return out;

    const bpp = Math.max(1, format.bpp >> 3);
    const rowBytes = width * bpp;
    const end = surfacePtr + (height - 1) * pitch + rowBytes;
    const validSpan = surfacePtr >= 0 && pitch >= rowBytes && Number.isSafeInteger(end) && end <= mem.length;
    const align = bpp === 4 ? 3 : bpp === 2 ? 1 : 0;
    const unaligned = ((mem.byteOffset + surfacePtr) & align) !== 0 || (pitch & align) !== 0;
    const overlap = validSpan && mem.buffer === out.buffer &&
        mem.byteOffset + surfacePtr < out.byteOffset + bytes && out.byteOffset < mem.byteOffset + end;
    // Old Uint16/Uint32 fast paths assume alignment. Pack only exceptional layouts,
    // including aliased output, before entering the unchanged reference implementation.
    if (validSpan && (unaligned || overlap)) {
        const packed = new Uint8Array(rowBytes * height);
        for (let y = 0; y < height; y++) packed.set(mem.subarray(surfacePtr + y * pitch, surfacePtr + y * pitch + rowBytes), y * rowBytes);
        mem = packed;
        surfacePtr = 0;
        pitch = rowBytes;
    }
    const alignedOut = (out.byteOffset & 3) === 0 ? out : new Uint8Array(bytes);
    convertSurfaceReference(mem, surfacePtr, width, height, pitch, format, alignedOut, colorkey, palette);
    if (alignedOut !== out) out.set(alignedOut);
    return out;
}
