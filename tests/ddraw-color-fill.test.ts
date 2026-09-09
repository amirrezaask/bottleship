import { expect, it } from "bun:test";
import { fillSurfaceColor } from "../src/worker/modules/ddraw/surface-color-fill";

it("fills 16-bit DirectDraw rows without per-pixel guest Proxy writes", () => {
    const backing = new Uint8Array(64).fill(0xee);
    let numericWrites = 0;
    const memory = new Proxy(backing, {
        get(target, key) {
            if (key === "constructor") return Uint8Array.bind(target);
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
        },
        set(target, key, value) {
            if (typeof key === "string" && /^\d+$/.test(key)) numericWrites++;
            return Reflect.set(target, key, value, target);
        },
    });

    fillSurfaceColor(memory, 8, 12, 1, 1, 3, 2, 2, 0x1234);

    expect(numericWrites).toBe(0);
    expect([...backing.slice(22, 28)]).toEqual([0x34, 0x12, 0x34, 0x12, 0x34, 0x12]);
    expect([...backing.slice(34, 40)]).toEqual([0x34, 0x12, 0x34, 0x12, 0x34, 0x12]);
    expect(backing[21]).toBe(0xee);
    expect(backing[28]).toBe(0xee);
});
