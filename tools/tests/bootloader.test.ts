import { describe, expect, test } from "bun:test";
import { createBootloader, createGDT, PF_HALT_TARGET } from "../../src/worker/core/bootloader";

describe("bootloader layout", () => {
    // Decode what the CPU reads: the old layout overwrote descriptor pointers
    // and DllMain calls when the variable-length code crossed the boot sector.
    test.each([0, 1, 11, 12, 22, 64])("preserves tables and calls for %i DLLs", (count) => {
        const dlls = Array.from({ length: count }, (_, i) => ({
            name: `dll${i}.dll`, baseAddress: 0x1000000 + i * 0x10000,
            entryPoint: 0x1001234 + i * 0x10000,
        }));
        const { code, loadAddress } = createBootloader(0x401000, 0x1100000, dlls);
        const view = new DataView(code.buffer);
        const gdtr = view.getUint16(10, true) - loadAddress;
        expect(gdtr).toBeLessThan(504);
        expect(view.getUint16(gdtr, true)).toBe(31);
        expect(view.getUint32(gdtr + 2, true)).toBe(0x7e00);
        expect(view.getUint16(gdtr + 6, true)).toBe(2047);
        expect(view.getUint32(gdtr + 8, true)).toBe(0x7e20);
        expect(code.slice(512, 544)).toEqual(createGDT().gdt);
        expect([...code.slice(510, 512)]).toEqual([0x55, 0xaa]);
        for (let i = 0; i < 256; i++) {
            const gate = 544 + i * 8;
            const target = view.getUint16(gate, true) | (view.getUint16(gate + 6, true) << 16);
            expect(view.getUint16(gate + 2, true)).toBe(8);
            expect(target).toBeGreaterThanOrEqual(0x8620);
            expect(target).toBeLessThan(0x8720);
        }
        expect(code[PF_HALT_TARGET - loadAddress]).toBe(0xfa);
        let offset = 0x8720 - loadAddress;
        for (const dll of dlls) {
            expect(code[offset]).toBe(0x68);
            expect(view.getUint32(offset + 1, true)).toBe(1);
            expect(view.getUint32(offset + 6, true)).toBe(1);
            expect(view.getUint32(offset + 11, true)).toBe(dll.baseAddress);
            expect(code[offset + 15]).toBe(0xb8);
            expect(view.getUint32(offset + 16, true)).toBe(dll.entryPoint);
            expect([...code.slice(offset + 20, offset + 22)]).toEqual([0xff, 0xd0]);
            offset += 35;
        }
        expect(code[offset]).toBe(0xb8);
        expect(view.getUint32(offset + 1, true)).toBe(0x401000);
        expect([...code.slice(offset + 5, offset + 7)]).toEqual([0xff, 0xe0]);
        expect(loadAddress + code.length).toBeLessThanOrEqual(0x9000);
    });
    test("rejects a DLL list beyond reserved low memory", () => {
        const dll = { name: "dll", baseAddress: 0x1000000, entryPoint: 0x1001234 };
        expect(() => createBootloader(0x401000, 0x1100000, Array(65).fill(dll)))
            .toThrow("DLL initialization exceeds the boot region");
    });
});
