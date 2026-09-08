import { expect, it } from 'bun:test';
import { BufferUploads } from '../src/worker/backends/webgpu/ddraw/buffer-uploads';
import { IndexedVertexGather, indexedVertexRange } from '../src/worker/backends/webgpu/ddraw/indexed-vertices';
import { drawVertexBuffer } from '../src/worker/modules/ddraw/d3d/vertex-buffer-draw';
import { VertexConverter } from '../src/worker/backends/webgpu/ddraw/compute/vertex-converter';

it('resolves a growth-aware guest proxy per draw without per-byte traps', () => {
  let live = new Uint8Array(128);
  let numericReads = 0;
  const proxy = new Proxy(live, {
    get(_target, key) {
      if (typeof key === 'string' && /^\d+$/.test(key)) numericReads++;
      return Reflect.get(live, key, live);
    },
  });
  const gather = new IndexedVertexGather();
  const read = () => gather.gather(proxy, 16, 4, 4, 0, 1, false)!.memory[0];
  live[16] = 42;
  expect(read()).toBe(42);
  live = new Uint8Array(256); // The proxy survives memory growth; its buffer changes.
  live[16] = 99;
  expect(read()).toBe(99);
  expect(numericReads).toBe(0);
});

it('converts gathered odd-length WORD draws byte-for-byte like the original vertices', () => {
  Object.assign(globalThis, { GPUShaderStage: { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 } });
  const converter = new VertexConverter({ limits: {}, createBindGroupLayout: () => ({}) } as unknown as GPUDevice, {} as GPUQueue);
  const memory = new Uint8Array(1024);
  const source = new DataView(memory.buffer);
  const order = [4, 20, 4];
  const stride = 32;
  for (const index of order) {
    const base = 16 + index * stride;
    [index, index + 1, index + 2, 1, 0, 0, 0.25, 0.75].forEach((v, i) => source.setFloat32(base + i * 4, v, true));
  }
  order.forEach((index, i) => source.setUint16(900 + i * 2, index, true));
  const gathered = new IndexedVertexGather().gather(memory, 16, 24, stride, 900, 3, false)!;
  expect(gathered.memory.byteLength % 4).toBe(0);
  const actual = converter.convertSync(gathered.memory, 0, 3, 0x112);
  order.forEach((index, i) => {
    const expected = converter.convertSync(memory, 16 + index * stride, 1, 0x112);
    expect(actual.slice(i * 64, (i + 1) * 64)).toEqual(expected.slice(0, 64));
  });
  // Alternate guest and gathered memory to exercise the converter's view cache.
  expect(converter.convertSync(gathered.memory, 0, 3, 0x112)).toEqual(actual);
});

it.each([false, true])('gathers sparse vertices without changing indexed topology (wide=%s)', (wide) => {
  // Guest subviews and odd addresses must work; preserve padding and attribute bits.
  const memory = new Uint8Array(new ArrayBuffer(1500000), 1);
  const verticesAddr = 7;
  const stride = 13;
  const original = [700, 4000, 4000, 99000, 700];
  const values = wide ? original : original.map(n => n === 99000 ? 49000 : n);
  const indicesAddr = 1300001;
  for (const index of values)
    for (let byte = 0; byte < stride; byte++) memory[verticesAddr + index * stride + byte] = index + byte;
  const indices = new DataView(memory.buffer, memory.byteOffset + indicesAddr);
  values.forEach((n, i) => wide ? indices.setUint32(i * 4, n, true) : indices.setUint16(i * 2, n, true));
  const gather = new IndexedVertexGather();
  const result = gather.gather(memory, verticesAddr, 100000, stride, indicesAddr, values.length, wide)!;
  expect(result).not.toBeNull();
  expect(result.indicesAddr % 4).toBe(0);
  const outputIndices = new DataView(result.memory.buffer, result.indicesAddr);
  const remapped = values.map((_, i) => wide ? outputIndices.getUint32(i * 4, true) : outputIndices.getUint16(i * 2, true));
  expect(remapped).toEqual([0, 1, 2, 3, 4]);
  const oldVertex = (i: number) => [...memory.slice(verticesAddr + values[i] * stride, verticesAddr + (values[i] + 1) * stride)];
  const newVertex = (i: number) => [...result.memory.slice(remapped[i] * stride, (remapped[i] + 1) * stride)];
  for (const topology of [[0, 1, 2, 1, 2, 3, 2, 3, 4], [0, 1, 2, 0, 2, 3, 0, 3, 4]])
    expect(topology.map(newVertex)).toEqual(topology.map(oldVertex));
  const storage = result.memory;
  memory[verticesAddr + values[0] * stride] = 123;
  expect(gather.gather(memory, verticesAddr, 100000, stride, indicesAddr, 3, wide)!.memory).toBe(storage);
  expect(storage[0]).toBe(123); // Reuse storage but read current guest contents.
});

it.each([false, true])('leaves invalid or restart-indexed draws on the original path (wide=%s)', (wide) => {
  const memory = new Uint8Array(128);
  const indices = new DataView(memory.buffer);
  const setIndex = (n: number) => wide ? indices.setUint32(0, n, true) : indices.setUint16(0, n, true);
  const gather = new IndexedVertexGather();
  setIndex(9);
  expect(gather.gather(memory, 4, 8, 4, 0, 1, wide)).toBeNull();
  expect(gather.gather(memory, 100, 10, 4, 0, 1, wide)).toBeNull();
  expect(gather.gather(memory, 4, 10, 4, 127, 1, wide)).toBeNull();
  expect(gather.gather(memory, 4, 10, 4, 0, 65536, wide)).toBeNull();
  setIndex(wide ? 0xffffffff : 0xffff);
  expect(gather.gather(memory, 0, 0x100000000, 1, 0, 1, wide)).toBeNull();
});

