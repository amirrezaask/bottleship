import { System } from './system';
declare const __GAMEBOX_AOT_ABI__: string;
const LIMIT = 32 * 1024 * 1024;
const digest = async (bytes: Uint8Array) => Array.from(new Uint8Array(
    await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)),
    b => b.toString(16).padStart(2, '0')).join('');
async function bounded(url: URL, limit: number): Promise<Uint8Array<ArrayBuffer>> {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok || !response.body) throw new Error('AOT artifact unavailable');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > limit) throw new Error('AOT artifact exceeds its byte budget');
            chunks.push(value);
        }
    } finally { await reader.cancel(); }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
}
export async function gameboxAot(message: { mode: string; url?: string }) {
    const v86 = System.getInstance().process?.v86 as any;
    const cpu = v86?.cpu || v86?.v86?.cpu;
    const e = cpu?.wm?.exports;
    if (!e?.aot_stat) throw new Error('This runtime has no AOT support');
    if (message.mode === 'capture') { e.aot_capture_start(); return { abi: __GAMEBOX_AOT_ABI__ }; }
    if (message.mode === 'finish') {
        const length = e.aot_capture_finish();
        const bytes = new Uint8Array(e.memory.buffer, e.aot_buffer_ptr(), length).slice();
        return { abi: __GAMEBOX_AOT_ABI__, bytes };
    }
    if (message.mode === 'load') {
        const url = new URL(message.url!);
        if (url.origin !== location.origin || !/^\/assets\/[^/]+\/[^/]+\/aot\.json$/.test(url.pathname) || url.search || url.hash)
            throw new Error('Invalid GameBox AOT manifest URL');
        const manifest = JSON.parse(new TextDecoder().decode(await bounded(url, 4096)));
        if (manifest.format !== 'gamebox-v86-aot-1' || manifest.abi !== __GAMEBOX_AOT_ABI__ ||
            manifest.file !== 'aot.bin' || !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
            !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 8 || manifest.bytes > LIMIT)
            throw new Error('AOT manifest does not match this runtime');
        const bytes = await bounded(new URL(manifest.file, url), manifest.bytes);
        if (bytes.length !== manifest.bytes || await digest(bytes) !== manifest.sha256)
            throw new Error('AOT artifact integrity check failed');
        // Reject unsupported/corrupt modules before the guest starts, rather
        // than leaving an asynchronous JIT installation pending during play.
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const count = view.getUint32(4, true);
        if (view.getUint32(0, true) !== 0x31544f41 || count < 1 || count > 2048)
            throw new Error('Invalid AOT package header');
        let offset = 8;
        for (let i = 0; i < count; i++) {
            const length = view.getUint32(offset, true); offset += 4;
            const end = offset + length;
            if (length < 132 || length > 1024 * 1024 || end > bytes.length)
                throw new Error('Invalid AOT unit size');
            const pages = view.getUint32(offset + 120, true);
            const mappings = view.getUint32(offset + 124, true);
            const entries = view.getUint32(offset + 128, true);
            const reloc = offset + 132 + pages * 4100 + mappings * 8 + entries * 8;
            if (reloc + 4 > end) throw new Error('Invalid AOT unit metadata');
            const start = reloc + 4 + view.getUint32(reloc, true) * 4;
            if (start >= end || !WebAssembly.validate(bytes.subarray(start, end)))
                throw new Error('This browser cannot execute the AOT package');
            offset = end;
        }
        if (offset !== bytes.length) throw new Error('Trailing AOT package data');
        const ptr = e.aot_buffer_alloc(bytes.length);
        if (!ptr) throw new Error('AOT allocation failed');
        new Uint8Array(e.memory.buffer, ptr, bytes.length).set(bytes);
        if (!e.aot_buffer_commit()) throw new Error('Invalid AOT artifact');
    } else if (message.mode !== 'stats') throw new Error('Unknown AOT operation');
    return Object.fromEntries(['hits', 'fallbackCompilations', 'mismatches', 'units', 'bytes', 'capDrops']
        .map((name, i) => [name, e.aot_stat(i)]));
}
