import type { LoadedPEModule } from '../module-registry';

const SOURCE_SHA256 = 'f01a00ce950fa40ca1ed59df0e789848c6edcf6405456274965885d0929343ac';
const LOOP_ADDRESS = 0x53e930;
// Idle's secondary 14 ms delay, through the call to CTimer::Update.
const ORIGINAL = new Uint8Array([
    0xe8,0x4b,0x31,0x02,0x00,0x8b,0xf0,0xe8,0x04,0x31,0x02,0x00,0x8b,0xc8,0x33,0xd2,
    0x8b,0xc6,0xf7,0xf1,0x2b,0x05,0xa8,0x2c,0xb7,0x00,0x83,0xf8,0x0e,0x72,0xe1,
    0xe8,0x2c,0x31,0x02,0x00,0x8b,0xf0,0xe8,0xe5,0x30,0x02,0x00,0x8b,0xc8,0x33,
    0xd2,0x8b,0xc6,0xf7,0xf1,0xa3,0xa8,0x2c,0xb7,0x00,0xe8,0xa3,0x31,0x02,0x00,
]);

/** The original Idle delay lowers the effective native 30 FPS limit. Skip that
 * secondary wait, retaining MainLoop's limiter and CTimer::Update unchanged.
 * Unlike replacing Idle's prologue, this branch preserves its push/pop ESI and
 * argument offsets. Only a verified prepared source at its original base matches.
 * Reference: SilentPatchSA.cpp, "No framedelay" (MIT), and gta-reversed Idle.
 * https://github.com/CookiePLMonster/SilentPatch/blob/master/SilentPatchSA/SilentPatchSA.cpp
 */
export function applySanAndreasTimingFix(module: LoadedPEModule, memory: Uint8Array,
    cpu: { jit_dirty_cache?: (start: number, end: number) => void } | null): boolean {
    if (!module.isExecutable || module.sourceHash !== SOURCE_SHA256 || module.baseAddress !== 0x400000
        || module.size < LOOP_ADDRESS + ORIGINAL.length - module.baseAddress
        || memory.length < LOOP_ADDRESS + ORIGINAL.length || !cpu?.jit_dirty_cache) return false;
    for (let i = 0; i < ORIGINAL.length; i++) if (memory[LOOP_ADDRESS + i] !== ORIGINAL[i]) return false;
    // Invalidate before the atomic synchronous edit. A missing/failing invalidator
    // must leave the original bytes and architectural state intact.
    try { cpu.jit_dirty_cache(LOOP_ADDRESS, LOOP_ADDRESS + 2); } catch { return false; }
    memory[LOOP_ADDRESS] = 0xeb;
    memory[LOOP_ADDRESS + 1] = 0x36; // 0x53e932 + 0x36 = 0x53e968 (CTimer::Update)
    return true;
}

/** Match GameBox's requested lowest-graphics profile using the game's own Low
 * FX preference. Change only the native default, so saved preferences and later
 * menu choices still work. No game asset, mission, audio or physics code changes. */
export function applySanAndreasGraphicsDefault(module: LoadedPEModule, memory: Uint8Array,
    cpu: { jit_dirty_cache?: (start: number, end: number) => void } | null, lowestGraphics: boolean): boolean {
    const address = 0x573b77;
    const expected = [0x6a,0x02,0xb9,0x00,0xae,0xa9,0x00,0xe8,0xbd,0xae,0xf2,0xff];
    if (!lowestGraphics || !module.isExecutable || module.sourceHash !== SOURCE_SHA256
        || module.baseAddress !== 0x400000 || module.size < address + expected.length - module.baseAddress
        || memory.length < address + expected.length || !cpu?.jit_dirty_cache) return false;
    for (let i = 0; i < expected.length; i++) if (memory[address + i] !== expected[i]) return false;
    try { cpu.jit_dirty_cache(address, address + 2); } catch { return false; }
    memory[address + 1] = 0; // PUSH FX_QUALITY_LOW; original Fx_c::SetFxQuality performs the update.
    return true;
}
