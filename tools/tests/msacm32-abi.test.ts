import { expect, test } from "bun:test";
import { APIRegistry } from "../../src/worker/core/api-registry";
import { ThunkGenerator } from "../../src/worker/core/thunking/thunk-generator";

test("acmDriverDetailsA uses the documented three-argument stdcall ABI", () => {
    const registry = APIRegistry.getInstance();
    for (const [name, count] of Object.entries({
        acmDriverClose: 2,
        acmDriverDetailsA: 3,
        acmDriverEnum: 3,
        acmDriverOpen: 3,
        acmFormatSuggest: 5,
        acmMetrics: 3,
    })) {
        expect(registry.getArgCount("msacm32", name)).toBe(count);
        expect(registry.getStackCleanupBytes("msacm32", name)).toBe(count * 4);
    }
    const argCount = registry.getArgCount("msacm32", "acmDriverDetailsA");
    const stackCleanupBytes = registry.getStackCleanupBytes("msacm32", "acmDriverDetailsA");
    expect(argCount).toBe(3);
    expect(stackCleanupBytes).toBe(12);

    const thunks = new ThunkGenerator();
    thunks.setBaseAddress(0x1000, 4096);
    const dll = thunks.generateStubDll("msacm32", [
        { name: "acmDriverDetailsA", argCount, stackCleanupBytes },
    ]);
    expect(Array.from(dll.stubCode.slice(11, 14))).toEqual([0xc2, 12, 0]);
});
