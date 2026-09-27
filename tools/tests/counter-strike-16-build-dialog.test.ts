import { describe, expect, test } from 'bun:test';
import { COUNTER_STRIKE_16_CLIENT_SHA256, COUNTER_STRIKE_16_GAMEUI_SHA256, guardCounterStrikeBuildDialog, guardCounterStrikeGameUiCount, guardCounterStrikeGameUiItem } from '../../src/worker/core/game-fixes/counter-strike-16';
import type { LoadedPEModule } from '../../src/worker/core/module-registry';

const module = (hash = COUNTER_STRIKE_16_CLIENT_SHA256): LoadedPEModule => ({
    name: 'c:\\cstrike\\cl_dlls\\client', path: 'c:\\cstrike\\cl_dlls\\client.dll', baseAddress: 0x100000,
    size: 0x160000, fileSize: 1_074_496, entryPoint: 0, exports: new Map(), ordinalExports: new Map(),
    isRealDll: true, initialized: true, sourceHash: hash,
});

describe('Counter-Strike optional GameUI list guard', () => {
    test('returns zero only for a null receiver and preserves the exact original getter', () => {
        const memory = new Uint8Array(0x400000);
        const entry = 0x100000 + 0x519a0;
        memory.set([0x8b, 0x81, 0xc4, 0, 0, 0, 0xc3], entry);
        const gameUi = { ...module(COUNTER_STRIKE_16_GAMEUI_SHA256),
            name: 'c:\\cstrike\\cl_dlls\\gameui', path: 'c:\\cstrike\\cl_dlls\\GameUI.dll', fileSize: 845_112 };
        expect(guardCounterStrikeGameUiCount(gameUi, memory, null,
            { allocateRawCodeArea: () => 0x300000 })).toBe(true);
        expect(Array.from(memory.subarray(0x300000, 0x30000e))).toEqual([
            0x85, 0xc9, 0x75, 0x03, 0x31, 0xc0, 0xc3, 0x8b, 0x81, 0xc4, 0, 0, 0, 0xc3,
        ]);
        expect(memory[entry]).toBe(0xe9);
    });
    test('guards the exact item call and jumps to the original getter for a real receiver', () => {
        const memory = new Uint8Array(0x400000);
        const call = 0x100000 + 0x77279;
        memory.set([0x8b, 0x8e, 0x20, 0x01, 0, 0, 0xe8, 0x02, 0xb0, 0xfd, 0xff], call - 6);
        const gameUi = { ...module(COUNTER_STRIKE_16_GAMEUI_SHA256),
            name: 'c:\\cstrike\\cl_dlls\\gameui', path: 'c:\\cstrike\\cl_dlls\\GameUI.dll', fileSize: 845_112 };
        expect(guardCounterStrikeGameUiItem(gameUi, memory, null,
            { allocateRawCodeArea: () => 0x300000 })).toBe(true);
        expect(Array.from(memory.subarray(0x300000, 0x300008))).toEqual([
            0x85, 0xc9, 0x75, 0x03, 0x31, 0xc0, 0xc3, 0xe9,
        ]);
        expect(0x300000 + 12 + new DataView(memory.buffer).getInt32(0x300008, true))
            .toBe(0x100000 + 0x52280);
    });
});

describe('Counter-Strike optional VGUI build editor guard', () => {
    test('patches only reviewed client bytes and preserves original constructor branch', () => {
        const memory = new Uint8Array(0x400000);
        const call = 0x100000 + 0x76054;
        memory.set([0x6a, 0x00, 0x68], call - 15);
        new DataView(memory.buffer).setUint32(call - 12, 0x100000 + 0xea25c, true);
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
        memory.set([0x6a, 0x00, 0x68], call - 15);
        new DataView(memory.buffer).setUint32(call - 12, 0x100000 + 0xea25c, true);
        memory.set([0xe8, 0x47, 0x08, 0x02, 0x00], call);
        const allocate = () => { throw new Error('must not allocate'); };
        expect(guardCounterStrikeBuildDialog(module('other'), memory, null, { allocateRawCodeArea: allocate })).toBe(false);
        expect(guardCounterStrikeBuildDialog({ ...module(), fileSize: 1 }, memory, null, { allocateRawCodeArea: allocate })).toBe(false);
        memory[call + 1] = 0;
        expect(guardCounterStrikeBuildDialog(module(), memory, null, { allocateRawCodeArea: allocate })).toBe(false);
    });
});
