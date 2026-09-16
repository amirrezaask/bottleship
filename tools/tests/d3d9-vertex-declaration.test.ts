import { afterEach, beforeEach, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { System } from "../../src/worker/core/system";
import { createStateExports } from "../../src/worker/modules/d3d9/state";
import { vertexDeclComObjects } from "../../src/worker/backends/webgpu/d3d9/d3d9-com-objects";

const getDeclaration = createStateExports().IDirect3DVertexDeclaration9_GetDeclaration!;
let memory: Uint8Array;
beforeEach(() => {
    memory = new Uint8Array(4096);
    Mem.bind(() => memory);
    vertexDeclComObjects.set(0x100, {
        devicePtr: 0x80, internalHandle: 1,
        elements: [
            { stream: 0, offset: 0, type: 2, usage: 0, usageIndex: 0 },
            { stream: 1, offset: 0, type: 1, usage: 5, usageIndex: 0 },
        ],
    });
});
afterEach(() => {
    vertexDeclComObjects.delete(0x100);
    Mem.bind(() => System.getInstance().process?.getCurrentMemory() ?? new Uint8Array());
});

test("size query includes the declaration terminator", () => {
    expect(getDeclaration({} as never, memory, [0x100, 0, 0x200])).toBe(0);
    expect(new DataView(memory.buffer).getUint32(0x200, true)).toBe(3);
});

test("type-based RenderWare scanning stops before the next stream", () => {
    memory.fill(0xaa, 0x300, 0x330);
    expect(getDeclaration({} as never, memory, [0x100, 0x300, 0x200])).toBe(0);
    const view = new DataView(memory.buffer);
    let streamCount = 0, scanned = 0;
    for (; scanned < 4; scanned++) {
        const ptr = 0x300 + scanned * 8;
        if (view.getUint8(ptr + 4) === 17) break;
        streamCount = Math.max(streamCount, view.getUint16(ptr, true) + 1);
    }
    expect(scanned).toBe(2);
    expect(streamCount).toBe(2);
    expect([...memory.subarray(0x310, 0x318)]).toEqual([255, 0, 0, 0, 17, 0, 0, 0]);
    expect(memory[0x318]).toBe(0xaa);
});

test("rejects a missing count pointer or unknown declaration", () => {
    expect(getDeclaration({} as never, memory, [0x100, 0x300, 0])).toBe(0x8876086c);
    expect(getDeclaration({} as never, memory, [0x108, 0x300, 0x200])).toBe(0x8876086c);
});
