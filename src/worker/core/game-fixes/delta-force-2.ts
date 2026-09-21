import type { LoadedPEModule } from '../module-registry';

// Delta Force 2's mission loader can pass a null source to its inlined CRT
// memcpy when a legacy optional stream is absent. The native game treats that
// stream as empty; BottleShip must keep the rest of mission setup alive.
export const DELTA_FORCE_2_SOURCE_SHA256 = '8693876f610e9ee972178fe9d7ee72ca37498cd52bad8e1b399ec01b48b9a93f';
const MEMCPY_RVA = 0x86e60;
const ORIGINAL = new Uint8Array([0x55, 0x8b, 0xec, 0x57, 0x56, 0x8b, 0x75, 0x0c]);
// Stream reader call site immediately before the inline memcpy. When the
// optional stream has a count but no backing pointer, native startup treats it
// as EOF; passing the null pointer into memcpy crashes at 0x86ef0.
const STREAM_COPY_RVA = 0x84fff;
const STREAM_COPY_ORIGINAL = new Uint8Array([
    0x8b, 0xf8, 0x57, 0xff, 0x36, 0x53, 0xe8, 0x56, 0x1e, 0x00, 0x00,
]);
const STREAM_COPY2_RVA = 0x850e7;
const STREAM_COPY2_ORIGINAL = new Uint8Array([
    0x57, 0xff, 0x75, 0x08, 0xff, 0x36, 0xe8, 0x6e, 0x1d, 0x00, 0x00,
]);
// Both readers load the optional stream object and immediately dereference its
// flags. A missing stream can arrive as the old CRT sentinel 0x1000; handle it
// before the first dereference and return the reader's normal zero-byte result.
const STREAM_ENTRY_RVA = 0x84fcb;
const STREAM_ENTRY_ORIGINAL = new Uint8Array([
    0x8b, 0x75, 0x14, 0x66, 0xf7, 0x46, 0x0c, 0x0c, 0x01,
]);
const STREAM_ENTRY2_RVA = 0x850b3;
const STREAM_ENTRY2_ORIGINAL = new Uint8Array([
    0x8b, 0x75, 0x14, 0x66, 0xf7, 0x46, 0x0c, 0x0c, 0x01,
]);
const PARSER_A_RVA = 0x78c94;
const PARSER_A_ORIGINAL = new Uint8Array([0xc7, 0x45, 0xfc, 0x00, 0x00, 0x00, 0x00]);
const PARSER_B_RVA = 0x78d56;
const PARSER_B_ORIGINAL = new Uint8Array([0x89, 0x85, 0x3c, 0xff, 0xff, 0xff]);
const CALLBACK_RVA = 0x43d71;
const CALLBACK_ORIGINAL = new Uint8Array([0xff, 0xd0, 0x83, 0xc4, 0x08]);

function isDeltaForce2(module: LoadedPEModule): boolean {
    // Raw/bounded VFS loads intentionally omit a whole-file hash. The module
    // name plus each patch's reviewed original-byte check keeps this title fix
    // scoped without retaining a second executable buffer just to hash it.
    // Raw launches normally preserve the executable name, but a few catalog
    // adapters expose an empty/rewritten name while still loading the image at
    // its fixed PE base. The byte signatures below are the final scope guard.
    return module.sourceHash === DELTA_FORCE_2_SOURCE_SHA256
        || module.name.toLowerCase() === 'df2'
        || (module.isExecutable === true && module.baseAddress === 0x400000);
}

export type DeltaForce2DisplayMode = {
    width: number;
    height: number;
};

/**
 * Delta Force 2's first-run DDraw picker requests the emulator's default
 * 1024x768 mode even when the reviewed catalog manifest targets 640x480. Keep
 * the correction title/build scoped and preserve every other executable's
 * requested mode.
 */
export function normalizeDeltaForce2DisplayMode(
    module: LoadedPEModule | undefined,
    requested: DeltaForce2DisplayMode,
    configured: DeltaForce2DisplayMode,
): DeltaForce2DisplayMode {
    if (
        !module?.isExecutable ||
        module.sourceHash !== DELTA_FORCE_2_SOURCE_SHA256 ||
        configured.width <= 0 ||
        configured.height <= 0 ||
        requested.width === configured.width && requested.height === configured.height
    ) return requested;
    return { width: configured.width, height: configured.height };
}

function writeRel32(memory: Uint8Array, at: number, opcode: number, target: number): void {
    const rel = (target - (at + 5)) | 0;
    memory[at] = opcode;
    memory[at + 1] = rel & 0xff;
    memory[at + 2] = (rel >>> 8) & 0xff;
    memory[at + 3] = (rel >>> 16) & 0xff;
    memory[at + 4] = (rel >>> 24) & 0xff;
}

