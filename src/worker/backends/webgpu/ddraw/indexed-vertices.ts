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
