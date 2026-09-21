import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { createMachine, DONE, STACK } from '../runtime-test/bulk-machine.mjs';
import { applyDeltaForce3ImageLoopFix, DELTA_FORCE_3_SOURCE_SHA256 } from '../../src/worker/core/game-fixes/delta-force-3';
import type { LoadedPEModule } from '../../src/worker/core/module-registry';

const LOOP = 0x47ceda, CONTINUE = 0x47ceef, ACCUMULATOR = 0xf64bf0, SOURCE = 0xf65000, STUB = 0x500000;
const original = new Uint8Array([
    0x8b, 0x35, 0xf0, 0x4b, 0xf6, 0x00, 0x33, 0xd2, 0x8a, 0x11,
    0x03, 0xf2, 0x48, 0x89, 0x35, 0xf0, 0x4b, 0xf6, 0x00, 0x75, 0xeb,
]);
const module = { name: 'dflw', isExecutable: true, sourceHash: DELTA_FORCE_3_SOURCE_SHA256, baseAddress: 0x400000 } as LoadedPEModule;
function install(memory: Uint8Array, invalidate = () => {}) {
    return applyDeltaForce3ImageLoopFix(module, memory, { jit_dirty_cache: invalidate }, { allocateRawCodeArea: () => STUB });
}

describe('Land Warrior image accumulator lowering', () => {
    test('fails closed on changed executable, loop bytes, or failed invalidation', () => {
        const memory = new Uint8Array(STUB + 1024);
        memory.set(original, LOOP);
        expect(applyDeltaForce3ImageLoopFix({ ...module, sourceHash: '0'.repeat(64) }, memory, { jit_dirty_cache: () => {} }, { allocateRawCodeArea: () => STUB })).toBe(false);
        expect(memory.slice(LOOP, CONTINUE)).toEqual(original);
        memory[LOOP + 10] ^= 1;
        expect(install(memory)).toBe(false);
        memory.set(original, LOOP);
        expect(install(memory, () => { throw new Error('invalidation failed'); })).toBe(false);
        expect(memory.slice(LOOP, CONTINUE)).toEqual(original);
    });

    test('matches real x86 registers and flags, including carry and mutable-byte aliases', async () => {
        const binary = await readFile(new URL('../../public/v86.wasm', import.meta.url));
        const machine = await createMachine(binary);
        try {
            const memory = machine.guest();
            const view = new DataView(memory.buffer, memory.byteOffset);
            const run = (patched: boolean, count: number, byte: number, accumulator: number, alias = -1) => {
                memory.set(original, LOOP);
                memory[CONTINUE] = 0xe9;
                view.setInt32(CONTINUE + 1, DONE - (CONTINUE + 5), true);
                if (patched) expect(install(memory)).toBe(true);
                memory[SOURCE] = byte;
                view.setUint32(ACCUMULATOR, accumulator >>> 0, true);
                machine.reg().set([count, alias < 0 ? SOURCE : ACCUMULATOR + alias, 0x12345678, 0x4321, STACK, 0x5678, 0x6789, 0x789a]);
                machine.state().setUint32(120, 0x202, true);
                machine.state().setUint32(100, 0, true);
                machine.state().setUint32(556, LOOP, true);
                machine.cpu.in_hlt[0] = 0;
                expect(machine.api.run_guest_until(DONE, 0, 1_000_000, 0, 0)).toBe(0);
                return { regs: Array.from(machine.reg(), (v: number) => v >>> 0), flags: machine.cpu.get_eflags() >>> 0, accumulator: view.getUint32(ACCUMULATOR, true) };
            };
            for (const count of [1, 2, 17, 1024]) for (const byte of [0, 1, 127, 255]) for (const accumulator of [0, 0xfffffff0, 0xffffffff]) {
                expect(run(true, count, byte, accumulator)).toEqual(run(false, count, byte, accumulator));
            }
            for (const alias of [0, 1, 2, 3]) expect(run(true, 32, 0, 0x1234fff1, alias)).toEqual(run(false, 32, 0, 0x1234fff1, alias));
        } finally { machine.close(); }
    });
});
