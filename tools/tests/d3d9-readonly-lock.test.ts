import { expect, test } from "bun:test";
import { VertexBufferStore, IndexBufferStore } from "../../src/worker/backends/webgpu/d3d9/d3d9-resources";

for (const Store of [VertexBufferStore, IndexBufferStore]) {
    test(`${Store.name}: READONLY preserves pixels and pending dirty state across growth`, () => {
        const store = new Store(1), memory = new Uint8Array(128);
        store.create(1, 16, 0, 32);
        const index = store.create(2, 16, 0, 64); // grow from one slot
        store.getData(index)!.fill(7);
        memory.fill(7, 64, 80);
        store.setDirty(index, false);
        store.lock(index, 4, 8, true);
        store.unlock(index, memory);
        expect(store.isDirty(index)).toBe(false);
        expect([...store.getData(index)!]).toEqual(new Array(16).fill(7));
        store.setDirty(index, true);
        store.lock(index, 0, 16, true);
        store.unlock(index, memory);
        expect(store.isDirty(index)).toBe(true);
        store.setDirty(index, false);
        store.lock(index, 4, 4);
        memory.fill(9, 68, 72);
        store.unlock(index, memory);
        expect(store.isDirty(index)).toBe(true);
        expect([...store.getData(index)!.subarray(4, 8)]).toEqual([9, 9, 9, 9]);
    });
}

for (const Store of [VertexBufferStore, IndexBufferStore]) {
    test(`${Store.name}: dirty spans merge, survive growth, and reset on reuse`, () => {
        const store = new Store(1), memory = new Uint8Array(128);
        const index = store.create(1, 32, 0, 32);
        expect([store.getDirtyStart(index), store.getDirtyEnd(index)]).toEqual([0, 32]);
        store.setDirty(index, false);
        store.lock(index, 13, 3); store.unlock(index, memory);
        store.lock(index, 3, 2); store.unlock(index, memory);
        store.create(2, 16, 0, 64);
        expect([store.getDirtyStart(index), store.getDirtyEnd(index)]).toEqual([3, 16]);
        store.lock(index, 0, 32, true); store.unlock(index, memory);
        expect([store.getDirtyStart(index), store.getDirtyEnd(index)]).toEqual([3, 16]);
        store.setDirty(index, false);
        store.lock(index, 24, 4); store.unlock(index, memory);
        expect([store.getDirtyStart(index), store.getDirtyEnd(index)]).toEqual([24, 28]);
        store.release(1); const reused = store.create(3, 8, 0, 32);
        expect(reused).toBe(index);
        expect([store.getDirtyStart(index), store.getDirtyEnd(index)]).toEqual([0, 8]);
    });
}
