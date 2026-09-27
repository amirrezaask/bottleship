import type { LoadedPEModule } from '../module-registry';

/** Exact operator-supplied CS 1.6 client DLL; this is not a general VGUI workaround. */
export const COUNTER_STRIKE_16_CLIENT_SHA256 = '733d4b48a64991d2cd2a60c20d99f72b6533cc401c47f97cc0e6073bd482b6dc';
export const COUNTER_STRIKE_16_GAMEUI_SHA256 = 'dec177289c8da8e4fe362911ca436bee1caff67f6cf0d1b3c53f401d2300236c';
const BUILD_DIALOG_CONSTRUCTOR_CALL_RVA = 0x76054;
const BUILD_DIALOG_CONSTRUCTOR_RVA = 0x968a0;
const ORIGINAL_CALL = new Uint8Array([0xe8, 0x47, 0x08, 0x02, 0x00]);
const BUILD_GROUP_PTR_STRING_RVA = 0xea25c;

/**
 * This supplied DLL's VGUI BuildDialog handler calls its editor constructor with
 * KeyValues.GetPtr("BuildGroupPtr", null). When that optional editor pointer is
 * absent, the constructor unconditionally calls through it at +0xc4 and exits
 * before gameplay. Preserve the ordinary constructor path for a valid pointer;
 * allow a null editor to stay null and let the caller store that in PanelPtr.
 * The patch never substitutes a fake interface or changes normal game panels.
 */
export function guardCounterStrikeBuildDialog(
    module: LoadedPEModule,
    memory: Uint8Array,
    cpu: { jit_dirty_cache?: (start: number, end: number) => void } | null,
    codeAllocator: { allocateRawCodeArea(sizeBytes: number): number },
): boolean {
    // Raw ZIP-backed DLL loads do not always carry a sourceHash. In that case,
    // require the exact PE file size, path, call bytes, and KeyValues argument.
    const normalizedName = module.name.toLowerCase().replaceAll('/', '\\');
    const normalizedPath = module.path.toLowerCase().replaceAll('/', '\\');
    if ((module.sourceHash && module.sourceHash !== COUNTER_STRIKE_16_CLIENT_SHA256) ||
        module.fileSize !== 1_074_496 ||
        !/(?:^|\\)client(?:\.dll)?$/.test(normalizedName) ||
        !/\\cstrike\\cl_dlls\\client(?:\.dll)?$/.test(normalizedPath)) return false;
    const call = module.baseAddress + BUILD_DIALOG_CONSTRUCTOR_CALL_RVA;
    const preceding = call - 15;
    if (preceding < 0 || call + 5 > memory.length) return false;
    for (let i = 0; i < ORIGINAL_CALL.length; i++) if (memory[call + i] !== ORIGINAL_CALL[i]) return false;
    // The reviewed caller must still fetch BuildGroupPtr with a null default.
    const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
    if (memory[preceding] !== 0x6a || memory[preceding + 1] !== 0 ||
        memory[preceding + 2] !== 0x68 ||
        view.getUint32(preceding + 3, true) !== ((module.baseAddress + BUILD_GROUP_PTR_STRING_RVA) >>> 0)) return false;

    const trampoline = codeAllocator.allocateRawCodeArea(32);
    if (!trampoline || trampoline + 17 > memory.length) return false;
    const code = new Uint8Array([
        0x83, 0x7c, 0x24, 0x04, 0x00, // cmp dword [esp+4],0 (constructor argument)
        0x75, 0x05,                   // jne original constructor
        0x31, 0xc0,                   // xor eax,eax (no optional editor)
        0xc2, 0x04, 0x00,             // ret 4
        0xe9, 0, 0, 0, 0,             // jmp exact original constructor
    ]);
    new DataView(code.buffer).setInt32(13, (module.baseAddress + BUILD_DIALOG_CONSTRUCTOR_RVA - (trampoline + 17)) | 0, true);
    memory.set(code, trampoline);
    const rel = (trampoline - (call + 5)) | 0;
    memory[call] = 0xe8;
    view.setInt32(call + 1, rel, true);
    cpu?.jit_dirty_cache?.(trampoline, trampoline + code.length);
    cpu?.jit_dirty_cache?.(call, call + 5);
    return true;
}

