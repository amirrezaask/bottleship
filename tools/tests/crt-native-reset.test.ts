import { expect, test } from "bun:test";
import { System } from "../../src/worker/core/system";
import { ensureNativeQsort, resetNativeQsort } from "../../src/worker/modules/crt-qsort";
import { ensureNativeCBsearch, resetNativeCBsearch } from "../../src/worker/modules/crt-cbsearch";

test("system reset invalidates native CRT pointers before DLL aliases publish exports", async () => {
    const system = System.getInstance();
    const previous = system.process;
    const memory = new Uint8Array(0x10000);
    let next = 0x1000;
    const published: number[] = [];
    const process = {
        memory: { alloc(size: number) { const p = next; next += (size + 15) & ~15; return p; } },
        getCurrentMemory: () => memory,
        modules: new Map(),
        dispatcher: { registerModule() {} },
        async reset() { memory.fill(0xcc); next = 0x4000; },
    };
    resetNativeQsort();
    resetNativeCBsearch();
    const oldSort = ensureNativeQsort(process as never);
    const oldSearch = ensureNativeCBsearch(process as never);
    for (const name of ["msvcrt", "crtdll"]) process.modules.set(name, {
        name, exports: {},
        reregisterExports() { published.push(ensureNativeQsort(process as never), ensureNativeCBsearch(process as never)); },
    });
    try {
        system.process = process as never;
        await system.reset();
        expect(published[0]).not.toBe(oldSort);
        expect(published[1]).not.toBe(oldSearch);
        expect(published.slice(0, 2)).toEqual(published.slice(2));
        expect(memory[published[0]!]).toBe(0x55);
        expect(memory[published[1]!]).toBe(0x55);
        expect(memory[oldSort]).toBe(0xcc);
    } finally {
        system.process = previous;
        resetNativeQsort();
        resetNativeCBsearch();
    }
});