/**
 * Replace only the reviewed Delta Force 2 inline memcpy entry with a small
 * cdecl-compatible copy routine. It preserves ESI/EDI, returns the destination
 * pointer, and treats invalid optional-stream pointers as empty input.
 */
export function applyDeltaForce2MemcpyGuard(
    module: LoadedPEModule,
    memory: Uint8Array,
    cpu: { jit_dirty_cache?: (start: number, end: number) => void } | null,
    thunkGenerator: { allocateRawCodeArea(sizeBytes: number): number },
): boolean {
    if (!module.isExecutable || !isDeltaForce2(module))
        return false;
    const target = module.baseAddress + MEMCPY_RVA;
    if (target < 0 || target + ORIGINAL.length > memory.length)
        return false;
    for (let i = 0; i < ORIGINAL.length; i++) if (memory[target + i] !== ORIGINAL[i]) return false;

    const guestMemoryEnd = memory.length >>> 0;
    const code: number[] = [
        0x56, 0x57,                         // push esi; push edi
        0x8b, 0x44, 0x24, 0x0c,            // mov eax,[esp+0xc] (dest)
        0x8b, 0x4c, 0x24, 0x10,            // mov ecx,[esp+0x10] (src)
        // Missing optional streams can surface as low CRT sentinels (0x40 or
        // 0x1000), not only as a literal null. Corrupt PFF metadata can also
        // produce a wrapped high pointer (for example 0xffffff00). All valid
        // Delta buffers live inside the guest address space.
        0x81, 0xf9, 0x00, 0x00, 0x01, 0x00, // cmp ecx,0x10000
        0x72, 0x00,                         // jb return (patched below)
        0x81, 0xf9, 0x00, 0x00, 0x00, 0x00, // cmp ecx,memory.length
        0x73, 0x00,                         // jae return (patched below)
        0x3d, 0x00, 0x00, 0x01, 0x00,       // cmp eax,0x10000
        0x72, 0x00,                         // jb return (patched below)
        0x3d, 0x00, 0x00, 0x00, 0x00,       // cmp eax,memory.length
        0x73, 0x00,                         // jae return (patched below)
        0x8b, 0x54, 0x24, 0x14,            // mov edx,[esp+0x14] (length)
        0x89, 0xce,                         // mov esi,ecx
        0x8b, 0x7c, 0x24, 0x0c,            // mov edi,[esp+0xc]
        0x89, 0xd1,                         // mov ecx,edx
        0xc1, 0xe9, 0x02,                   // shr ecx,2
        0xf3, 0xa5,                         // rep movsd
        0x83, 0xe2, 0x03,                   // and edx,3
        0x89, 0xd1,                         // mov ecx,edx
        0xf3, 0xa4,                         // rep movsb
    ];
    for (const offset of [20, 34]) {
        code[offset] = guestMemoryEnd & 0xff;
        code[offset + 1] = (guestMemoryEnd >>> 8) & 0xff;
        code[offset + 2] = (guestMemoryEnd >>> 16) & 0xff;
        code[offset + 3] = (guestMemoryEnd >>> 24) & 0xff;
    }
    const returnLabel = code.length;
    code.push(0x8b, 0x44, 0x24, 0x0c,       // mov eax,[esp+0xc]
        0x5f, 0x5e, 0xc3);                  // pop edi; pop esi; ret
    // The four short branches share the normal return epilogue.
    for (const branch of [16, 24, 31, 38])
        code[branch + 1] = returnLabel - (branch + 2);

    const stub = thunkGenerator.allocateRawCodeArea(code.length);
    if (stub + code.length > memory.length) return false;
    memory.set(code, stub);
    const rel = (stub - (target + 5)) | 0;
    if (cpu?.jit_dirty_cache) {
        try { cpu.jit_dirty_cache(target, target + 5); } catch { return false; }
    }
    memory[target] = 0xe9;
    memory[target + 1] = rel & 0xff;
    memory[target + 2] = (rel >>> 8) & 0xff;
    memory[target + 3] = (rel >>> 16) & 0xff;
    memory[target + 4] = (rel >>> 24) & 0xff;
    return true;
}

/**
 * Turn a null source in Delta's stream reader into an EOF result before the
 * inline memcpy call. This preserves the reader's consumed-byte calculation
 * and lets its normal caller-visible EOF path run.
 */
