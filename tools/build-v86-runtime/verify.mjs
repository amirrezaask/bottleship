// A direct `make` build omits BottleShip's native memory kernels. Validate the
// distributed CPU against its complete build receipt, not the unpatched core.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const inputs = {
    patchSha256: 'bulk-memory.patch', kernelSha256: 'bulk-memory.rs',
    stringPatchSha256: 'string-memory.patch', stringKernelSha256: 'string-memory.rs',
    repPatchSha256: 'rep-memory.patch', repKernelSha256: 'rep-memory.rs',
    unalignedPatchSha256: 'unaligned-memory.patch', unalignedKernelSha256: 'unaligned-memory.rs',
    jitPolicyPatchSha256: 'jit-policy.patch', buildScriptSha256: 'build.mjs',
    profileCountersPatchSha256: 'profile-counters.patch',
};

export async function verifyRuntime(binary, manifest, readInput) {
    const exports = new Set(WebAssembly.Module.exports(await WebAssembly.compile(binary)).map(item => item.name));
    for (const name of ['get_bulk_memory_abi', 'get_string_memory_abi', 'get_rep_memory_abi',
        'get_unaligned_rep_abi', 'jit_dirty_cache', 'aot_capture_finish', 'fastmem_bump_generation']) {
        assert.ok(exports.has(name), `Distributed v86 is missing ${name}; use bun run build:v86`);
    }
    assert.equal(sha256(binary), manifest.wasmSha256, 'CPU binary differs from its build receipt');
    for (const [field, path] of Object.entries(inputs)) {
        assert.equal(sha256(await readInput(path)), manifest[field], `${path} differs from the CPU build receipt`);
    }
    return { wasmSha256: manifest.wasmSha256, nativeMemoryKernels: true, persistentJitCache: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const directory = resolve(root, 'tools/build-v86-runtime');
    const binary = await readFile(resolve(process.argv[2] ?? resolve(root, 'public/v86.wasm')));
    const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
    console.log(await verifyRuntime(binary, manifest, name => readFile(resolve(directory, name))));
}
