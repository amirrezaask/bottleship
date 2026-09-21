import type { LoadedPEModule } from '../module-registry';

// Delta Force: Land Warrior's image loader enters a byte-count loop after it
// has prepared the indexed image. The reviewed Land Warrior executable reads the
// same first byte on every iteration and accumulates it into this global; the
// loop is therefore semantically reducible to one multiply/add, but is far too
// expensive for the translated guest to finish during mission load.
export const DELTA_FORCE_3_SOURCE_SHA256 =
    '792d9d8620a7514408fcd594a28b116f6a2075551c5902fc5bab716359cc950d';
const LOOP_RVA = 0x7ceda;
const LOOP_ADDRESS = 0x400000 + LOOP_RVA;
const CONTINUE_RVA = 0x7ceef;
const GLOBAL_ACCUMULATOR = 0x00f64bf0;

// mov esi,[global]; xor edx,edx; mov dl,[ecx]; add esi,edx; dec eax;
// mov [global],esi; jne loop. Keep the complete instruction sequence in the
// match so a guard miss leaves the guest entirely untouched.
const ORIGINAL = new Uint8Array([
    0x8b, 0x35, 0xf0, 0x4b, 0xf6, 0x00,
    0x33, 0xd2,
    0x8a, 0x11,
    0x03, 0xf2,
    0x48,
    0x89, 0x35, 0xf0, 0x4b, 0xf6, 0x00,
    0x75, 0xeb,
]);

function writeRel32(memory: Uint8Array, at: number, opcode: number, target: number): void {
    const rel = (target - (at + 5)) | 0;
    memory[at] = opcode;
    memory[at + 1] = rel & 0xff;
    memory[at + 2] = (rel >>> 8) & 0xff;
    memory[at + 3] = (rel >>> 16) & 0xff;
    memory[at + 4] = (rel >>> 24) & 0xff;
}

/**
 * Lower the exact title-local pixel accumulator loop without changing its
 * observable result. The original loop leaves EAX at zero, EDX at the source
 * byte, ESI at the updated accumulator, ECX unchanged, and EDI unchanged.
 * The stub preserves those values and fails closed if any reviewed bytes do
 * not match.
 */
export function applyDeltaForce3ImageLoopFix(
    module: LoadedPEModule,
    memory: Uint8Array,
    cpu: { jit_dirty_cache?: (start: number, end: number) => void } | null,
    thunkGenerator: { allocateRawCodeArea(sizeBytes: number): number },
): boolean {
    if (!module.isExecutable || module.sourceHash !== DELTA_FORCE_3_SOURCE_SHA256 || module.baseAddress !== 0x400000)
        return false;
    if (!cpu?.jit_dirty_cache || memory.length < LOOP_ADDRESS + ORIGINAL.length)
        return false;
    for (let i = 0; i < ORIGINAL.length; i++) {
        if (memory[LOOP_ADDRESS + i] !== ORIGINAL[i]) return false;
    }

    // The source is normally a separate image byte. If it aliases the global
    // accumulator, every guest iteration can read a different byte; retain the
    // exact original loop in that case. Comparisons do not leak flags because
    // both paths execute the loop's ADD/DEC flag producers.
    const code: number[] = [
        0x81, 0xf9, 0xf0, 0x4b, 0xf6, 0x00, // cmp ecx,GLOBAL_ACCUMULATOR
        0x72, 0x08,                         // jb fast
        0x81, 0xf9, 0xf4, 0x4b, 0xf6, 0x00, // cmp ecx,GLOBAL_ACCUMULATOR+4
        0x72, 0x22,                         // jb originalLoop
        // fast: sum n-1 iterations, then perform the final ADD separately.
        // The final DEC preserves that ADD's carry, exactly like the guest.
        0x8b, 0x35, 0xf0, 0x4b, 0xf6, 0x00, // mov esi,[GLOBAL_ACCUMULATOR]
        0x0f, 0xb6, 0x11,                   // movzx edx,byte ptr [ecx]
        0x48,                               // dec eax (zero count wraps as in the guest)
        0x0f, 0xaf, 0xc2,                   // imul eax,edx
        0x03, 0xf0,                         // add esi,eax
        0x03, 0xf2,                         // add esi,edx (last guest ADD's carry)
        0x89, 0x35, 0xf0, 0x4b, 0xf6, 0x00, // mov [GLOBAL_ACCUMULATOR],esi
        0xb8, 0x01, 0x00, 0x00, 0x00,       // mov eax,1
        0x48,                               // dec eax (loop exit flags)
        0xe9, 0, 0, 0, 0,                   // jmp CONTINUE_RVA
        ...ORIGINAL,                       // originalLoop: alias-safe fallback
        0xe9, 0, 0, 0, 0,                   // jmp CONTINUE_RVA
    ];
    const stub = thunkGenerator.allocateRawCodeArea(code.length);
    if (!stub || stub + code.length > memory.length) return false;
    memory.set(code, stub);
    writeRel32(memory, stub + 45, 0xe9, module.baseAddress + CONTINUE_RVA);
    writeRel32(memory, stub + 50 + ORIGINAL.length, 0xe9, module.baseAddress + CONTINUE_RVA);

    // Invalidate the full replaced loop before publishing the JMP. If the
    // invalidator fails, retain the original guest bytes and architectural
    // state rather than leaving a half-applied fix.
    try {
        cpu.jit_dirty_cache(LOOP_ADDRESS, LOOP_ADDRESS + ORIGINAL.length);
    } catch {
        return false;
    }
    memory[LOOP_ADDRESS] = 0xe9;
    const rel = (stub - (LOOP_ADDRESS + 5)) | 0;
    memory[LOOP_ADDRESS + 1] = rel & 0xff;
    memory[LOOP_ADDRESS + 2] = (rel >>> 8) & 0xff;
    memory[LOOP_ADDRESS + 3] = (rel >>> 16) & 0xff;
    memory[LOOP_ADDRESS + 4] = (rel >>> 24) & 0xff;
    memory.fill(0x90, LOOP_ADDRESS + 5, LOOP_ADDRESS + ORIGINAL.length);
    return true;
}
