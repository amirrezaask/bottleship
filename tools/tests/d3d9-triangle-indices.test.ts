import { expect, test } from "bun:test";
import { expandTriangleIndices } from "../../src/worker/backends/webgpu/d3d9/triangle-indices";

test("triangle strip alternates winding and preserves degenerate triangles", () => {
    const bytes = new Uint8Array(new Uint16Array([7, 8, 8, 10, 11]).buffer);
    expect([...expandTriangleIndices(5, 3, 0, { bytes, indexBytes: 2 })!])
        .toEqual([7,8,8, 8,8,10, 8,10,11]);
    expect([...expandTriangleIndices(5, 3, 4)!]).toEqual([4,5,6, 6,5,7, 6,7,8]);
});

test("fan keeps its center and honors a nonzero first index", () => {
    const bytes = new Uint8Array(new Uint32Array([99, 10, 11, 12, 13]).buffer);
    expect([...expandTriangleIndices(6, 2, 1, { bytes, indexBytes: 4 })!])
        .toEqual([10,11,12, 10,12,13]);
});

test("all-ones indices remain vertex indices, not primitive restart", () => {
    const bytes = new Uint8Array(new Uint16Array([0, 65535, 2]).buffer);
    expect([...expandTriangleIndices(5, 1, 0, { bytes, indexBytes: 2 })!]).toEqual([0,65535,2]);
});

test("rejects truncated input and excessive scratch before allocating", () => {
    expect(expandTriangleIndices(5, 2, 0, { bytes: new Uint8Array(6), indexBytes: 2 })).toBeNull();
    expect(expandTriangleIndices(6, 1_048_577, 0)).toBeNull();
    expect(expandTriangleIndices(6, 2, -1)).toBeNull();
    expect(expandTriangleIndices(6, 1.5, 0)).toBeNull();
});
