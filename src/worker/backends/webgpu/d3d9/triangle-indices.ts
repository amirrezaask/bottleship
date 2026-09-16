/** Expand D3D9 strips/fans without WebGPU's implicit primitive-restart indices. */
export function expandTriangleIndices(
    type: number,
    primitiveCount: number,
    start: number,
    source?: { bytes: Uint8Array; indexBytes: 2 | 4 },
): Uint32Array | null {
    // At most 12 MiB of conversion scratch for one admitted geometry draw.
    if ((type !== 5 && type !== 6) || !Number.isSafeInteger(primitiveCount)
        || primitiveCount < 1 || primitiveCount > 1_048_576
        || !Number.isSafeInteger(start) || start < 0) return null;
    const end = start + primitiveCount + 2;
    if (end > 0xffffffff || (source && end * source.indexBytes > source.bytes.byteLength)) return null;
    const view = source && new DataView(source.bytes.buffer, source.bytes.byteOffset, source.bytes.byteLength);
    const at = (i: number): number => !source ? i
        : source.indexBytes === 2 ? view!.getUint16(i * 2, true) : view!.getUint32(i * 4, true);
    const result = new Uint32Array(primitiveCount * 3);
    for (let i = 0; i < primitiveCount; i++) {
        const a = type === 6 ? start : start + i + (i & 1);
        const b = type === 6 ? start + i + 1 : start + i + 1 - (i & 1);
        result[i * 3] = at(a);
        result[i * 3 + 1] = at(b);
        result[i * 3 + 2] = at(start + i + 2);
    }
    return result;
}
