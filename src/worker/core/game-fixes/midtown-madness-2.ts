import type { LoadedPEModule } from '../module-registry';

// MM2's map loader can release a temporary block after its private heap has
// already been removed from the allocator list. Native Windows tolerates this
// teardown ordering; the title's own FindHeap routine raises a fatal dialog.
// Scope the guard to the reviewed executable so other Win32 titles retain the
// original allocator checks.
const SOURCE_SHA256 = '992c53c9250cf822b44bf4a4013bd5805229bbbeb7b478a4c2556531bc5340f3';
const FIND_HEAP_RVA = 0x1766b0;
const FIND_HEAP_FAILURE_RVA = 0x1766d6;
const FIND_HEAP_FAILURE_ORIGINAL = new Uint8Array([0x52, 0x68]);
const FREE_RVA = 0x177380;
const FREE_DEBUG_RVA = 0x1773c0;
const FREE_ORIGINAL = new Uint8Array([0x55, 0x8b, 0xec, 0x8b, 0x45]);
const FREE_HEAP_RVA = 0x176a80;

function isMidtownMadness2(module: LoadedPEModule): boolean {
    return module.sourceHash === SOURCE_SHA256;
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
 * Keep MM2's map transition alive when its private allocator receives a stale
 * temporary pointer. A zero FindHeap result is a no-op free; valid heap frees
 * still take the original allocator path.
 */
export function applyMidtownMadness2AllocatorGuard(
    module: LoadedPEModule,
    memory: Uint8Array,
    cpu: { jit_dirty_cache?: (start: number, end: number) => void } | null,
    thunkGenerator: { allocateRawCodeArea(sizeBytes: number): number },
): boolean {
    if (!module.isExecutable || !isMidtownMadness2(module)) return false;
    const base = module.baseAddress;
    const findFailure = base + FIND_HEAP_FAILURE_RVA;
    const free = base + FREE_RVA;
    const freeDebug = base + FREE_DEBUG_RVA;
    for (let i = 0; i < FIND_HEAP_FAILURE_ORIGINAL.length; i++)
        if (memory[findFailure + i] !== FIND_HEAP_FAILURE_ORIGINAL[i]) return false;
    for (let i = 0; i < FREE_ORIGINAL.length; i++)
        if (memory[free + i] !== FREE_ORIGINAL[i]) return false;
    for (let i = 0; i < FREE_ORIGINAL.length; i++)
        if (memory[freeDebug + i] !== FREE_ORIGINAL[i]) return false;

    // Skip FindHeap's fatal-error call and return its documented null result.
    memory[findFailure] = 0xeb; // jmp short
    memory[findFailure + 1] = 0x0c; // -> xor eax,eax at +0x0e

    // The wrapper has three pushes around FindHeap and the callee's FreeHeap
    // consumes the remaining two arguments with RET 8. Mirror that stack shape
    // when FindHeap returns null, while preserving normal valid frees.
    const code: number[] = [
        0x8b, 0x44, 0x24, 0x04,       // mov eax,[esp+4] (ptr)
        0x85, 0xc0,                    // test eax,eax
        0x74, 0x1c,                    // je done
        0x6a, 0x00,                    // push allocator mode
        0x50,                           // push eax
        0x50,                           // push eax
        0xe8, 0, 0, 0, 0,               // call FindHeap
        0x83, 0xc4, 0x04,              // add esp,4
        0x85, 0xc0,                    // test eax,eax
        0x74, 0x08,                    // je noHeap
        0x8b, 0xc8,                    // mov ecx,eax
        0xe8, 0, 0, 0, 0,               // call FreeHeap (RET 8)
        0xc3,                           // ret
        0x83, 0xc4, 0x08,              // noHeap: discard two forwarded args
        0xc3,                           // ret
        0xc3,                           // done: ret
    ];
    const stub = thunkGenerator.allocateRawCodeArea(code.length);
    const debugStub = thunkGenerator.allocateRawCodeArea(code.length);
    if (!stub || !debugStub || stub + code.length > memory.length || debugStub + code.length > memory.length)
        return false;
    const patchWrapper = (wrapper: number, targetStub: number, mode: number): void => {
        const wrapperCode = code.slice();
        wrapperCode[9] = mode;
        memory.set(wrapperCode, targetStub);
        writeRel32(memory, targetStub + 12, 0xe8, base + FIND_HEAP_RVA);
        writeRel32(memory, targetStub + 26, 0xe8, base + FREE_HEAP_RVA);
        writeRel32(memory, wrapper, 0xe9, targetStub);
    };
    patchWrapper(free, stub, 0);
    patchWrapper(freeDebug, debugStub, 1);
    if (cpu?.jit_dirty_cache) {
        try {
            cpu.jit_dirty_cache(findFailure, findFailure + FIND_HEAP_FAILURE_ORIGINAL.length);
            cpu.jit_dirty_cache(free, free + FREE_ORIGINAL.length);
            cpu.jit_dirty_cache(freeDebug, freeDebug + FREE_ORIGINAL.length);
        } catch { return false; }
    }
    return true;
}
