/** Bulk CPU fallbacks only; native GPU uploads never pass through this module. */
const MAX_MEMORY = 64 * 1024 * 1024;
const MIN_PIXELS = 256;
export const dxtKernelUrl = new URL('./dxt-kernel.wasm', import.meta.url);
export const dxtSimdKernelUrl = new URL('./dxt-kernel-simd.wasm', import.meta.url);

interface KernelExports extends WebAssembly.Exports {
    memory: WebAssembly.Memory;
    __heap_base: WebAssembly.Global;
    decode_dxt: (kind: number, src: number, srcLen: number, pitch: number,
        width: number, height: number, dst: number, dstLen: number) => number;
    convert_pixels: (kind: number, src: number, srcLen: number, pitch: number,
        width: number, height: number, dst: number, dstLen: number,
        keyed: number, low: number, high: number) => number;
}

export class DxtKernel {
    private readonly api: KernelExports;
    private readonly base: number;
    private bytes: Uint8Array;
    private output = new Uint8Array(0);
    private outputOffset = -1;

    constructor(instance: WebAssembly.Instance) {
        this.api = instance.exports as KernelExports;
        if (!(this.api.memory instanceof WebAssembly.Memory) ||
            !(this.api.__heap_base instanceof WebAssembly.Global) ||
            typeof this.api.decode_dxt !== 'function' || typeof this.api.convert_pixels !== 'function') {
            throw new Error('Invalid texture WASM ABI');
        }
        this.base = Number(this.api.__heap_base.value);
        this.bytes = new Uint8Array(this.api.memory.buffer);
    }

    private reserve(inputBytes: number, outputBytes: number): number {
        const out = Math.ceil((this.base + inputBytes) / 16) * 16;
        const required = out + outputBytes;
        if (!Number.isSafeInteger(required) || inputBytes < 0 || outputBytes < 0 || required > MAX_MEMORY) return -1;
        if (required > this.api.memory.buffer.byteLength) {
            const size = Math.min(MAX_MEMORY, Math.max(required, this.api.memory.buffer.byteLength * 2));
            try {
                this.api.memory.grow(Math.ceil((size - this.api.memory.buffer.byteLength) / 65536));
            } catch (error) {
                if (error instanceof RangeError) return -1;
                throw error;
            }
        }
        if (this.bytes.buffer !== this.api.memory.buffer) {
            this.bytes = new Uint8Array(this.api.memory.buffer);
            this.outputOffset = -1;
        }
        if (this.outputOffset !== out || this.output.length !== outputBytes) {
            this.output = this.bytes.subarray(out, out + outputBytes);
            this.outputOffset = out;
        }
        return out;
    }

    /** Input is validated by decodeDxtToRgba; Rust independently checks all spans. */
    tryDecode(kind: number, src: Uint8Array, pitch: number, width: number,
        height: number, dst: Uint8Array, srcBytes: number): boolean {
        if (width * height < MIN_PIXELS) return false;
        const outputBytes = width * height * 4;
        const out = this.reserve(srcBytes, outputBytes);
        if (out < 0) return false;
        this.bytes.set(src.length === srcBytes ? src : src.subarray(0, srcBytes), this.base);
        const status = this.api.decode_dxt(kind, this.base, srcBytes, pitch, width, height, out, outputBytes);
        if (status !== 0) throw new Error(`DXT WASM rejected validated input (${status})`);
        dst.set(this.output);
        return true;
    }

