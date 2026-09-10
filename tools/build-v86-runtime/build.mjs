/** Build the pinned v86 core in an isolated checkout; never modify the submodule. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = join(root, 'vendor/v86');
const pinned = '97704021d3b9f75ef5b1504e9f1f1e7fe95094d4';
const rust = '1.90.0';
const sha256 = p => createHash('sha256').update(readFileSync(p)).digest('hex');
const at = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (at !== pinned) throw new Error(`Expected v86 ${pinned}, got ${at}; review and rebase the patch first`);
const work = mkdtempSync(join(tmpdir(), 'bottleship-v86-'));
const env = { ...process.env, RUSTUP_TOOLCHAIN: rust, CARGO_TARGET_DIR: join(work, 'build') };
const run = (bin, args) => execFileSync(bin, args, { cwd: work, env, stdio: 'inherit' });
const output = resolve(root, process.env.V86_OUTPUT || 'public/v86.wasm');
const baseline = process.env.V86_BASELINE_OUTPUT && resolve(root, process.env.V86_BASELINE_OUTPUT);
const patch = join(root, 'tools/build-v86-runtime/bulk-memory.patch');
const kernel = join(root, 'tools/build-v86-runtime/bulk-memory.rs');
const stringPatch = join(root, 'tools/build-v86-runtime/string-memory.patch');
const stringKernel = join(root, 'tools/build-v86-runtime/string-memory.rs');
const stringBaseline = process.env.V86_STRING_BASELINE_OUTPUT && resolve(root, process.env.V86_STRING_BASELINE_OUTPUT);
const repPatch = join(root, 'tools/build-v86-runtime/rep-memory.patch');
const repKernel = join(root, 'tools/build-v86-runtime/rep-memory.rs');
const repBaseline = process.env.V86_REP_BASELINE_OUTPUT && resolve(root, process.env.V86_REP_BASELINE_OUTPUT);
try {
    execFileSync('git', ['clone', '--shared', '--no-checkout', source, work], { stdio: 'inherit' });
    run('git', ['checkout', '--detach', pinned]);
    mkdirSync(join(work, 'build'), { recursive: true });
    for (const table of ['jit', 'jit0f', 'interpreter', 'interpreter0f', 'analyzer', 'analyzer0f']) {
        const generator = table.startsWith('jit') ? 'jit' : table.startsWith('interpreter') ? 'interpreter' : 'analyzer';
        run(process.execPath, [`gen/generate_${generator}.js`, '--output-dir', 'build/', '--table', table]);
    }
    run(process.env.CLANG || 'clang-18', ['-c', '--target=wasm32', '-O3', '-flto', '-nostdlib',
        '-fvisibility=hidden', '-ffunction-sections', '-fdata-sections', '-DZSTDLIB_VISIBILITY=',
        '-o', 'build/zstddeclib.o', 'lib/zstd/zstddeclib.c']);
    const compile = target => {
        run('cargo', [`+${rust}`, 'rustc', '--offline', '--release', '--target', 'wasm32-unknown-unknown', '--',
            '-C', 'linker=tools/rust-lld-wrapper',
            '-C', 'link-args=--import-table --global-base=4096 --v86-strip-debug',
            '-C', 'link-args=build/zstddeclib.o',
            '-C', 'target-feature=+bulk-memory,+multivalue,+simd128',
            '--remap-path-prefix', `${work}=v86`]);
        mkdirSync(resolve(target, '..'), { recursive: true });
        copyFileSync(join(work, 'build/wasm32-unknown-unknown/release/v86.wasm'), target);
        chmodSync(target, 0o644);
        run(process.execPath, ['tools/check-wasm-exports.mjs', target]);
    };
    if (baseline) compile(baseline);
    run('git', ['apply', '--check', patch]);
    run('git', ['apply', patch]);
    copyFileSync(kernel, join(work, 'src/rust/cpu/bulk_memory.rs'));
    if (stringBaseline) compile(stringBaseline);
    run('git', ['apply', '--check', stringPatch]);
    run('git', ['apply', stringPatch]);
    copyFileSync(stringKernel, join(work, 'src/rust/cpu/string_memory.rs'));
    if (repBaseline) compile(repBaseline);
    run('git', ['apply', '--check', repPatch]);
    run('git', ['apply', repPatch]);
    copyFileSync(repKernel, join(work, 'src/rust/cpu/rep_memory.rs'));
    compile(output);
    const module = new WebAssembly.Module(readFileSync(output));
    for (const name of ['get_bulk_memory_abi', 'get_bulk_memory_stats_ptr', 'set_bulk_memory_enabled',
        'get_rep_memory_abi', 'get_rep_memory_stats_ptr', 'set_rep_memory_enabled',
        'get_string_memory_abi', 'get_string_memory_stats_ptr', 'set_string_memory_enabled']) {
        if (!WebAssembly.Module.exports(module).some(e => e.name === name)) throw new Error(`Missing export ${name}`);
    }
    const manifest = { v86Commit: pinned, rust, target: 'wasm32-unknown-unknown',
        features: ['bulk-memory', 'multivalue', 'simd128'], patchSha256: sha256(patch),
        kernelSha256: sha256(kernel), stringPatchSha256: sha256(stringPatch),
        stringKernelSha256: sha256(stringKernel), repPatchSha256: sha256(repPatch),
        repKernelSha256: sha256(repKernel), buildScriptSha256: sha256(fileURLToPath(import.meta.url)), wasmSha256: sha256(output) };
    writeFileSync(join(root, 'tools/build-v86-runtime/manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    console.log(JSON.stringify(manifest, null, 2));
} finally { rmSync(work, { recursive: true, force: true }); }
