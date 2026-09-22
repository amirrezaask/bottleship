import { describe, expect, test } from "bun:test";
import { D3D9StateTracker } from "../../src/worker/backends/webgpu/d3d9/d3d9-state-tracker";

describe("D3D9StateTracker defaults", () => {
    test("depth state defaults and reset match D3D9", () => {
        const state = new D3D9StateTracker();
        for (const [renderState, expected] of [[7, 1], [14, 1], [23, 4]]) {
            expect(state.getRenderState(renderState)).toBe(expected);
            state.setRenderState(renderState, 0);
        }
        state.reset();
        for (const [renderState, expected] of [[7, 1], [14, 1], [23, 4]]) {
            expect(state.getRenderState(renderState)).toBe(expected);
        }
    });

    test("defaults D3DRS_TEXTUREFACTOR to opaque white", () => {
        const state = new D3D9StateTracker();

        expect(state.getRenderState(60) >>> 0).toBe(0xffffffff);

        state.setRenderState(60, 0x12345678);
        state.reset();
        expect(state.getRenderState(60) >>> 0).toBe(0xffffffff);
    });
});
