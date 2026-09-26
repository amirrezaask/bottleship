import { describe, expect, test } from 'bun:test';
import { Bass } from '../../src/worker/modules/bass';
import type { Process } from '../../src/worker/core/process';
import type { X86Context } from '../../src/worker/core/thunking/thunk-dispatcher';

const CLEO_HASH = '748ea0b36a1580652146c8b443066bdd81ef14556431805b2102f0f1f44caa08';
const CLEO_BASE = 0x13190000;

function fixture() {
    const bass = new Bass();
    bass.initialize({
        moduleRegistry: {
            getModuleContainingAddress(address: number) {
                if (address >= CLEO_BASE && address < CLEO_BASE + 0x7a000)
                    return { sourceHash: CLEO_HASH };
                return undefined;
            },
        },
    } as unknown as Process);
    const memory = new Uint8Array(128);
    const ctx: X86Context = {
        eax: 0, ecx: 0, edx: 0, ebx: 0, esp: 32, ebp: 0,
        esi: 0, edi: 0, eip: 0x21060000, eflags: 0,
    };
    return { bass, ctx, memory };
}

describe('CLEO BASS compatibility', () => {
    test('reads the guest return address and scopes the 2.4 version to CLEO', () => {
        const { bass, ctx, memory } = fixture();
        const stack = new DataView(memory.buffer);
        stack.setUint32(ctx.esp, CLEO_BASE + 0x11cee, true);
        expect(bass.exports.BASS_GetVersion(ctx, memory, [])).toBe(0x02040000);
        stack.setUint32(ctx.esp, 0x00401234, true);
        expect(bass.exports.BASS_GetVersion(ctx, memory, [])).toBe(0);
    });

    test('ends unsupported device enumeration without writing guest data', () => {
        const { bass, ctx, memory } = fixture();
        const stack = new DataView(memory.buffer);
        stack.setUint32(ctx.esp, CLEO_BASE + 0x11f1a, true);
        memory.fill(0x5a, 64, 76);
        expect(bass.exports.BASS_GetDeviceInfo(ctx, memory, [0, 64])).toBe(0);
        expect(memory.subarray(64, 76)).toEqual(new Uint8Array(12).fill(0x5a));
        expect(bass.exports.BASS_Set3DFactors(ctx, memory, [0x3f800000, 0x3e99999a, 0x3f800000])).toBe(1);
        expect(bass.exports.BASS_Set3DPosition(ctx, memory, [64, 76, 88, 100])).toBe(1);
        expect(bass.exports.BASS_Set3DPosition(ctx, memory, [120, 0, 0, 0])).toBe(0);
        expect(bass.exports.BASS_Apply3D(ctx, memory, [])).toBe(0);
        expect(bass.exports.BASS_StreamCreate(ctx, memory, [])).toBe(0);
        expect(bass.exports.BASS_GetInfo(ctx, memory, [])).toBe(0);
        expect(bass.exports.BASS_ErrorGetCode(ctx, memory, [])).toBe(0);
        stack.setUint32(ctx.esp, 0x00401234, true);
        expect(bass.exports.BASS_GetDeviceInfo(ctx, memory, [0, 64])).toBe(50);
    });
});
