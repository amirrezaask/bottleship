/** GPU-only D3D9 color-surface copies. No presentation effects or alpha blending. */
export type SurfaceRect = { left: number; top: number; right: number; bottom: number };

export function readSurfaceRect(mem: Uint8Array, ptr: number, width: number, height: number): SurfaceRect | null {
    if (!ptr) return { left: 0, top: 0, right: width, bottom: height };
    if (!Number.isInteger(ptr) || ptr < 0 || ptr > mem.byteLength - 16) return null;
    const view = new DataView(mem.buffer, mem.byteOffset + ptr, 16);
    const rect = { left: view.getInt32(0, true), top: view.getInt32(4, true), right: view.getInt32(8, true), bottom: view.getInt32(12, true) };
    return rect.left >= 0 && rect.top >= 0 && rect.right <= width && rect.bottom <= height &&
        rect.right > rect.left && rect.bottom > rect.top ? rect : null;
}

export class SurfaceBlitter {
    private pipelines = new Map<GPUTextureFormat, GPURenderPipeline>();
    private samplers: GPUSampler[];
    private uniform: GPUBuffer;

    constructor(private device: GPUDevice) {
        this.samplers = ["nearest", "linear"].map(filter => device.createSampler({
            minFilter: filter as GPUFilterMode, magFilter: filter as GPUFilterMode,
        }));
        this.uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    }

    copy(source: GPUTexture, dest: GPUTexture, from: SurfaceRect, to: SurfaceRect, linear: boolean): void {
        let pipeline = this.pipelines.get(dest.format);
        if (!pipeline) {
            const module = this.device.createShaderModule({ code: `
                @group(0) @binding(0) var image: texture_2d<f32>;
                @group(0) @binding(1) var filtering: sampler;
                @group(0) @binding(2) var<uniform> uvRect: vec4f;
                struct Vertex { @builtin(position) position: vec4f, @location(0) uv: vec2f };
                @vertex fn vs(@builtin(vertex_index) i: u32) -> Vertex {
                    let p = array<vec2f, 3>(vec2f(-1., -1.), vec2f(3., -1.), vec2f(-1., 3.))[i];
                    return Vertex(vec4f(p, 0., 1.), uvRect.xy + vec2f(p.x * .5 + .5, .5 - p.y * .5) * uvRect.zw);
                }
                @fragment fn fs(v: Vertex) -> @location(0) vec4f { return textureSample(image, filtering, v.uv); }
            ` });
            pipeline = this.device.createRenderPipeline({ layout: "auto",
                vertex: { module, entryPoint: "vs" }, fragment: { module, entryPoint: "fs", targets: [{ format: dest.format }] },
                primitive: { topology: "triangle-list" },
            });
            this.pipelines.set(dest.format, pipeline);
        }
        // Each call submits before the next write, so this single 16-byte buffer is safe to reuse.
        this.device.queue.writeBuffer(this.uniform, 0, new Float32Array([
            from.left / source.width, from.top / source.height,
            (from.right - from.left) / source.width, (from.bottom - from.top) / source.height,
        ]));
        const group = this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
            { binding: 0, resource: source.createView({ dimension: "2d", baseMipLevel: 0, mipLevelCount: 1 }) },
            { binding: 1, resource: this.samplers[linear ? 1 : 0] },
            { binding: 2, resource: { buffer: this.uniform } },
        ] });
        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginRenderPass({ colorAttachments: [{
            view: dest.createView({ dimension: "2d", baseMipLevel: 0, mipLevelCount: 1 }), loadOp: "load", storeOp: "store",
        }] });
        pass.setViewport(to.left, to.top, to.right - to.left, to.bottom - to.top, 0, 1);
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.draw(3);
        pass.end();
        this.device.queue.submit([encoder.finish()]);
    }

    dispose(): void { this.uniform.destroy(); this.pipelines.clear(); }
}
