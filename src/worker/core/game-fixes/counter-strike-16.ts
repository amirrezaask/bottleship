import type { LoadedPEModule } from '../module-registry';

/** Exact operator-supplied CS 1.6 client DLL; this is not a general VGUI workaround. */
export const COUNTER_STRIKE_16_CLIENT_SHA256 = '733d4b48a64991d2cd2a60c20d99f72b6533cc401c47f97cc0e6073bd482b6dc';
const BUILD_DIALOG_CONSTRUCTOR_CALL_RVA = 0x76054;
const BUILD_DIALOG_CONSTRUCTOR_RVA = 0x968a0;
const ORIGINAL_CALL = new Uint8Array([0xe8, 0x47, 0x08, 0x02, 0x00]);
const GET_BUILD_GROUP_PTR = new Uint8Array([0x6a, 0x00, 0x68, 0x5c, 0xa2, 0x9e, 0x01]);

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
    if ((module.sourceHash && module.sourceHash !== COUNTER_STRIKE_16_CLIENT_SHA256) ||
        module.fileSize !== 1_074_496 || module.name.toLowerCase() !== 'client' ||
        !/\\cstrike\\cl_dlls\\client(?:\.dll)?$/.test(module.path.toLowerCase().replaceAll('/', '\\'))) return false;
    const call = module.baseAddress + BUILD_DIALOG_CONSTRUCTOR_CALL_RVA;
    const preceding = call - 15;
    if (preceding < 0 || call + 5 > memory.length) return false;
    for (let i = 0; i < ORIGINAL_CALL.length; i++) if (memory[call + i] !== ORIGINAL_CALL[i]) return false;
    // The reviewed caller must still fetch BuildGroupPtr with a null default.
    for (let i = 0; i < GET_BUILD_GROUP_PTR.length; i++)
        if (memory[preceding + i] !== GET_BUILD_GROUP_PTR[i]) return false;

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
    new DataView(memory.buffer, memory.byteOffset, memory.byteLength).setInt32(call + 1, rel, true);
    cpu?.jit_dirty_cache?.(trampoline, trampoline + code.length);
    cpu?.jit_dirty_cache?.(call, call + 5);
    return true;
}