    /** Fuse conversion and keying. Declined layouts leave the caller's fallback intact. */
    tryConvert(kind: number, src: Uint8Array, srcOffset: number, pitch: number,
        width: number, height: number, dst: Uint8Array, key?: { low: number; high: number }): boolean {
        const bpp = kind === 1 || kind === 2 || kind === 3 ? 2 : kind === 6 || kind === 7 ? 4 : 0;
        if (!bpp || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
            !Number.isSafeInteger(pitch) || !Number.isSafeInteger(srcOffset) ||
            width <= 0 || height <= 0 || srcOffset < 0 || pitch < width * bpp ||
            width * height < MIN_PIXELS) return false;
        const inputBytes = (height - 1) * pitch + width * bpp;
        const outputBytes = width * height * 4;
        if (!Number.isSafeInteger(inputBytes) || !Number.isSafeInteger(outputBytes) ||
            srcOffset + inputBytes > src.length || outputBytes > dst.length) return false;
        const out = this.reserve(inputBytes, outputBytes);
        if (out < 0) return false;
        this.bytes.set(srcOffset === 0 && src.length === inputBytes ? src : src.subarray(srcOffset, srcOffset + inputBytes), this.base);
        const status = this.api.convert_pixels(kind, this.base, inputBytes, pitch, width, height,
            out, outputBytes, key ? 1 : 0, key?.low ?? 0, key?.high ?? 0);
        if (status !== 0) throw new Error(`Pixel WASM rejected validated input (${status})`);
        dst.set(this.output);
        return true;
    }
}

let kernel: DxtKernel | null = null;
let initialization: Promise<boolean> | null = null;
let failure: string | null = null;
let variant: 'scalar' | 'simd' | 'provided' | null = null;

export function supportsTextureSimd(): boolean {
    // A function containing v128.const and drop; validation never executes code.
    return typeof WebAssembly !== 'undefined' && WebAssembly.validate(new Uint8Array([
        0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,10,23,1,21,0,253,12,
        0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,26,11,
    ]));
}

async function fromUrl(url: URL, request: typeof fetch): Promise<DxtKernel> {
    const response = await request(url);
    if (!response.ok) throw new Error(`Texture WASM HTTP ${response.status}`);
    const result = await WebAssembly.instantiate(await response.arrayBuffer());
    return new DxtKernel(result.instance);
}

/** Injectable at initialization only; never involved in per-surface dispatch. */
export async function loadTextureKernel(request: typeof fetch = fetch, simd = supportsTextureSimd()): Promise<{
    kernel: DxtKernel; variant: 'scalar' | 'simd'; warning: string | null;
}> {
    let warning: string | null = null;
    if (simd) {
        try { return { kernel: await fromUrl(dxtSimdKernelUrl, request), variant: 'simd', warning }; }
        catch (error) { warning = `SIMD unavailable: ${String(error)}`; }
    }
    return { kernel: await fromUrl(dxtKernelUrl, request), variant: 'scalar', warning };
}

/** SIMD failures retry scalar WASM; failures of both leave the TS fallback available. */
export function initializeDxtKernel(bytes?: BufferSource): Promise<boolean> {
    if (initialization) return initialization;
    initialization = (async () => {
        try {
            if (typeof WebAssembly === 'undefined') return false;
            if (bytes) {
                const result = await WebAssembly.instantiate(bytes);
                kernel = new DxtKernel(result.instance);
                variant = 'provided';
            } else {
                const loaded = await loadTextureKernel();
                kernel = loaded.kernel;
                variant = loaded.variant;
                failure = loaded.warning;
            }
            return true;
        } catch (error) {
            failure = String(error);
            return false;
        }
    })();
    return initialization;
}

export function getDxtKernelStatus(): { ready: boolean; failure: string | null; variant: typeof variant } {
    return { ready: kernel !== null, failure, variant };
}

export function tryDecodeDxtKernel(kind: number, src: Uint8Array, pitch: number,
    width: number, height: number, dst: Uint8Array, srcBytes: number): boolean {
    return kernel !== null && kernel.tryDecode(kind, src, pitch, width, height, dst, srcBytes);
}

export function tryConvertPixelKernel(kind: number, src: Uint8Array, srcOffset: number, pitch: number,
    width: number, height: number, dst: Uint8Array, key?: { low: number; high: number }): boolean {
    return kernel !== null && kernel.tryConvert(kind, src, srcOffset, pitch, width, height, dst, key);
}

if (typeof location !== 'undefined' && (location.protocol === 'https:' || location.protocol === 'http:')) {
    void initializeDxtKernel();
}
