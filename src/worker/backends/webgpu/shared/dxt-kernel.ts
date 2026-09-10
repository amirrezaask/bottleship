/** Bulk CPU fallback only; native BC uploads never pass through this module. */
const MAX_MEMORY = 64 * 1024 * 1024;
const MIN_PIXELS = 256;
export const dxtKernelUrl = new URL('./dxt-kernel.wasm', import.meta.url);

interface KernelExports extends WebAssembly.Exports {
    memory: WebAssembly.Memory;
    __heap_base: WebAssembly.Global;
    decode_dxt: (kind: number, src: number, srcLen: number, pitch: number,
        width: number, height: number, dst: number, dstLen: number) => number;
}

export class DxtKernel {
    private readonly api: KernelExports;
    private readonly base: number;
    private bytes: Uint8Array;

    constructor(instance: WebAssembly.Instance) {
        this.api = instance.exports as KernelExports;
        if (!(this.api.memory instanceof WebAssembly.Memory) ||
            !(this.api.__heap_base instanceof WebAssembly.Global) ||
            typeof this.api.decode_dxt !== 'function') {
            throw new Error('Invalid DXT WASM ABI');
        }
        this.base = Number(this.api.__heap_base.value);
        this.bytes = new Uint8Array(this.api.memory.buffer);
    }

    /** Input is validated by decodeDxtToRgba; Rust independently checks all spans. */
    tryDecode(kind: number, src: Uint8Array, pitch: number, width: number,
        height: number, dst: Uint8Array, srcBytes: number): boolean {
        const outputBytes = width * height * 4;
        const out = Math.ceil((this.base + srcBytes) / 16) * 16;
        const required = out + outputBytes;
        if (width * height < MIN_PIXELS || required > MAX_MEMORY) return false;
        if (required > this.api.memory.buffer.byteLength) {
            const size = Math.min(MAX_MEMORY, Math.max(required, this.api.memory.buffer.byteLength * 2));
            try {
                this.api.memory.grow(Math.ceil((size - this.api.memory.buffer.byteLength) / 65536));
            } catch (error) {
                if (error instanceof RangeError) return false;
                throw error;
            }
        }
        // memory.grow detaches old views; never retain a view across growth.
        if (this.bytes.buffer !== this.api.memory.buffer) this.bytes = new Uint8Array(this.api.memory.buffer);
        this.bytes.set(src.length === srcBytes ? src : src.subarray(0, srcBytes), this.base);
        const status = this.api.decode_dxt(kind, this.base, srcBytes, pitch, width, height, out, outputBytes);
        if (status !== 0) throw new Error(`DXT WASM rejected validated input (${status})`);
        dst.set(this.bytes.subarray(out, out + outputBytes));
        return true;
    }
}

let kernel: DxtKernel | null = null;
let initialization: Promise<boolean> | null = null;
let failure: string | null = null;

/** A failed fetch/compile leaves the reference decoder available (CSP/offline/old browsers). */
export function initializeDxtKernel(bytes?: BufferSource): Promise<boolean> {
    if (initialization) return initialization;
    initialization = (async () => {
        try {
            if (typeof WebAssembly === 'undefined') return false;
            let source = bytes;
            if (!source) {
                const response = await fetch(dxtKernelUrl);
                if (!response.ok) throw new Error(`DXT WASM HTTP ${response.status}`);
                source = await response.arrayBuffer();
            }
            const result = await WebAssembly.instantiate(source);
            kernel = new DxtKernel(result.instance);
            return true;
        } catch (error) {
            failure = String(error);
            return false;
        }
    })();
    return initialization;
}

export function getDxtKernelStatus(): { ready: boolean; failure: string | null } {
    return { ready: kernel !== null, failure };
}

export function tryDecodeDxtKernel(kind: number, src: Uint8Array, pitch: number,
    width: number, height: number, dst: Uint8Array, srcBytes: number): boolean {
    return kernel !== null && kernel.tryDecode(kind, src, pitch, width, height, dst, srcBytes);
}

// Warm up asynchronously in the browser/worker, not in Node/Bun test imports.
if (typeof location !== 'undefined' && (location.protocol === 'https:' || location.protocol === 'http:')) {
    void initializeDxtKernel();
}
