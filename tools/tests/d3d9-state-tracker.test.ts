import { describe, expect, test } from "bun:test";
import { D3D9StateTracker } from "../../src/worker/backends/webgpu/d3d9/d3d9-state-tracker";

describe("D3D9StateTracker defaults", () => {
    test("defaults D3DRS_TEXTUREFACTOR to opaque white", () => {
        const state = new D3D9StateTracker();

        expect(state.getRenderState(60) >>> 0).toBe(0xffffffff);

        state.setRenderState(60, 0x12345678);
        state.reset();
        expect(state.getRenderState(60) >>> 0).toBe(0xffffffff);
    });
});
