import { expect, test } from "bun:test";
import { UniformArena } from "../../src/worker/backends/webgpu/d3d9/d3d9-backend-executor";

test("uniform snapshots keep separate draws and batch one write per pass", () => {
    globalThis.GPUBufferUsage ??= { UNIFORM: 64, COPY_DST: 8, COPY_SRC: 4, INDEX: 16, VERTEX: 32 } as never;
    const buffers: any[] = [], writes: Float32Array[] = [];
    const gpu = { createBuffer({ size }: any) { const b = { size, destroyed: false, destroy() { this.destroyed = true; } }; buffers.push(b); return b; } };
    const queue = { writeBuffer(_buffer: unknown, _offset: number, data: Float32Array, start: number, count: number) { writes.push(data.slice(start, start + count)); } };
    const arena = new UniformArena(gpu as never, "test");
    arena.begin(1024); const source = new Float32Array([1, 2, 3, 4]);
    expect(arena.write(queue as never, source, 4)).toBe(0);
    source.fill(9); expect(arena.write(queue as never, source, 4)).toBe(256);
    expect(writes).toHaveLength(0); arena.flush(queue as never);
    expect(writes).toHaveLength(1); expect([...writes[0].slice(0, 4)]).toEqual([1, 2, 3, 4]);
    expect([...writes[0].slice(64, 68)]).toEqual([9, 9, 9, 9]);
    arena.begin(1024); source.fill(5); arena.write(queue as never, source, 4); arena.flush(queue as never);
    expect(buffers).toHaveLength(1); expect([...writes[1].slice(0, 4)]).toEqual([5, 5, 5, 5]);
    expect(() => arena.begin(UniformArena.MAX_BYTES + 1)).toThrow();
    arena.dispose(); expect(buffers[0].destroyed).toBe(true);
});
