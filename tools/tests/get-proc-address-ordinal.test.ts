import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { APIRegistry } from "../../src/worker/core/api-registry";
import { System } from "../../src/worker/core/system";
import { ThunkGenerator } from "../../src/worker/core/thunking/thunk-generator";
import { THUNKED_DLL_PSEUDO_BASE } from "../../src/worker/core/hle-system-catalog";
import { dsoundModule } from "../../src/worker/api/dsound.api";
import { ws2_32Module } from "../../src/worker/api/ws2_32.api";
import { exports } from "../../src/worker/modules/kernel32/module/module";

// The API registry's eager Vite glob is unavailable in Bun. Register only this
// fixture's descriptors; exercise the production GetProcAddress implementation.
const registry = APIRegistry.getInstance();
registry.registerModule(dsoundModule);
registry.registerModule(ws2_32Module);
const system = System.getInstance();
let previousProcess: typeof system.process;
let thunks: ThunkGenerator;
let memory: Uint8Array;
let wrongAddress: number;

beforeEach(() => {
    previousProcess = system.process;
    memory = new Uint8Array(128 * 1024);
    thunks = new ThunkGenerator();
    thunks.setBaseAddress(0x1000, 64 * 1024);
    wrongAddress = thunks.allocateOneStub("ws2_32", "ord_11", 1, "stdcall", 4).address;
    system.process = {
        dispatcher: { thunkGenerator: thunks, applyPendingRegistrations() {} },
        getCurrentMemory: () => memory,
        lastError: 0,
    } as unknown as NonNullable<typeof system.process>;
});
afterEach(() => { system.process = previousProcess; });

function lookup(module: number, ordinal: number): number {
    const result = exports.GetProcAddress!({ esp: 0 } as never, memory, [module, ordinal]) as { value: number; stackCleanup: number };
    expect(result.stackCleanup).toBe(8);
    return result.value;
}

describe("module-scoped GetProcAddress ordinals", () => {
    test("dsound ordinal 11 resolves DirectSoundCreate8, not the Winsock alias", () => {
        const address = lookup(THUNKED_DLL_PSEUDO_BASE.dsound!, 11);
        expect(address).not.toBe(0);
        expect(address).not.toBe(wrongAddress);
        expect(thunks.getStubByAddress(address)).toMatchObject({
            dllName: "dsound", functionName: "DirectSoundCreate8", argCount: 3, stackCleanupBytes: 12,
        });
        expect(lookup(THUNKED_DLL_PSEUDO_BASE.dsound!, 11)).toBe(address);
        expect(lookup(THUNKED_DLL_PSEUDO_BASE.ws2_32!, 11)).toBe(wrongAddress);
    });

    test("an unrelated short name cannot replace the declared ordinal target", () => {
        const other = thunks.allocateOneStub("unrelated", "DirectSoundCreate8", 1, "stdcall", 4).address;
        const address = lookup(THUNKED_DLL_PSEUDO_BASE.dsound!, 11);
        expect(address).not.toBe(other);
        expect(thunks.getStubByAddress(address)?.dllName).toBe("dsound");
    });

    test("missing ordinals and invalid handles fail rather than searching other DLLs", () => {
        expect(lookup(THUNKED_DLL_PSEUDO_BASE.dsound!, 12)).toBe(0);
        expect(lookup(THUNKED_DLL_PSEUDO_BASE.user32!, 11)).toBe(0);
        expect(lookup(0, 11)).toBe(0);
        expect(lookup(0x12345678, 11)).toBe(0);
        expect(system.process!.lastError).toBe(127);
    });

    test("a real PE's ordinal export takes precedence", () => {
        system.process!.moduleRegistry = {
            resolvePeModuleBase: (base: number) => base,
            getByBase: () => ({ ordinalExports: new Map([[11, 0x9000]]) }),
        } as never;
        expect(lookup(0x400000, 11)).toBe(0x9000);
    });

    test("metadata normalizes DLL names without borrowing ordinals", () => {
        expect(registry.getExportNameByOrdinal("DSOUND.DLL", 11)).toBe("DirectSoundCreate8");
        expect(registry.getExportNameByOrdinal("ws2_32", 11)).toBe("ord_11");
        expect(registry.getExportNameByOrdinal("dsound", 115)).toBeUndefined();
    });
});
