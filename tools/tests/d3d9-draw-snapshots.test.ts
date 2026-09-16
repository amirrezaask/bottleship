import { afterEach, beforeEach, expect, test } from "bun:test";
import { D3D9Device } from "../../src/worker/backends/webgpu/d3d9/d3d9-device";
import { System } from "../../src/worker/core/system";
import { RenderFrame } from "../../src/worker/backends/webgpu/render-frame";
import { DynamicVbPool } from "../../src/worker/backends/webgpu/d3d9/dynamic-vb-pool";

let device: D3D9Device;
let internal: any;
let previousRenderer: any;
let builtPipelines: any[] = [];
const gpu = {
    queue: { writeBuffer() {} },
    createBuffer: ({ size, usage }: { size: number; usage: number }) => ({ size, usage, destroy() {} }),
    createSampler: () => ({}),
    createShaderModule: (descriptor: unknown) => descriptor,
    createRenderPipeline: (descriptor: unknown) => { builtPipelines.push(descriptor); return {}; },
};
beforeEach(() => {
    builtPipelines = [];
    globalThis.GPUBufferUsage ??= { VERTEX: 32, INDEX: 16, COPY_DST: 8 } as any;
    previousRenderer = System.getInstance().services.render.getActive();
    device = new D3D9Device({
        getDevice: () => gpu,
        getFormat: () => "rgba8unorm",
        getContext: () => ({ canvas: { width: 640, height: 480 } }),
    } as any, new Uint8Array(4096));
    internal = device as any;
    internal.getPipelineId = () => 0;
    device.createVertexBuffer(0x100, 36, 2);
    device.setStreamSource(0, 0x100, 0, 12);
});
afterEach(() => System.getInstance().services.render.setActive(previousRenderer));

test("two draws retain their own transforms and textures", () => {
    const firstTexture = {}, secondTexture = {};
    internal.resolveCurrentTexture = () => firstTexture;
    const matrix = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 3,0,0,1]);
    device.setTransform(256, matrix);
    device.drawPrimitive(4, 0, 1);
    internal.resolveCurrentTexture = () => secondTexture;
    matrix[12] = 9;
    device.setTransform(256, matrix);
    device.drawPrimitive(4, 0, 1);
    const frame: RenderFrame = internal.commandRecorder.getCurrentFrame();
    expect(frame.drawStateCount).toBe(2);
    expect(frame.drawStates[0].textures[0]).toBe(firstTexture);
    expect(frame.drawStates[1].textures[0]).toBe(secondTexture);
    expect(frame.drawStates[0].vsConst[16]).toBe(3);
    expect(frame.drawStates[1].vsConst[16]).toBe(9);
});

test("rewriting a buffer does not overwrite an earlier queued draw", () => {
    const store = internal.vertexBuffers;
    const index = store.getIndex(0x100);
    store.getData(index).fill(1);
    device.drawPrimitive(4, 0, 1);
    store.getData(index).fill(2);
    store.setDirty(index, true);
    device.drawPrimitive(4, 0, 1);
    const frame: RenderFrame = internal.commandRecorder.getCurrentFrame();
    expect(frame.bufferRefs[0]).not.toBe(frame.bufferRefs[1]);
    expect(frame.uploadData[0][0]).toBe(1);
    expect(frame.uploadData[1][0]).toBe(2);
    expect(frame.pooledBuffers).toEqual([frame.bufferRefs[0]]);
    expect(store.getGpuBuffer(index)).toBe(frame.bufferRefs[1]);
});

test("reused programmable slots cannot inherit a fixed-function binding", () => {
    const frame = new RenderFrame();
    frame.nextDrawState(332, 0).fixedFunction = true;
    frame.reset();
    expect(frame.nextDrawState(16, 16).fixedFunction).toBe(false);
});

test("persistent vertex-buffer fans emit geometry instead of returning success without a draw", () => {
    device.createVertexBuffer(0x200, 48, 2);
    device.setStreamSource(0, 0x200, 0, 12);
    expect(device.drawPrimitive(6, 0, 2)).toBe(0);
    const frame: RenderFrame = internal.commandRecorder.getCurrentFrame();
    expect(frame.commandTypes).toContain(5); // DrawIndexed
    expect(device.getDrawCount()).toBe(1);
});

