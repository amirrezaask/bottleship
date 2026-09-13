import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { verifyRuntime } from './verify.mjs';

const binary = await readFile(new URL('../../public/v86.wasm', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('./manifest.json', import.meta.url), 'utf8'));
const readInput = path => readFile(new URL(path, import.meta.url));

test('distributed CPU retains memory kernels and matches its source receipt', async () => {
    assert.equal((await verifyRuntime(binary, manifest, readInput)).nativeMemoryKernels, true);
});

test('stale receipt or changed kernel fails distribution validation', async () => {
    await assert.rejects(verifyRuntime(binary, { ...manifest, wasmSha256: '0'.repeat(64) }, readInput), /binary differs/);
    await assert.rejects(verifyRuntime(binary, manifest,
        path => path === 'rep-memory.rs' ? Buffer.from('changed kernel') : readInput(path)), /rep-memory.rs differs/);
});

test('a plain v86 build is rejected even with a matching binary hash', async () => {
    // The vendored core deliberately lacks the distribution's patch stack.
    const direct = await readFile(new URL('../../vendor/v86/build/v86.wasm', import.meta.url));
    await assert.rejects(verifyRuntime(direct, manifest, readInput), /missing get_bulk_memory_abi/);
});
