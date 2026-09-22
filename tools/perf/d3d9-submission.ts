// Synthetic D3D9 submission workload. No GPU or guest game; measures host recording
// overhead and WebGPU API calls for repeated geometry bindings and one upload/frame.
// bun tools/perf/d3d9-submission.ts
import { performance } from 'node:perf_hooks';
import { RenderFramePool, RenderCommandType } from '../../src/worker/backends/webgpu/render-frame';
import { D3D9CommandRecorder } from '../../src/worker/backends/webgpu/d3d9/d3d9-command-recorder';
import { GeometryUploadBatch } from '../../src/worker/backends/webgpu/d3d9/geometry-upload-batch';

(globalThis as any).GPUBufferUsage ??= { COPY_SRC: 4, COPY_DST: 8 };
const frames = 4000;
const draws = 128;
const runs = 3;
const data = new Uint8Array(4096);
const vb = {} as GPUBuffer, ib = {} as GPUBuffer;
const output = {} as GPUBuffer;
const counts = { writes: 0, stagedBytes: 0, encoders: 0, submits: 0, binds: 0 };
const device = {
  createBuffer: ({ size }: { size: number }) => ({ size, destroy() {} }),
  createCommandEncoder: () => {
    counts.encoders++;
    return { copyBufferToBuffer() {}, finish: () => ({}) };
  },
} as unknown as GPUDevice;
const queue = {
  writeBuffer(buffer: GPUBuffer, _offset: number, _bytes: Uint8Array, _start?: number, size?: number) {
    counts.writes++;
    if (buffer !== output) counts.stagedBytes += size ?? _bytes.byteLength;
  },
  submit() { counts.submits++; },
} as unknown as GPUQueue;

const samples: Array<{ ms: number; commands: number; binds: number; writes: number; stagedBytes: number; encoders: number; submits: number }> = [];
for (let run = -1; run < runs; run++) {
  Object.assign(counts, { writes: 0, stagedBytes: 0, encoders: 0, submits: 0, binds: 0 });
  const recorder = new D3D9CommandRecorder(new RenderFramePool(2));
  const uploader = new GeometryUploadBatch(device);
  let commands = 0;
  const started = performance.now();
  for (let frameIndex = 0; frameIndex < frames; frameIndex++) {
    uploader.upload(queue, [output], [data]);
    for (let i = 0; i < draws; i++) {
      recorder.recordDrawIndexed({ pipelineId: 0, vbGpuBuffer: vb, vbOffset: 0, vbSize: data.length,
        ibGpuBuffer: ib, ibFormat: 'uint16', indexCount: 6, startIndex: i * 6, baseVertex: 0 });
    }
    const frame = recorder.finalize();
    commands += frame.commandTypes.length;
    counts.binds += frame.commandTypes.filter(type => type === RenderCommandType.SetVertexBuffer || type === RenderCommandType.SetIndexBuffer).length;
  }
  const ms = performance.now() - started;
  uploader.dispose();
  if (run >= 0) samples.push({ ms: +ms.toFixed(3), commands, binds: counts.binds,
    writes: counts.writes, stagedBytes: counts.stagedBytes, encoders: counts.encoders, submits: counts.submits });
}
console.log(JSON.stringify({ workload: { frames, drawsPerFrame: draws, uploadBytesPerFrame: data.length,
  note: 'synthetic CPU recording and mock queue calls; no GPU work or game FPS' }, samples }, null, 2));