test("idle geometry pool retains at most 16 MiB", () => {
    const pool = new DynamicVbPool(gpu as any, true);
    const buffers = Array.from({ length: 20 }, () => pool.acquire(1024 * 1024));
    for (const buffer of buffers) pool.release(buffer);
    expect(pool.destroys).toBe(4);
    const reused = pool.acquire(1024 * 1024);
    expect(pool.creates).toBe(20);
    expect(reused.usage & GPUBufferUsage.INDEX).not.toBe(0);
    pool.dispose();
});

test("a three-index upload is aligned without reading past guest data", () => {
    const frame = new RenderFrame();
    const bytes = new Uint8Array([99, 0, 0, 1, 0, 2, 0, 99]);
    frame.queueUpload({} as GPUBuffer, bytes.subarray(1, 7));
    bytes.fill(88);
    expect([...frame.uploadData[0]]).toEqual([0, 0, 1, 0, 2, 0, 0, 0]);
});

test("a viewport can grow again after rendering into a small region", () => {
    const memory = new Uint8Array(128), view = new DataView(memory.buffer);
    const setSize = (width: number, height: number) => {
        view.setUint32(24, width, true); view.setUint32(28, height, true);
        view.setFloat32(36, 1, true);
        expect(device.setViewport(16, memory)).toBe(0);
    };
    setSize(64, 64);
    setSize(640, 480);
    expect(device.getViewport()).toMatchObject({ width: 640, height: 480 });
    setSize(64, 64);
    device.setRenderTarget(0, 0);
    expect(device.getViewport()).toMatchObject({ width: 640, height: 480 });
});

test("re-selecting an FVF replaces a custom declaration used between draws", () => {
    device.setFVF(0x144);
    const declaration = device.createVertexDeclaration([{ stream: 0, offset: 0, type: 2, usage: 0, usageIndex: 0 }]);
    device.setVertexDeclaration(declaration.handle, 0x300);
    device.setFVF(0x144);
    expect(device.getVertexDeclaration()).toBe(0);
    expect(device.getFVF()).toBe(0x144);
    expect(internal.activeVertexDeclComPtr).toBe(0);
});

test("UP draws use their explicit stride and preserve disabled depth testing", () => {
    const declaration = device.createVertexDeclaration([
        { stream: 0, offset: 0, type: 2, usage: 0, usageIndex: 0 },
        { stream: 0, offset: 12, type: 4, usage: 10, usageIndex: 0 },
    ]);
    device.setVertexDeclaration(declaration.handle);
    device.setStreamSource(0, 0x100, 0, 36);
    device.setRenderState(7, 0);
    device.setRenderState(14, 0);
    device.drawPrimitiveUP(4, 1, 0x200, 16);
    device.drawPrimitiveUP(4, 1, 0x200, 20);
    expect(builtPipelines.map(p => p.vertex.buffers[0].arrayStride)).toEqual([16, 20]);
    expect(builtPipelines[0].depthStencil).toMatchObject({ depthWriteEnabled: false, depthCompare: "always" });
});

test("RenderWare split color and position streams retain separate GPU layouts and uploads", () => {
    const declaration = device.createVertexDeclaration([
        { stream: 0, offset: 0, type: 4, usage: 10, usageIndex: 0 },
        { stream: 1, offset: 0, type: 2, usage: 0, usageIndex: 0 },
        { stream: 1, offset: 12, type: 1, usage: 5, usageIndex: 0 },
    ]);
    device.setVertexDeclaration(declaration.handle);
    device.createVertexBuffer(0x300, 60, 0);
    device.setStreamSource(0, 0x100, 0, 4);
    device.setStreamSource(1, 0x300, 0, 20);
    delete internal.getPipelineId;
    expect(device.drawPrimitive(4, 0, 1)).toBe(0);
    const frame: RenderFrame = internal.commandRecorder.getCurrentFrame();
    expect(builtPipelines[0].vertex.buffers.map((v: any) => v.arrayStride)).toEqual([4, 20]);
    expect(builtPipelines[0].vertex.buffers[1].attributes[0]).toMatchObject({ offset: 0, format: "float32x3" });
    expect(frame.referencedBuffers.size).toBe(2);
    const binding = frame.commandTypes.findIndex((type, i) => type === 2 && frame.commandD[i] === 1);
    expect(binding).toBeGreaterThanOrEqual(0);
    expect(frame.uploadData.map(data => data.byteLength)).toEqual([36, 60]);
});
