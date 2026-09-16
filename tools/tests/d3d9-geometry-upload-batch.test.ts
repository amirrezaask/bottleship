import { expect, test } from "bun:test";
import { GeometryUploadBatch } from "../../src/worker/backends/webgpu/d3d9/geometry-upload-batch";

function fixture() {
    globalThis.GPUBufferUsage ??= { UNIFORM: 64, COPY_DST: 8, COPY_SRC: 4, INDEX: 16, VERTEX: 32 } as never;
    let writes = 0, submits = 0;
    const allocations: any[] = [];
    const queue = {
        writeBuffer(buffer: any, offset: number, data: Uint8Array, start: number, size: number) {
            writes++; buffer.bytes.set(data.subarray(start, start + size), offset);
        },
        submit(commands: Array<Array<() => void>>) { submits++; for (const batch of commands) for (const copy of batch) copy(); },
    };
    const gpu = {
        createBuffer({ size }: { size: number }) { const buffer = { bytes: new Uint8Array(size), destroyed: false, destroy() { this.destroyed = true; } }; allocations.push(buffer); return buffer; },
        createCommandEncoder() {
            const copies: Array<() => void> = [];
            return { copyBufferToBuffer(source: any, start: number, target: any, offset: number, size: number) {
                copies.push(() => target.bytes.set(source.bytes.subarray(start, start + size), offset));
            }, finish: () => copies };
        },
    };
    return { pool: new GeometryUploadBatch(gpu as never), queue: queue as never, allocations, writes: () => writes, submits: () => submits };
}

test("many independent geometry uploads use one staged write", () => {
    const f = fixture();
    const data = Array.from({ length: 100 }, (_, i) => new Uint8Array(64).fill(i));
    const targets = data.map(bytes => ({ bytes: new Uint8Array(bytes.length) }));
    f.pool.upload(f.queue, targets as never, data);
    expect(f.writes()).toBe(1); expect(f.submits()).toBe(1);
    for (let i = 0; i < data.length; i++) expect(targets[i].bytes).toEqual(data[i]);
    f.pool.dispose(); expect(f.allocations[0].destroyed).toBe(true);
});

test("staging reuse across the cap preserves every chunk and later batches", () => {
    const f = fixture(), cap = GeometryUploadBatch.MAX_BYTES;
    const large = new Uint8Array(cap + 16); large.fill(13, 0, cap); large.fill(29, cap);
    const tail = new Uint8Array(64).fill(71);
    const targets = [{ bytes: new Uint8Array(large.length) }, { bytes: new Uint8Array(tail.length) }];
    f.pool.upload(f.queue, targets as never, [large, tail]);
    expect(f.writes()).toBe(2);
    expect(targets[0].bytes).toEqual(large); expect(targets[1].bytes).toEqual(tail);
    expect(f.pool.getStats().geometryUploadStagingBytes).toBe(cap);
    tail.fill(90); f.pool.upload(f.queue, [targets[1]] as never, [tail]);
    expect(targets[0].bytes).toEqual(large); expect(targets[1].bytes).toEqual(tail);
    expect(f.allocations).toHaveLength(1);
    f.pool.resetStats(); expect(f.pool.getStats().geometryUploadBatches).toBe(0);
    f.pool.dispose(); expect(f.allocations[0].destroyed).toBe(true);
});

test("partial updates inherit earlier versions without changing earlier draws", () => {
    const f = fixture();
    const first = { bytes: new Uint8Array(32) }, second = { bytes: new Uint8Array(32).fill(99) }, third = { bytes: new Uint8Array(32).fill(99) };
    const initial = new Uint8Array(32).fill(3);
    f.pool.upload(f.queue, [first, second, third] as never,
        [initial, new Uint8Array(4).fill(7), new Uint8Array(4).fill(11)],
        [0, 4, 20], [null, first, second] as never, [0, 32, 32]);
    expect(first.bytes).toEqual(initial);
    const expectedSecond = initial.slice(); expectedSecond.fill(7, 4, 8);
    expect(second.bytes).toEqual(expectedSecond);
    const expectedThird = expectedSecond.slice(); expectedThird.fill(11, 20, 24);
    expect(third.bytes).toEqual(expectedThird);
    expect(f.writes()).toBe(1);
});