export function applyDeltaForce2StreamGuard(
    module: LoadedPEModule,
    memory: Uint8Array,
    cpu: { jit_dirty_cache?: (start: number, end: number) => void } | null,
    thunkGenerator: { allocateRawCodeArea(sizeBytes: number): number },
): boolean {
    if (!module.isExecutable || !isDeltaForce2(module)) return false;
    const entry = module.baseAddress + STREAM_ENTRY_RVA;
    const entry2 = module.baseAddress + STREAM_ENTRY2_RVA;
    const target = module.baseAddress + STREAM_COPY_RVA;
    const target2 = module.baseAddress + STREAM_COPY2_RVA;
    if (entry < 0 || entry + STREAM_ENTRY_ORIGINAL.length > memory.length
        || entry2 < 0 || entry2 + STREAM_ENTRY2_ORIGINAL.length > memory.length
        || target < 0 || target + STREAM_COPY_ORIGINAL.length > memory.length
        || target2 < 0 || target2 + STREAM_COPY2_ORIGINAL.length > memory.length) return false;
    for (let i = 0; i < STREAM_ENTRY_ORIGINAL.length; i++)
        if (memory[entry + i] !== STREAM_ENTRY_ORIGINAL[i]) return false;
    for (let i = 0; i < STREAM_ENTRY2_ORIGINAL.length; i++)
        if (memory[entry2 + i] !== STREAM_ENTRY2_ORIGINAL[i]) return false;
    for (let i = 0; i < STREAM_COPY_ORIGINAL.length; i++)
        if (memory[target + i] !== STREAM_COPY_ORIGINAL[i]) return false;
    for (let i = 0; i < STREAM_COPY2_ORIGINAL.length; i++)
        if (memory[target2 + i] !== STREAM_COPY2_ORIGINAL[i]) return false;

    const makeEntryGuard = (continueAt: number, returnAt: number): number => {
        // Keep the original load/test flags for the normal path. For the
        // low sentinel, return an EOF/error sentinel through the function's existing epilogue
        // so callee-saved registers and stack cleanup remain native.
        const code: number[] = [
            0x8b, 0x75, 0x14,                   // mov esi,[ebp+0x14]
            0x81, 0xfe, 0x00, 0x00, 0x01, 0x00, // cmp esi,0x10000
            0x73, 0x00,                         // jae valid (patched below)
            0xb8, 0xff, 0xff, 0xff, 0xff,       // mov eax,-1 (EOF/error)
            0xe9, 0, 0, 0, 0,                   // jmp reader epilogue
            0x66, 0xf7, 0x46, 0x0c, 0x0c, 0x01, // test word [esi+0xc],0x10c
            0xe9, 0, 0, 0, 0,                   // jmp original conditional branch
        ];
        // The conditional branch must land on the first byte of TEST below.
        // Landing inside the following JMP's rel32 immediate corrupts the
        // reader's control flow for every valid stream pointer.
        const valid = 21;
        code[10] = valid - 11;
        const stub = thunkGenerator.allocateRawCodeArea(code.length);
        if (!stub || stub + code.length > memory.length) return 0;
        memory.set(code, stub);
        // The low path's JMP opcode starts after mov eax,-1 (index 16), and
        // the valid path's JMP follows the six-byte TEST (index 27).
        writeRel32(memory, stub + 16, 0xe9, returnAt);
        writeRel32(memory, stub + 27, 0xe9, continueAt);
        return stub;
    };
    const entryGuard = makeEntryGuard(module.baseAddress + 0x84fd4, module.baseAddress + 0x85074);
    const entryGuard2 = makeEntryGuard(module.baseAddress + 0x850bc, module.baseAddress + 0x85180);
    if (!entryGuard || !entryGuard2) return false;
    writeRel32(memory, entry, 0xe9, entryGuard);
    memory.fill(0x90, entry + 5, entry + STREAM_ENTRY_ORIGINAL.length);
    writeRel32(memory, entry2, 0xe9, entryGuard2);
    memory.fill(0x90, entry2 + 5, entry2 + STREAM_ENTRY2_ORIGINAL.length);

    const code: number[] = [
        0x8b, 0xf8,                         // mov edi,eax (original)
        0x83, 0x3e, 0x00,                   // cmp dword ptr [esi],0
        0x75, 0x00,                         // jnz non-null (patched below)
        0x83, 0x4e, 0x0c, 0x20,             // or dword ptr [esi+0xc],0x20 (EOF)
        0xe9, 0, 0, 0, 0,                   // jmp reader result
        0x57,                               // push edi
        0xff, 0x36,                         // push dword ptr [esi]
        0x53,                               // push ebx
        0xe8, 0, 0, 0, 0,                   // call inline memcpy
        0xe9, 0, 0, 0, 0,                   // continue after original call
    ];
    const nonNull = 16;
    code[6] = nonNull - 7;
    const stub = thunkGenerator.allocateRawCodeArea(code.length);
    if (!stub || stub + code.length > memory.length) return false;
    memory.set(code, stub);
    writeRel32(memory, stub + 11, 0xe9, module.baseAddress + 0x85083);
    writeRel32(memory, stub + 20, 0xe8, module.baseAddress + MEMCPY_RVA);
    writeRel32(memory, stub + 25, 0xe9, module.baseAddress + 0x8500a);

    writeRel32(memory, target, 0xe9, stub);
    memory.fill(0x90, target + 5, target + STREAM_COPY_ORIGINAL.length);
    const code2: number[] = [
        0x83, 0x3e, 0x00,                   // cmp dword ptr [esi],0
        0x75, 0x00,                         // jnz non-null (patched below)
        0x83, 0x4e, 0x0c, 0x20,             // or dword ptr [esi+0xc],0x20 (EOF)
        0xe9, 0, 0, 0, 0,                   // jmp reader result
        0x57,                               // push edi
        0xff, 0x75, 0x08,                   // push dword ptr [ebp+8]
        0xff, 0x36,                         // push dword ptr [esi]
        0xe8, 0, 0, 0, 0,                   // call inline memcpy
        0xe9, 0, 0, 0, 0,                   // continue after original call
    ];
    code2[4] = 14 - 5;
    const stub2 = thunkGenerator.allocateRawCodeArea(code2.length);
    if (!stub2 || stub2 + code2.length > memory.length) return false;
    memory.set(code2, stub2);
    writeRel32(memory, stub2 + 9, 0xe9, module.baseAddress + 0x85185);
    writeRel32(memory, stub2 + 20, 0xe8, module.baseAddress + MEMCPY_RVA);
    writeRel32(memory, stub2 + 25, 0xe9, module.baseAddress + 0x850f2);
    writeRel32(memory, target2, 0xe9, stub2);
    memory.fill(0x90, target2 + 5, target2 + STREAM_COPY2_ORIGINAL.length);
    if (cpu?.jit_dirty_cache) {
        try {
            cpu.jit_dirty_cache(entry, entry + STREAM_ENTRY_ORIGINAL.length);
            cpu.jit_dirty_cache(entry2, entry2 + STREAM_ENTRY2_ORIGINAL.length);
            cpu.jit_dirty_cache(target, target + STREAM_COPY_ORIGINAL.length);
            cpu.jit_dirty_cache(target2, target2 + STREAM_COPY2_ORIGINAL.length);
        } catch { return false; }
    }
    return true;
}

