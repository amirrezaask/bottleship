# Fused texture-conversion fast paths (stacked on PR #1)

The comparison base for this patch is `d99c61599bbe5adcb2031cdc88cef7a35c964d2f`
(PR #1), not the original upstream main. This is a CPU-side graphics improvement;
the v86 CPU, Windows API implementation, WebGPU command path and native backend
selection are not replaced.

## Changes

The existing texture WASM module now handles RGB565, RGB555, ARGB1555, ARGB8888
and XRGB8888 surface conversion. It combines conversion and color-key transparency
in one specialized pass, rather than separate TypeScript loops. Unkeyed RGB565
keeps the faster TypeScript lookup-table path: CPU benchmarks showed staging overhead
can outweigh SIMD there. The checked Rust implementation remains tested, but public
routing does not force it. Scalar and SIMD
builds use the same checked ABI. SIMD processes four pixels per iteration, with
unaligned-safe loads, exact row-boundary reads and scalar tails. Rounded 5/6-bit
channel expansion, alpha and the existing zero-pixel color-key policy are preserved.
The latter is compatibility behavior, not a newly endorsed DirectDraw specification.

One reusable, bounded memory arena serves both DXT and surface conversion. Its output
view is cached by layout and refreshed after memory growth. There are still two
staging copies: input into WASM and RGBA output back. All benchmark results include
both copies, wrapper checks and real public API dispatch. This is not zero-copy.

The loader detects SIMD with WebAssembly validation. It requests one variant when
successful, retries scalar WASM on SIMD fetch/compile/ABI failure, and preserves the
TypeScript fallback when neither loads. Both assets are committed, so application
builds do not require Rust. Scalar is 6,005 bytes; SIMD is 15,661 bytes, before HTTP
compression. Both have no host imports. The arena remains capped at 64 MiB; unsupported
formats, small images and unsuitable layouts remain on the compatibility path.

`gpu-texture-reference.ts` is the exact former `gpu-texture-utils.ts` from the parent
PR, unchanged. The short wrapper re-exports the existing API and fixes previously
unsafe unaligned byte views, odd pitches and aliased source/output on the fallback
path. Exceptional layouts are packed only when needed. It checks invalid dimensions
before writing; zero-size requests are no-ops. Hardware-native texture uploads and
existing upload/lease guards are not routed through extra layers.

## Verification

The differential suite tests both compiled variants against the unchanged reference.
It covers every 16-bit value in all three 16-bit formats with five color-key settings,
32-bit formats, odd pitches/offsets, vector tails, malformed raw ABI calls, protected
spans, output canaries, actual memory growth and alternating DXT/pixel calls. Loader
tests cover missing SIMD, failed fetch, malformed module, wrong ABI and scalar retry.

The Pixel performance workflow runs the complete project tests and production build,
not only an isolated kernel suite. It rebuilds both WASM variants with pinned Rust
1.85.0 and fails if either differs from the committed asset. No writable CI token is
required by the permanent workflow.

```sh
bun install --frozen-lockfile
bun tools/generate-index.ts
bun tools/validate-signatures.ts
bun tools/validate-struct-offsets.ts
bun run typecheck
bun test
bun run build

rustup toolchain install 1.85.0 --profile minimal --target wasm32-unknown-unknown
node tools/build-dxt-kernel/build.mjs
git diff --exit-code -- src/worker/backends/webgpu/shared/dxt-kernel*.wasm

bun tools/perf/pixel-fastpaths.ts d99c61599bbe5adcb2031cdc88cef7a35c964d2f bun-pixels.json
node tools/perf/browser-fastpaths.mjs d99c61599bbe5adcb2031cdc88cef7a35c964d2f chromium-pixels.json --pixels
```

The browser runner needs Chrome/Chromium or `CHROME_BIN`. Its CPU-only pixel mode
stubs the unused System singleton, identically for baseline and candidate, and throws
if the converter calls it. Full project CI does not stub services. Neither benchmark
loads a Windows game or measures native GPU performance. The reports record commits,
browser/runtime, CPU, selected kernel and nine alternating-order samples after warm-up.
Each case verifies output equality before and after timing. The workload includes
tiny 4x4 calls as well as large surfaces; do not hide wrapper overhead on tiny cases
or extrapolate bulk-conversion speedups to game FPS.

Real-game frame times, audio, save/load and physical Metal/Vulkan/D3D12 canaries remain
necessary before release. No guest-memory protection, x87 precision, exception or
thread-scheduling invariant is relaxed. Rust SIMD background:
https://doc.rust-lang.org/core/arch/wasm32/index.html
