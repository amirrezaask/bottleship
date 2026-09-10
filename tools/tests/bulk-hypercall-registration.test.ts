import { test, expect } from 'bun:test';
import { HypercallDataManager } from '../../src/worker/core/cpu/hypercall-data';

function setup(version?: number) {
    const wasm_memory = new WebAssembly.Memory({initial: 2});
    const cpu = {wasm_memory, wm: {exports: version === undefined ? {} : {get_bulk_memory_abi: () => version}}};
    const manager = new HypercallDataManager();
    manager.initialize(cpu, 4096);
    return { manager, cpu, entry: (id: number) => new Uint8Array(wasm_memory.buffer)[4096 + 0x100 + id] };
}
test('new CRT leaf bindings require the exact bulk-memory ABI; old assets retain fallback', () => {
    for (const version of [undefined, 0, 1, 2]) {
        const {manager, entry} = setup(version);
        for (const [dll, name, id, handler] of [
            ['msvcrt', 'memmove', 1, 82], ['crtdll', 'memmove', 2, 82],
            ['msvcrt', 'memchr', 3, 83], ['msvcr90', 'memchr', 4, 83],
            ['MSVCR90', 'MEMMOVE', 5, 82],
        ] as const) {
            manager.registerFunction(dll, name, id);
            expect(entry(id)).toBe(version === 1 ? handler : 0);
        }
        manager.registerFunction('msvcrt', 'memcpy', 6);
        expect(entry(6)).toBe(56);
    }
});
test('bulk bindings survive WASM memory growth and do not write invalid function IDs', () => {
    const {manager, cpu, entry} = setup(1);
    manager.registerFunction('msvcrt', 'memmove', 1);
    cpu.wasm_memory.grow(1);
    manager.registerFunction('msvcrt', 'memchr', 2);
    expect(entry(1)).toBe(82); expect(entry(2)).toBe(83);
    for (const id of [-1, 0, 4096, 999999]) manager.registerFunction('msvcrt', 'memmove', id);
    expect(entry(0)).toBe(0);
    expect(entry(1)).toBe(82);
});