/**
 * The same executable has two optional-stream parsing loops which dereference
 * a missing stream pointer when the mission has no legacy palette/resource
 * chunk. Native Delta treats that chunk as empty. Return the parser's normal
 * success value for that case, while preserving the original path for valid
 * data.
 */
export function applyDeltaForce2ParserGuard(
    module: LoadedPEModule,
    memory: Uint8Array,
    cpu: { jit_dirty_cache?: (start: number, end: number) => void } | null,
    thunkGenerator: { allocateRawCodeArea(sizeBytes: number): number },
): boolean {
    if (!module.isExecutable || !isDeltaForce2(module))
        return false;
    const base = module.baseAddress;
    const first = base + PARSER_A_RVA;
    const second = base + PARSER_B_RVA;
    for (let i = 0; i < PARSER_A_ORIGINAL.length; i++) if (memory[first + i] !== PARSER_A_ORIGINAL[i]) return false;
    for (let i = 0; i < PARSER_B_ORIGINAL.length; i++) if (memory[second + i] !== PARSER_B_ORIGINAL[i]) return false;

    // Each stub replaces a missing or out-of-range optional stream with a
    // zero-filled 0x100-byte buffer, preserves the original state write, and
    // resumes the original loop.
    const emptyStream = thunkGenerator.allocateRawCodeArea(0x100);
    if (!emptyStream || emptyStream + 0x100 > memory.length) return false;
    memory.fill(0, emptyStream, emptyStream + 0x100);
    const guestMemoryEnd = memory.length >>> 0;
    const makeStub = (stateWrite: number[], continueAt: number): number => {
        const code: number[] = [
            0x81, 0xff, 0x00, 0x00, 0x01, 0x00, // cmp edi,0x10000
            0x72, 0x00,                         // jb set-empty (patched below)
            0x81, 0xff, 0x00, 0x00, 0x00, 0x00, // cmp edi,memory.length
            0x73, 0x00,                         // jae set-empty (patched below)
            0xe9, 0, 0, 0, 0,                   // jmp valid state write
            0xbf, 0, 0, 0, 0,                   // set-empty: mov edi,empty
        ];
        const stateOffset = code.length;
        code.push(...stateWrite, 0xe9, 0, 0, 0, 0); // state; jmp continue
        const stub = thunkGenerator.allocateRawCodeArea(code.length);
        if (stub + code.length > memory.length) return 0;
        memory.set(code, stub);
        memory[stub + 10] = guestMemoryEnd & 0xff;
        memory[stub + 11] = (guestMemoryEnd >>> 8) & 0xff;
        memory[stub + 12] = (guestMemoryEnd >>> 16) & 0xff;
        memory[stub + 13] = (guestMemoryEnd >>> 24) & 0xff;
        memory[stub + 22] = emptyStream & 0xff;
        memory[stub + 23] = (emptyStream >>> 8) & 0xff;
        memory[stub + 24] = (emptyStream >>> 16) & 0xff;
        memory[stub + 25] = (emptyStream >>> 24) & 0xff;
        memory[stub + 7] = 21 - 8;
        memory[stub + 15] = 21 - 16;
        writeRel32(memory, stub + 16, 0xe9, stub + stateOffset);
        writeRel32(memory, stub + stateOffset + stateWrite.length, 0xe9, continueAt);
        return stub;
    };
    // The replaced MOV is seven bytes; resume at the first byte after it.
    // Landing one byte early executes its trailing immediate zero as an ADD
    // and corrupts the parser's state/data stack.
    const stubA = makeStub([0xc7, 0x45, 0xfc, 0x00, 0x00, 0x00, 0x00], base + 0x78c9b);
    const stubB = makeStub([0x89, 0x85, 0x3c, 0xff, 0xff, 0xff], base + 0x78d5c);
    if (!stubA || !stubB) return false;
    writeRel32(memory, first, 0xe9, stubA);
    memory[first + 5] = 0x90;
    writeRel32(memory, second, 0xe9, stubB);
    memory[second + 5] = 0x90;
    if (cpu?.jit_dirty_cache) {
        try {
            cpu.jit_dirty_cache(first, first + PARSER_A_ORIGINAL.length);
            cpu.jit_dirty_cache(second, second + PARSER_B_ORIGINAL.length);
        } catch { return false; }
    }
    return true;
}

