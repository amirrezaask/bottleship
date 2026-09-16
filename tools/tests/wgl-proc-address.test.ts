import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { APIRegistry } from "../../src/worker/core/api-registry";
import { System } from "../../src/worker/core/system";
import { ThunkGenerator } from "../../src/worker/core/thunking/thunk-generator";
import { opengl32Module } from "../../src/worker/api/opengl32.api";
import { createWglExports } from "../../src/worker/modules/opengl32/wgl";

APIRegistry.getInstance().registerModule(opengl32Module);
const system = System.getInstance();
let previousProcess: typeof system.process;
let memory: Uint8Array;
let thunks: ThunkGenerator;
let lookup: (name: string) => number;
let bindings: number;
beforeEach(() => {
    previousProcess = system.process;
    memory = new Uint8Array(128 * 1024);
    thunks = new ThunkGenerator();
    thunks.setBaseAddress(0x1000, 64 * 1024);
    bindings = 0;
    const process = {
        dispatcher: { thunkGenerator: thunks, applyPendingRegistrations() { bindings++; } },
        getCurrentMemory: () => memory,
    };
    system.process = process as never;
    const exports = createWglExports({ process } as never);
    lookup = name => {
        memory.fill(0, 0x100, 0x200);
        memory.set(new TextEncoder().encode(name), 0x100);
        return exports.wglGetProcAddress!({} as never, memory, [0x100]) as number;
    };
});
afterEach(() => { system.process = previousProcess; });

describe("WGL extension resolution", () => {
    test("creates callable compiled-vertex-array exports without a loaded PE", () => {
        const address = lookup("glLockArraysEXT");
        expect(address).not.toBe(0);
        expect(thunks.getStubByAddress(address)).toMatchObject({ dllName: "opengl32", functionName: "glLockArraysEXT", stackCleanupBytes: 8 });
        expect(memory[address]).not.toBe(0);
        expect(lookup("glLockArraysEXT")).toBe(address);
        expect(bindings).toBe(1);
        expect(lookup("glUnlockArraysEXT")).not.toBe(0);
    });
    test("resolves ARB aliases with the core function's ABI", () => {
        const address = lookup("glActiveTextureARB");
        expect(address).not.toBe(0);
        expect(thunks.getStubByAddress(address)).toMatchObject({ dllName: "opengl32", functionName: "glActiveTextureARB", stackCleanupBytes: 4 });
    });
    test("does not borrow an unrelated DLL export for an unsupported extension", () => {
        thunks.allocateOneStub("unrelated", "glMissingExtension", 1, "stdcall", 4);
        expect(lookup("glMissingExtension")).toBe(0);
    });
});
