import { expect, test } from "bun:test";
import { GuestStagingPool } from "../../src/worker/backends/webgpu/d3d9/guest-staging-pool";
import { D3D9Device } from "../../src/worker/backends/webgpu/d3d9/d3d9-device";
import { System } from "../../src/worker/core/system";
import { Mem } from "../../src/worker/core/memory/mem-accessor";

function allocator() {
    let next = 4096;
    const allocated = new Map<number, number>();
    const freed: number[] = [];
    return { allocated, freed,
        alloc(bytes: number) { const pointer = next; next += bytes; allocated.set(pointer, bytes); return pointer; },
        free(pointer: number) { expect(allocated.delete(pointer)).toBe(true); freed.push(pointer); },
    };
}

test("geometry locks reuse scratch without aliasing simultaneous locks", () => {
    const heap = allocator(), pool = new GuestStagingPool(heap);
    const a = pool.acquire(6000), b = pool.acquire(5000);
    expect(a).not.toBe(b);
    pool.release(a);
    expect(pool.acquire(7000)).toBe(a);
    expect(pool.getStats()).toMatchObject({ allocations: 2, reuses: 1, activeBytes: 16384 });
    pool.dispose(); pool.dispose();
    expect(heap.allocated.size).toBe(0);
    expect(heap.freed).toHaveLength(2);
});

test("idle scratch stays bounded and large buffers are freed immediately", () => {
    const heap = allocator(), pool = new GuestStagingPool(heap);
    const pointers = Array.from({ length: 8 }, () => pool.acquire(1024 * 1024));
    for (const pointer of pointers) pool.release(pointer);
    expect(pool.getStats().idleBytes).toBe(GuestStagingPool.MAX_IDLE_BYTES);
    expect(heap.freed).toHaveLength(4);
    const large = pool.acquire(1024 * 1024 + 16);
    pool.release(large);
    expect(heap.allocated.has(large)).toBe(false);
    pool.dispose(); expect(heap.allocated.size).toBe(0);
});

test("failed allocation never becomes an active lock", () => {
    const pool = new GuestStagingPool({ alloc: () => 0, free: () => { throw Error("not allocated"); } });
    expect(pool.acquire(1024)).toBe(0);
    expect(pool.getStats()).toMatchObject({ allocations: 0, activeBytes: 0 });
    pool.dispose();
});

test("reusing vertex scratch for an index lock preserves both stores and partial writes", () => {
    const system = System.getInstance(), previous = system.process;
    const renderer = system.services.render.getActive();
    const memory = new Uint8Array(64 * 1024), heap = allocator();
    system.process = { memory: heap, getCurrentMemory: () => memory } as never;
    Mem.bind(() => memory);
    const device = new D3D9Device({ getDevice: () => null, getContext: () => null } as never, memory);
    try {
        device.createVertexBuffer(1, 64, 2); device.createIndexBuffer(2, 64, 101);
        const first = device.lockVertexBuffer(1, 0, 0);
        memory.fill(7, first, first + 64); device.unlockVertexBuffer(1, memory);
        const second = device.lockIndexBuffer(2, 0, 0);
        expect(second).toBe(first);
        expect(memory.slice(second, second + 64).every(value => value === 0)).toBe(true);
        memory.fill(9, second, second + 64); device.unlockIndexBuffer(2, memory);
        const partial = device.lockVertexBuffer(1, 8, 4);
        expect([...memory.slice(partial, partial + 4)]).toEqual([7, 7, 7, 7]);
        memory.fill(3, partial, partial + 4); device.unlockVertexBuffer(1, memory);
        const again = device.lockVertexBuffer(1, 0, 0);
        expect([...memory.slice(again, again + 16)]).toEqual([7,7,7,7,7,7,7,7,3,3,3,3,7,7,7,7]);
        device.disposeTransientResources(); // includes the still-active lock
        expect(heap.allocated.size).toBe(0);
    } finally {
        system.process = previous;
        system.services.render.setActive(renderer);
        Mem.bind(() => previous?.getCurrentMemory() ?? new Uint8Array());
    }
});
