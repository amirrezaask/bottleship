/** Coalesce geometry uploads into a bounded staging buffer. Submit each batch's
 * copies before reusing staging, so later writes cannot replace earlier data. */
export class GeometryUploadBatch {
    static readonly MAX_BYTES = 4 * 1024 * 1024;
    private buffer: GPUBuffer | null = null;
    private bytes = new Uint8Array(0);
    private uploadCalls = 0;
    private uploadBytes = 0;
    private batches = 0;

    constructor(private readonly device: GPUDevice) {}

    upload(queue: GPUQueue, buffers: readonly GPUBuffer[], data: readonly Uint8Array[], offsets: readonly number[] = [],
        sources: readonly (GPUBuffer | null)[] = [], copySizes: readonly number[] = []): void {
        let required = 0;
        for (const bytes of data) required = Math.min(GeometryUploadBatch.MAX_BYTES, required + bytes.byteLength);
        if (!required) return;
        if (this.bytes.byteLength < required) {
            const capacity = Math.min(GeometryUploadBatch.MAX_BYTES, 2 ** Math.ceil(Math.log2(Math.max(4096, required))));
            this.buffer?.destroy();
            this.bytes = new Uint8Array(capacity);
            this.buffer = this.device.createBuffer({ label: "geometry-upload-staging", size: capacity,
                usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
        }
        let encoder: GPUCommandEncoder | null = null;
        let used = 0;
        const flush = () => {
            if (!encoder) return;
            queue.writeBuffer(this.buffer!, 0, this.bytes, 0, used);
            queue.submit([encoder.finish()]);
            this.batches = Math.min(Number.MAX_SAFE_INTEGER, this.batches + 1);
            encoder = null; used = 0;
        };
        for (let index = 0; index < data.length; index++) {
            const source = data[index];
            const targetOffset = offsets[index] ?? 0;
            if (sources[index]) {
                encoder ??= this.device.createCommandEncoder({ label: "geometry-upload-copies" });
                encoder.copyBufferToBuffer(sources[index]!, 0, buffers[index], 0, copySizes[index]);
            }
            if (source.byteLength % 4 !== 0) throw new Error("Geometry upload must be four-byte aligned");
            this.uploadCalls = Math.min(Number.MAX_SAFE_INTEGER, this.uploadCalls + 1);
            this.uploadBytes = Math.min(Number.MAX_SAFE_INTEGER, this.uploadBytes + source.byteLength);
            for (let offset = 0; offset < source.byteLength;) {
                const length = Math.min(source.byteLength - offset, this.bytes.byteLength - used);
                this.bytes.set(source.subarray(offset, offset + length), used);
                encoder ??= this.device.createCommandEncoder({ label: "geometry-upload-copies" });
                encoder.copyBufferToBuffer(this.buffer!, used, buffers[index], targetOffset + offset, length);
                offset += length; used += length;
                if (used === this.bytes.byteLength) flush();
            }
        }
        flush();
    }

    getStats() { return { geometryUploadCalls: this.uploadCalls, geometryUploadBytes: this.uploadBytes,
        geometryUploadBatches: this.batches, geometryUploadStagingBytes: this.bytes.byteLength }; }
    resetStats(): void { this.uploadCalls = 0; this.uploadBytes = 0; this.batches = 0; }
    dispose(): void { this.buffer?.destroy(); this.buffer = null; this.bytes = new Uint8Array(0); }
}
