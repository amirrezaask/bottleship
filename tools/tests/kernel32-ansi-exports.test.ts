import { expect, test } from "bun:test";
import { kernel32Module } from "../../src/worker/api/kernel32.api";
import { APIRegistry } from "../../src/worker/core/api-registry";
import { exports as localeExports } from "../../src/worker/modules/kernel32/locale";

test("undecorated KERNEL32 string exports share the ANSI ABI and handler", () => {
    const registry = APIRegistry.getInstance();
    registry.registerModule(kernel32Module);
    for (const [name, count] of Object.entries({
        lstrlen: 1,
        lstrcpy: 2,
        lstrcat: 2,
        lstrcmp: 2,
        lstrcmpi: 2,
        lstrcpyn: 3,
    })) {
        expect(registry.getArgCount("kernel32", name)).toBe(count);
        expect(registry.getStackCleanupBytes("kernel32", name)).toBe(count * 4);
        expect(localeExports[name]).toBe(localeExports[`${name}A`]);
    }
});
