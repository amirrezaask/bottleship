/**
 * D3D9CommandRecorder - Records draw commands into a RenderFrame
 *
 * Separated from D3D9Device to enable command batching,
 * multi-threading preparation, and cleaner separation of concerns.
 */

import { RenderFrame, RenderFramePool } from "../render-frame";

/** Extra vertex-stream binding (multi-stream D3D8 declarations): slot = stream number. */
export interface StreamVertexBinding {
    slot: number;
    buffer: GPUBuffer;
    offset: number;
    size: number;
}

export interface DrawCommand {
    pipelineId: number;
    gpuBuffer: GPUBuffer;
    bufferOffset: number;
    bufferSize: number;
    vertexCount: number;
    startVertex: number;
    /** Programmable (VS/PS) per-draw state index, or undefined for FFP. */
    bindStateIndex?: number;
    /** Streams beyond 0 — bound with setVertexBuffer(slot, …) before the draw. */
    extraStreams?: StreamVertexBinding[];
}

export interface DrawIndexedCommand {
    pipelineId: number;
    vbGpuBuffer: GPUBuffer;
    vbOffset: number;
    vbSize: number;
    ibGpuBuffer: GPUBuffer;
    ibFormat: "uint16" | "uint32";
    indexCount: number;
    startIndex: number;
    baseVertex: number;
    bindStateIndex?: number;
    /** Streams beyond 0 — bound with setVertexBuffer(slot, …) before the draw. */
    extraStreams?: StreamVertexBinding[];
}

export class D3D9CommandRecorder {
    private frame: RenderFrame;
    private currentPipelineId: number | null = null;
    /** Last-emitted BindProgrammable state index (Phase C elision). Consecutive draws that
     *  captured the identical state share one slot (see D3D9Device.captureDrawState) — the
     *  redundant re-bind command is skipped. Reset on pipeline change (bind-group layout may
     *  differ per pipeline) and at finalize (executor bind caches reset per pass/frame). */
    private currentBindStateIndex: number | null = null;
    private drawCount = 0;
    // WebGPU retains vertex/index bindings across draws and pipeline changes.
    // These mirrors describe commands emitted in the current render pass only.
    private readonly vertexBindings: ({ buffer: GPUBuffer; offset: number; size: number } | null)[] = [];
    private indexBinding: { buffer: GPUBuffer; format: "uint16" | "uint32" } | null = null;

    constructor(private framePool: RenderFramePool) {
        this.frame = framePool.acquire();
    }

    /**
     * Set clear color for the frame
     */
    setClear(color: GPUColor, depth: number, flags: number): void {
        this.frame.setClear(color, depth, flags);
    }

    /**
     * Queue a buffer upload for the current frame
     */
    queueUpload(buffer: GPUBuffer, data: Uint8Array, offset = 0, source: GPUBuffer | null = null, copySize = 0): void {
        this.frame.queueUpload(buffer, data, offset, source, copySize);
    }

    /**
     * Record a non-indexed draw call
     */
    recordDraw(cmd: DrawCommand): void {
        if (this.currentPipelineId !== cmd.pipelineId) {
            this.frame.pushSetPipeline(cmd.pipelineId);
            this.currentPipelineId = cmd.pipelineId;
            this.currentBindStateIndex = null;
        }

        if (cmd.bindStateIndex !== undefined && cmd.bindStateIndex !== this.currentBindStateIndex) {
            this.frame.pushBindProgrammable(cmd.bindStateIndex);
            this.currentBindStateIndex = cmd.bindStateIndex;
        }
        this.bindVertex(0, cmd.gpuBuffer, cmd.bufferOffset, cmd.bufferSize);
        if (cmd.extraStreams) {
            for (const s of cmd.extraStreams) this.bindVertex(s.slot, s.buffer, s.offset, s.size);
        }
        this.frame.pushDraw(cmd.vertexCount, cmd.startVertex);
        this.drawCount++;
    }

    /**
     * Record an indexed draw call
     */
    recordDrawIndexed(cmd: DrawIndexedCommand): void {
        if (this.currentPipelineId !== cmd.pipelineId) {
            this.frame.pushSetPipeline(cmd.pipelineId);
            this.currentPipelineId = cmd.pipelineId;
            this.currentBindStateIndex = null;
        }

        if (cmd.bindStateIndex !== undefined && cmd.bindStateIndex !== this.currentBindStateIndex) {
            this.frame.pushBindProgrammable(cmd.bindStateIndex);
            this.currentBindStateIndex = cmd.bindStateIndex;
        }
        this.bindVertex(0, cmd.vbGpuBuffer, cmd.vbOffset, cmd.vbSize);
        if (cmd.extraStreams) {
            for (const s of cmd.extraStreams) this.bindVertex(s.slot, s.buffer, s.offset, s.size);
        }
        if (this.indexBinding?.buffer !== cmd.ibGpuBuffer || this.indexBinding.format !== cmd.ibFormat) {
            this.frame.pushSetIndexBuffer(cmd.ibGpuBuffer, cmd.ibFormat);
            this.indexBinding = { buffer: cmd.ibGpuBuffer, format: cmd.ibFormat };
        }
        this.frame.pushDrawIndexed(cmd.indexCount, cmd.startIndex, cmd.baseVertex);
        this.drawCount++;
    }

    private bindVertex(slot: number, buffer: GPUBuffer, offset: number, size: number): void {
        const bound = this.vertexBindings[slot];
        if (bound?.buffer === buffer && bound.offset === offset && bound.size === size) return;
        this.frame.pushSetVertexBuffer(buffer, offset, size, slot);
        this.vertexBindings[slot] = { buffer, offset, size };
    }

    /**
     * Finalize the current frame and prepare for the next one
     */
    finalize(): RenderFrame {
        const completedFrame = this.frame;
        this.frame = this.framePool.acquire();
        this.currentPipelineId = null;
        this.currentBindStateIndex = null;
        this.vertexBindings.length = 0;
        this.indexBinding = null;
        return completedFrame;
    }

    /**
     * Check if the current frame has any work to do
     */
    hasWork(): boolean {
        return this.frame.hasWork();
    }

    registerTemporaryBuffer(buffer: GPUBuffer): void {
        this.frame.registerTemporaryBuffer(buffer);
    }

    registerPooledBuffer(buffer: GPUBuffer): void {
        this.frame.registerPooledBuffer(buffer);
    }

    /**
     * Get the number of draw calls recorded in the current frame
     */
    getDrawCount(): number {
        return this.drawCount;
    }

    /**
     * Reset draw count (call after present)
     */
    resetDrawCount(): void {
        this.drawCount = 0;
    }

    /**
     * Get the current frame for direct manipulation (advanced use)
     */
    getCurrentFrame(): RenderFrame {
        return this.frame;
    }
}
