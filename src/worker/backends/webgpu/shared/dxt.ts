import { decodeDxtToRgba as decodeDxtToRgbaReference, isDxtFormat, dxtBlockBytes } from "./dxt-reference";
import { tryDecodeDxtKernel } from "./dxt-kernel";

export * from "./dxt-reference";
export { decodeDxtToRgbaReference };

/** Checked public boundary. Hardware BC upload remains the preferred path. */
export function decodeDxtToRgba(
    format: number, src: Uint8Array, srcPitch: number,
    width: number, height: number, dst: Uint8Array,
): void {
    if (!isDxtFormat(format)) throw new RangeError("Unsupported DXT format");
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
        !Number.isSafeInteger(srcPitch) || width < 0 || height < 0 || srcPitch < 0) {
        throw new RangeError("Invalid DXT dimensions or pitch");
    }
    if (width === 0 || height === 0) return;
    const rowBytes = Math.ceil(width / 4) * dxtBlockBytes(format);
    const srcBytes = (Math.ceil(height / 4) - 1) * srcPitch + rowBytes;
    const dstBytes = width * height * 4;
    if (srcPitch < rowBytes || !Number.isSafeInteger(srcBytes) ||
        !Number.isSafeInteger(dstBytes) || srcBytes > src.byteLength || dstBytes > dst.byteLength) {
        throw new RangeError("DXT source/destination is too short or pitch is invalid");
    }
    if (src.buffer === dst.buffer && src.byteOffset < dst.byteOffset + dstBytes &&
        dst.byteOffset < src.byteOffset + srcBytes) {
        throw new RangeError("DXT source and destination overlap");
    }
    if (tryDecodeDxtKernel((format >>> 24) - 0x30, src, srcPitch, width, height, dst, srcBytes)) return;
    // Uint32Array requires alignment; the public byte-buffer API does not.
    if ((dst.byteOffset & 3) !== 0) {
        const aligned = new Uint8Array(dstBytes);
        decodeDxtToRgbaReference(format, src, srcPitch, width, height, aligned);
        dst.set(aligned);
        return;
    }
    decodeDxtToRgbaReference(format, src, srcPitch, width, height, dst);
}
