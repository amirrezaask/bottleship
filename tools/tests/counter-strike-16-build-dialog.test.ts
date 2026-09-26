import { describe, expect, test } from 'bun:test';
import { COUNTER_STRIKE_16_CLIENT_SHA256, guardCounterStrikeBuildDialog } from '../../src/worker/core/game-fixes/counter-strike-16';
import type { LoadedPEModule } from '../../src/worker/core/module-registry';

const module = (hash = COUNTER_STRIKE_16_CLIENT_SHA256): LoadedPEModule => ({
    name: 'client', path: 'c:\\cstrike\\cl_dlls\\client.dll', baseAddress: 0x100000,
    size: 0x160000, entryPoint: 0, exports: new Map(), ordinalExports: new Map(),
    isRealDll: true, initialized: true, sourceHash: hash,
});

describe('Counter-Strike optional VGUI build editor guard', () => {
    test('patches only reviewed client bytes and preserves original constructor branch', () => {
        const memory = new Uint8Array(0x400000);
        const call = 0x100000 + 0x76054;
        memory.set([0x6a, 0x00, 0x68, 0x5c, 0xa2, 0x9e, 0x01], call - 15);
        memory.set([0xe8, 0x47, 0x08, 0x02, 0x00], call);
        const dirty: number[][] = [];
        const patched = guardCounterStrikeBuildDialog(module(), memory,
            { jit_dirty_cache: (start, end) => { dirty.push([start, end]); } },
            { allocateRawCodeArea: () => 0x300000 });
        expect(patched).toBe(true);
        expect(memory[call]).toBe(0xe8);
        expect(new DataView(memory.buffer).getInt32(call + 1, true)).toBe(0x300000 - call - 5);
        expect(Array.from(memory.subarray(0x300000, 0x300000 + 12))).toEqual([
            0x83, 0x7c, 0x24, 0x04, 0x00, 0x75, 0x05, 0x31, 0xc0, 0xc2, 0x04, 0x00,
        ]);
        const target = 0x300000 + 17 + new DataView(memory.buffer).getInt32(0x300000 + 13, true);
        expect(target).toBe(0x100000 + 0x968a0);
        expect(dirty).toEqual([[0x300000, 0x300011], [call, call + 5]]);
    });
    test('does not touch a different DLL identity or modified caller', () => {
        const memory = new Uint8Array(0x400000);
        const call = 0x100000 + 0x76054;
        memory.set([0x6a, 0x00, 0x68, 0x5c, 0xa2, 0x9e, 0x01], call - 15);
        memory.set([0xe8, 0x47, 0x08, 0x02, 0x00], call);
        const allocate = () => { throw new Error('must not allocate'); };
        expect(guardCounterStrikeBuildDialog(module('other'), memory, null, { allocateRawCodeArea: allocate })).toBe(false);
        memory[call + 1] = 0;
        expect(guardCounterStrikeBuildDialog(module(), memory, null, { allocateRawCodeArea: allocate })).toBe(false);
    });
});
