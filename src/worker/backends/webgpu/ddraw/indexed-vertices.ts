/** Derive the conversion range from actual indices, never from API MinIndex hints. */
export function indexedVertexRange(
  indices: DataView,
  count: number,
  wide: boolean,
  capacity: number,
) {
  if (!count) return { base: 0, count: capacity };
  let min = Infinity;
  let max = 0;
  for (let i = 0; i < count; i++) {
    const value = wide ? indices.getUint32(i * 4, true) : indices.getUint16(i * 2, true);
    if (value < min) min = value;
    if (value > max) max = value;
  }
  // Preserve the old bounded conversion for malformed/out-of-range indices.
  const base = max < capacity ? min : 0;
  return { base, count: Math.min(capacity, max + 1) - base };
}

/** Gather sparse draws in index order. Duplicate vertices preserve strip/fan topology.
 * The executor consumes this scratch storage synchronously before the next gather.
 */
export class IndexedVertexGather {
  private bytes = new Uint8Array(0);
  private result = { memory: this.bytes, indicesAddr: 0 };

  gather(
    memory: Uint8Array, verticesAddr: number, capacity: number, stride: number,
    indicesAddr: number, count: number, wide: boolean,
  ): { memory: Uint8Array; indicesAddr: number } | null {
    // Keep sequential indices below the uint16 primitive-restart sentinel and
    // bound scratch growth even for a malformed guest draw.
    if (!Number.isSafeInteger(count) || count <= 0 || count > 65535 ||
        !Number.isSafeInteger(stride) || stride <= 0 || stride > 256 ||
        !Number.isSafeInteger(verticesAddr) || verticesAddr < 0 ||
        !Number.isSafeInteger(indicesAddr) || indicesAddr < 0 ||
        !Number.isSafeInteger(capacity) || capacity <= 0) return null;
    const indexSize = wide ? 4 : 2;
    // v86 can supply a growth-aware Proxy: resolve it once for this synchronous
    // copy, never once per byte. Do not retain this view across guest execution.
    const sourceBytes = new Uint8Array(memory.buffer, memory.byteOffset, memory.length);
    if (indicesAddr + count * indexSize > sourceBytes.byteLength) return null;
    const indices = new DataView(sourceBytes.buffer, sourceBytes.byteOffset + indicesAddr, count * indexSize);
    const readIndex = (i: number) => wide ? indices.getUint32(i * 4, true) : indices.getUint16(i * 2, true);
    for (let i = 0; i < count; i++) {
      const index = readIndex(i);
      if (index >= capacity || index === (wide ? 0xffffffff : 0xffff) ||
          verticesAddr + (index + 1) * stride > sourceBytes.byteLength) return null;
    }
    const outputIndices = Math.ceil(count * stride / 4) * 4;
    // The CPU converter creates whole-buffer Float32/Uint32 views.
    const needed = Math.ceil((outputIndices + count * indexSize) / 4) * 4;
    if (needed > this.bytes.byteLength) {
      this.bytes = new Uint8Array(needed);
      this.result.memory = this.bytes;
    }
    const output = new DataView(this.bytes.buffer);
    for (let i = 0; i < count; i++) {
      const source = verticesAddr + readIndex(i) * stride;
      const target = i * stride;
      for (let byte = 0; byte < stride; byte++) this.bytes[target + byte] = sourceBytes[source + byte];
      if (wide) output.setUint32(outputIndices + i * 4, i, true);
      else output.setUint16(outputIndices + i * 2, i, true);
    }
    this.result.indicesAddr = outputIndices;
    return this.result;
  }
}