/** Skip a corrupt low callback token in the render/update walker. Delta stores
 * 1 in this slot for an optional callback; native code treats it as absent. */
export function applyDeltaForce2CallbackGuard(
    module: LoadedPEModule,
    memory: Uint8Array,
    cpu: { jit_dirty_cache?: (start: number, end: number) => void } | null,
    thunkGenerator: { allocateRawCodeArea(sizeBytes: number): number },
): boolean {
    if (!module.isExecutable || !isDeltaForce2(module)) return false;
    const target = module.baseAddress + CALLBACK_RVA;
    for (let i = 0; i < CALLBACK_ORIGINAL.length; i++) if (memory[target + i] !== CALLBACK_ORIGINAL[i]) return false;
    const code: number[] = [
        0x3d, 0x00, 0x00, 0x10, 0x00,       // cmp eax, 0x100000
        0x0f, 0x82, 0, 0, 0, 0,             // jb skip (patched)
        0xff, 0xd0,                         // call eax
        0x83, 0xc4, 0x08,                    // add esp, 8
        0xe9, 0, 0, 0, 0,                    // jmp continue (patched)
    ];
    const stub = thunkGenerator.allocateRawCodeArea(code.length);
    if (!stub || stub + code.length > memory.length) return false;
    memory.set(code, stub);
    // Convert the short branch slot into a near unsigned-below branch.
    const skip = stub + 13;
    const jbRel = (skip - (stub + 11)) | 0;
    memory[stub + 5] = 0x0f;
    memory[stub + 6] = 0x82;
    memory[stub + 7] = jbRel & 0xff;
    memory[stub + 8] = (jbRel >>> 8) & 0xff;
    memory[stub + 9] = (jbRel >>> 16) & 0xff;
    memory[stub + 10] = (jbRel >>> 24) & 0xff;
    writeRel32(memory, stub + 16, 0xe9, target + CALLBACK_ORIGINAL.length);
    writeRel32(memory, target, 0xe9, stub);
    if (cpu?.jit_dirty_cache) {
        try { cpu.jit_dirty_cache(target, target + CALLBACK_ORIGINAL.length); } catch { return false; }
    }
    return true;
}
