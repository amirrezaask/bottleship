import { expect, test } from 'bun:test';
import { RenderCommandType, RenderFramePool } from '../../src/worker/backends/webgpu/render-frame';
import { D3D9CommandRecorder } from '../../src/worker/backends/webgpu/d3d9/d3d9-command-recorder';

const gpu = () => ({} as GPUBuffer);
const commands = (frame: ReturnType<D3D9CommandRecorder['finalize']>, type: RenderCommandType) =>
    frame.commandTypes.flatMap((t, i) => t === type ? [i] : []);

test('repeated bindings are elided across indexed, plain and pipeline-changed draws', () => {
    const recorder = new D3D9CommandRecorder(new RenderFramePool());
    const vb = gpu(), ib = gpu();
    const indexed = { pipelineId: 1, vbGpuBuffer: vb, vbOffset: 0, vbSize: 128,
        ibGpuBuffer: ib, ibFormat: 'uint16' as const, indexCount: 6, startIndex: 0, baseVertex: 0 };
    recorder.recordDrawIndexed(indexed);
    recorder.recordDrawIndexed({ ...indexed, startIndex: 6, pipelineId: 2 });
    recorder.recordDraw({ pipelineId: 1, gpuBuffer: vb, bufferOffset: 0, bufferSize: 128,
        vertexCount: 3, startVertex: 0 });
    const frame = recorder.finalize();
    expect(commands(frame, RenderCommandType.SetVertexBuffer)).toHaveLength(1);
    expect(commands(frame, RenderCommandType.SetIndexBuffer)).toHaveLength(1);
    expect(commands(frame, RenderCommandType.DrawIndexed)).toHaveLength(2);
    expect(commands(frame, RenderCommandType.Draw)).toHaveLength(1);
    recorder.recordDrawIndexed(indexed);
    const next = recorder.finalize();
    expect(commands(next, RenderCommandType.SetVertexBuffer)).toHaveLength(1);
    expect(commands(next, RenderCommandType.SetIndexBuffer)).toHaveLength(1);
});

test('replaying interleaved draws sees the intended binding at every draw', () => {
    const recorder = new D3D9CommandRecorder(new RenderFramePool());
    const a = gpu(), b = gpu(), i16 = gpu(), i32 = gpu();
    const expected = [
        { vertex: a, offset: 0, size: 128, index: i16, format: 16 },
        { vertex: a, offset: 0, size: 128, index: i16, format: 16 },
        { vertex: b, offset: 8, size: 120, index: i32, format: 32 },
        { vertex: a, offset: 0, size: 128, index: i16, format: 16 },
    ];
    expected.forEach((draw, n) => recorder.recordDrawIndexed({
        pipelineId: n % 2, vbGpuBuffer: draw.vertex, vbOffset: draw.offset, vbSize: draw.size,
        ibGpuBuffer: draw.index, ibFormat: draw.format === 16 ? 'uint16' : 'uint32',
        indexCount: 6, startIndex: n * 6, baseVertex: 0,
    }));
    const frame = recorder.finalize();
    let vertex: GPUBuffer | undefined, index: GPUBuffer | undefined;
    let offset = -1, size = -1, format = -1, draws = 0;
    for (let n = 0; n < frame.commandTypes.length; n++) {
        switch (frame.commandTypes[n]) {
            case RenderCommandType.SetVertexBuffer:
                vertex = frame.bufferRefs[frame.commandA[n]];
                offset = frame.commandB[n]; size = frame.commandC[n]; break;
            case RenderCommandType.SetIndexBuffer:
                index = frame.bufferRefs[frame.commandA[n]];
                format = frame.commandB[n]; break;
            case RenderCommandType.DrawIndexed:
                expect({ vertex, offset, size, index, format }).toEqual(expected[draws++]);
                break;
        }
    }
    expect(draws).toBe(expected.length);
});

test('buffer identity, byte range, format and independent stream slots still bind', () => {
    const recorder = new D3D9CommandRecorder(new RenderFramePool());
    const vb = gpu(), nextVb = gpu(), ib = gpu(), extra = gpu();
    const indexed = { pipelineId: 0, vbGpuBuffer: vb, vbOffset: 0, vbSize: 128,
        ibGpuBuffer: ib, ibFormat: 'uint16' as const, indexCount: 6, startIndex: 0, baseVertex: 0,
        extraStreams: [{ slot: 1, buffer: extra, offset: 4, size: 32 }] };
    recorder.recordDrawIndexed(indexed);
    recorder.recordDrawIndexed({ ...indexed, vbOffset: 4, vbSize: 124 });
    recorder.recordDrawIndexed({ ...indexed, vbGpuBuffer: nextVb, ibFormat: 'uint32' });
    recorder.recordDrawIndexed({ ...indexed, vbGpuBuffer: nextVb, ibFormat: 'uint32',
        extraStreams: [{ slot: 1, buffer: extra, offset: 8, size: 28 }] });
    const frame = recorder.finalize();
    const vertex = commands(frame, RenderCommandType.SetVertexBuffer);
    const index = commands(frame, RenderCommandType.SetIndexBuffer);
    expect(vertex).toHaveLength(5); // stream 0: 3 changes; stream 1: 2
    expect(vertex.map(i => frame.commandD[i])).toEqual([0, 1, 0, 0, 1]);
    expect(index).toHaveLength(2);
    expect(index.map(i => frame.commandB[i])).toEqual([16, 32]);
    // Skipped binds must not drop ownership of buffers that still have draws.
    expect(frame.referencedBuffers.has(vb)).toBe(true);
    expect(frame.referencedBuffers.has(nextVb)).toBe(true);
    expect(frame.referencedBuffers.has(extra)).toBe(true);
});
