import { expect, it } from 'bun:test';
import { BufferUploads } from '../src/worker/backends/webgpu/ddraw/buffer-uploads';
import { indexedVertexRange } from '../src/worker/backends/webgpu/ddraw/indexed-vertices';
import { drawVertexBuffer } from '../src/worker/modules/ddraw/d3d/vertex-buffer-draw';

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
