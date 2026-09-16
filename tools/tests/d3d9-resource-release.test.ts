import { afterEach, describe, expect, test } from "bun:test";
import { createResourcesExports } from "../../src/worker/modules/d3d9/resources";
import { resourceRefCounts } from "../../src/worker/modules/d3d9/resource-registry";
import { resourceToDevice, resetD3D9SharedState } from "../../src/worker/modules/d3d9/shared-state";

const exports = createResourcesExports();
const memory = new Uint8Array();

function call(name: string, resourcePtr: number): number {
    return exports[name]!({} as never, memory, [resourcePtr]) as number;
}

afterEach(() => resetD3D9SharedState());

describe("D3D9 buffer COM lifetime", () => {
    test("destroys a vertex buffer only when its final reference is released", () => {
        const ptr = 0x4000;
        let releases = 0;
        resourceToDevice.set(ptr, { releaseVertexBuffer: () => { releases++; } } as never);
        resourceRefCounts.set(ptr, 1);

        expect(call("IDirect3DVertexBuffer9_AddRef", ptr)).toBe(2);
        expect(call("IDirect3DVertexBuffer9_Release", ptr)).toBe(1);
        expect(releases).toBe(0);
        expect(resourceToDevice.has(ptr)).toBe(true);

        expect(call("IDirect3DVertexBuffer9_Release", ptr)).toBe(0);
        expect(releases).toBe(1);
        expect(resourceRefCounts.has(ptr)).toBe(false);
        expect(resourceToDevice.has(ptr)).toBe(false);
    });

    test("routes final index-buffer release to its owning device", () => {
        const ptr = 0x5000;
        let releasedPtr = 0;
        resourceToDevice.set(ptr, { releaseIndexBuffer: (value: number) => { releasedPtr = value; } } as never);
        resourceRefCounts.set(ptr, 1);

        expect(call("IDirect3DIndexBuffer9_Release", ptr)).toBe(0);
        expect(releasedPtr).toBe(ptr);
        expect(resourceToDevice.has(ptr)).toBe(false);
    });
});