it.each([false, true])('preserves D3D7 vertex-buffer draw arguments (indexed=%s)', (indexed) => {
  const memory = new Uint8Array(128);
  const stack = new DataView(memory.buffer);
  [0x1234, 4, 0x5678, 7, 30, 0x9abc, 18, 0].forEach((v, i) => stack.setUint32(36 + i * 4, v, true));
  const calls: unknown[][] = [];
  const handler = {
    handleDrawPrimitive: (...args: any[]) => {
      calls.push(args);
    },
  };
  const lookup = (address: number) =>
    address === 0x5678
      ? { getDataPtr: () => 4096, getVertexSize: () => 32, getFVF: () => 0x112 }
      : null;
  expect(drawVertexBuffer(stack, 32, memory, indexed, lookup, handler)).toBe(0);
  expect(calls).toEqual([
    [
      0x1234,
      4,
      0x112,
      4320,
      30,
      memory,
      indexed,
      indexed ? 0x9abc : undefined,
      indexed ? 18 : undefined,
    ],
  ]);
  expect(drawVertexBuffer(stack, 32, memory, indexed, () => null, handler)).toBeNull();
  expect(calls).toHaveLength(1);
});

it.each([false, true])(
  'converts only referenced vertices with %s wide indices, including unaligned storage',
  (wide) => {
    const view = new DataView(new ArrayBuffer(100), 1);
    [15000, 15002, 15003, 15000].forEach((n, i) =>
      wide ? view.setUint32(i * 4, n, true) : view.setUint16(i * 2, n, true),
    );
    expect(indexedVertexRange(view, 4, wide, 65536)).toEqual({ base: 15000, count: 4 });
    expect(indexedVertexRange(view, 0, wide, 65536)).toEqual({ base: 0, count: 65536 });
    expect(indexedVertexRange(view, 4, wide, 100)).toEqual({ base: 0, count: 100 });
  },
);

it('keeps sparse, zero-based and large 32-bit vertex ranges intact', () => {
  const view = new DataView(new ArrayBuffer(12));
  view.setUint32(0, 70000, true);
  view.setUint32(4, 100000, true);
  view.setUint32(8, 80000, true);
  expect(indexedVertexRange(view, 3, true, 200000)).toEqual({ base: 70000, count: 30001 });
  view.setUint32(0, 0, true);
  expect(indexedVertexRange(view, 3, true, 200000)).toEqual({ base: 0, count: 100001 });
});

function fixture() {
  const writes: { target: object; offset: number; bytes: number[] }[] = [];
  const batch = new BufferUploads<object>((target, offset, bytes) =>
    writes.push({ target, offset, bytes: [...bytes] }),
  );
  return { batch, writes };
}

it('snapshots reused vertex scratch memory and batches hundreds of draws into one upload', () => {
  const { batch, writes } = fixture();
  const target = {};
  const scratch = new Uint8Array(64);
  for (let i = 0; i < 400; i++) {
    scratch.fill(i % 256);
    batch.append(target, i * 64, scratch);
  }
  scratch.fill(0);
  expect(writes).toHaveLength(0);
  batch.flush();
  expect(writes).toHaveLength(1);
  for (let i = 0; i < 400; i++)
    expect(writes[0]!.bytes.slice(i * 64, (i + 1) * 64)).toEqual(Array(64).fill(i % 256));
  batch.flush();
  expect(writes).toHaveLength(1);
});

it('keeps GPU-written gaps, ring switches, and reused allocations separate', () => {
  const { batch, writes } = fixture();
  const a = {},
    b = {};
  batch.append(a, 0, new Uint8Array([1, 2, 3, 4]));
  batch.append(a, 64, new Uint8Array([5, 6, 7, 8]));
  batch.append(b, 0, new Uint8Array([9, 10, 11, 12]));
  batch.append(a, 0, new Uint8Array([13, 14, 15, 16]));
  batch.flush();
  expect(writes.map((w) => [w.target, w.offset, w.bytes])).toEqual([
    [a, 0, [1, 2, 3, 4]],
    [a, 64, [5, 6, 7, 8]],
    [b, 0, [9, 10, 11, 12]],
    [a, 0, [13, 14, 15, 16]],
  ]);
});

it('pads odd index counts to WebGPU alignment without uploading stale bytes', () => {
  const { batch, writes } = fixture();
  const target = {};
  batch.append(target, 0, new Uint8Array(65536).fill(255));
  batch.flush();
  batch.append(target, 0, new Uint8Array([1, 2, 3, 4, 5, 6]));
  batch.append(target, 8, new Uint8Array([7, 8]));
  batch.flush();
  expect(writes[1]!.bytes).toEqual([1, 2, 3, 4, 5, 6, 0, 0, 7, 8, 0, 0]);
});

it('uploads used subviews without copying unused scratch capacity or adjacent index data', () => {
  const { batch, writes } = fixture();
  const target = {};
  const scratch = new Uint8Array(1024 * 1024).fill(255);
  scratch.fill(7, 64, 320);
  batch.append(target, 0, scratch.subarray(64, 320));
  scratch.fill(9);
  batch.append(target, 256, scratch.subarray(0, 12));
  batch.flush();
  expect(writes[0]!.bytes).toEqual([...Array(256).fill(7), ...Array(12).fill(9)]);
});
