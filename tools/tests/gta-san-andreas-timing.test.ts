import { expect, test } from 'bun:test';
import { applySanAndreasTimingFix, applySanAndreasGraphicsDefault } from '../../src/worker/core/game-fixes/gta-san-andreas-timing';
import type { LoadedPEModule } from '../../src/worker/core/module-registry';

const address = 0x53e930;
function fixture() {
    const memory = new Uint8Array(address + 128);
    memory.set(Uint8Array.from('e84b3102008bf0e8043102008bc833d28bc6f7f12b05a82cb70083f80e72e1e82c3102008bf0e8e53002008bc833d28bc6f7f1a3a82cb700e8a3310200'.match(/../g)!.map(x => parseInt(x, 16))), address);
    const module = { isExecutable: true, baseAddress: 0x400000, size: 0x200000,
        sourceHash: 'f01a00ce950fa40ca1ed59df0e789848c6edcf6405456274965885d0929343ac' } as LoadedPEModule;
    return { memory, module };
}
test('only the verified secondary wait changes; timer call and stack stay intact', () => {
    const { memory, module } = fixture(), before = memory.slice();
    const invalidations: number[][] = [];
    expect(applySanAndreasTimingFix(module, memory, { jit_dirty_cache: (a, b) => invalidations.push([a, b]) })).toBe(true);
    expect(invalidations).toEqual([[address, address + 2]]);
    expect([...memory.slice(address, address + 2)]).toEqual([0xeb, 0x36]);
    expect(memory.slice(0, address)).toEqual(before.slice(0, address));
    expect(memory.slice(address + 2)).toEqual(before.slice(address + 2));
    expect(address + 2 + memory[address + 1]).toBe(0x53e968);
});
test('identity, bounds, byte and invalidation failures never partially patch', () => {
    for (const mode of ['hash', 'base', 'dll', 'bytes', 'bounds', 'missing-cpu', 'failed-invalidation']) {
        const { memory, module } = fixture();
        if (mode === 'hash') module.sourceHash = 'different';
        if (mode === 'base') module.baseAddress++;
        if (mode === 'dll') module.isExecutable = false;
        if (mode === 'bytes') memory[address + 28]++;
        if (mode === 'bounds') module.size = 1;
        const before = memory.slice();
        expect(applySanAndreasTimingFix(module, memory, mode === 'missing-cpu' ? null : { jit_dirty_cache() { if (mode === 'failed-invalidation') throw Error('no'); } })).toBe(false);
        expect(memory).toEqual(before);
    }
});


test('native Low FX default is opt-in and guarded without altering other defaults', () => {
    const { module } = fixture();
    const address = 0x573b77, memory = new Uint8Array(address + 64);
    memory.set([0x6a,0x02,0xb9,0x00,0xae,0xa9,0x00,0xe8,0xbd,0xae,0xf2,0xff], address);
    const before = memory.slice(), cpu = { jit_dirty_cache() {} };
    expect(applySanAndreasGraphicsDefault(module, memory, cpu, false)).toBe(false);
    expect(memory).toEqual(before);
    memory[address + 5] ^= 1;
    expect(applySanAndreasGraphicsDefault(module, memory, cpu, true)).toBe(false);
    memory.set(before);
    expect(applySanAndreasGraphicsDefault(module, memory, null, true)).toBe(false);
    expect(memory).toEqual(before);
    expect(applySanAndreasGraphicsDefault(module, memory, cpu, true)).toBe(true);
    before[address + 1] = 0; expect(memory).toEqual(before);
});