/**
 * The supplied GameUI calls its small count getter at RVA 0x519a0 through an
 * optional object stored at [esi+0x120]. A null object must report zero items;
 * the unguarded getter reads [ecx+0xc4] and aborts UI initialization.
 */
export function guardCounterStrikeGameUiCount(
    module: LoadedPEModule,
    memory: Uint8Array,
    cpu: { jit_dirty_cache?: (start: number, end: number) => void } | null,
    codeAllocator: { allocateRawCodeArea(sizeBytes: number): number },
): boolean {
    const path = module.path.toLowerCase().replaceAll('/', '\\');
    if ((module.sourceHash && module.sourceHash !== COUNTER_STRIKE_16_GAMEUI_SHA256) ||
        module.fileSize !== 845_112 ||
        !/\\cstrike\\cl_dlls\\gameui(?:\.dll)?$/.test(path)) return false;
    const entry = module.baseAddress + 0x519a0;
    const original = [0x8b, 0x81, 0xc4, 0x00, 0x00, 0x00, 0xc3];
    if (entry < 0 || entry + original.length > memory.length ||
        original.some((byte, offset) => memory[entry + offset] !== byte)) return false;
    const trampoline = codeAllocator.allocateRawCodeArea(16);
    if (!trampoline || trampoline + 14 > memory.length) return false;
    memory.set([
        0x85, 0xc9,                   // test ecx,ecx
        0x75, 0x03,                   // jnz non-null getter
        0x31, 0xc0,                   // xor eax,eax
        0xc3,                         // ret
        ...original,                  // exact original getter
    ], trampoline);
    memory[entry] = 0xe9;
    new DataView(memory.buffer, memory.byteOffset, memory.byteLength)
        .setInt32(entry + 1, (trampoline - entry - 5) | 0, true);
    memory[entry + 5] = 0x90;
    cpu?.jit_dirty_cache?.(trampoline, trampoline + 14);
    cpu?.jit_dirty_cache?.(entry, entry + 6);
    return true;
}

/** The same optional GameUI receiver is later passed to its item getter. */
export function guardCounterStrikeGameUiItem(
    module: LoadedPEModule,
    memory: Uint8Array,
    cpu: { jit_dirty_cache?: (start: number, end: number) => void } | null,
    codeAllocator: { allocateRawCodeArea(sizeBytes: number): number },
): boolean {
    const path = module.path.toLowerCase().replaceAll('/', '\\');
    if ((module.sourceHash && module.sourceHash !== COUNTER_STRIKE_16_GAMEUI_SHA256) ||
        module.fileSize !== 845_112 ||
        !/\\cstrike\\cl_dlls\\gameui(?:\.dll)?$/.test(path)) return false;
    const call = module.baseAddress + 0x77279;
    const preceding = [0x8b, 0x8e, 0x20, 0x01, 0x00, 0x00];
    const originalCall = [0xe8, 0x02, 0xb0, 0xfd, 0xff];
    if (call < 6 || call + 5 > memory.length ||
        preceding.some((byte, offset) => memory[call - 6 + offset] !== byte) ||
        originalCall.some((byte, offset) => memory[call + offset] !== byte)) return false;
    const trampoline = codeAllocator.allocateRawCodeArea(16);
    if (!trampoline || trampoline + 12 > memory.length) return false;
    const code = new Uint8Array([
        0x85, 0xc9,             // test ecx,ecx
        0x75, 0x03,             // jnz original item getter
        0x31, 0xc0,             // xor eax,eax
        0xc3,                   // ret (caller treats zero as absent)
        0xe9, 0, 0, 0, 0,       // jmp exact original getter
    ]);
    new DataView(code.buffer).setInt32(8, (module.baseAddress + 0x52280 - trampoline - 12) | 0, true);
    memory.set(code, trampoline);
    const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
    view.setInt32(call + 1, (trampoline - call - 5) | 0, true);
    cpu?.jit_dirty_cache?.(trampoline, trampoline + code.length);
    cpu?.jit_dirty_cache?.(call, call + 5);
    return true;
}
