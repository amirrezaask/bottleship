# Browser runtime fast paths

This patch is a measured, bounded optimization of the existing runtime, not a claim
that BottleShip is the fastest Win32 implementation or that the Win32/COM layer has
been rewritten in Rust. The CPU remains the existing Rust/WASM v86 fork.

## Graphics backend boundary

The production route remains DirectDraw/Direct3D -> WebGPU -> Chrome/Dawn -> the
platform driver. Dawn implements Metal, D3D12, Vulkan and OpenGL backends. Native
backend selection and availability belong to Chrome, the OS and driver; a web page
cannot directly call these native APIs or force a backend by selecting its OS.
Metal on macOS, D3D12 on Windows and Vulkan on supported Linux configurations are
the intended native routes, not a browser-level guarantee. No extra renderer,
per-draw RPC layer, validation bypass or native companion was introduced.

References: [Dawn](https://dawn.googlesource.com/dawn/+/refs/heads/main/README.md),
[Chrome WebGPU troubleshooting](https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips).
Use chrome://gpu to confirm hardware acceleration on the actual target system.

## Implemented changes

### Bulk DXT software fallback in Rust/WASM

Hardware BC compressed uploads remain preferred and do not call this decoder. When
software decoding is required, DXT1/2/3/4/5 images of at least 256 pixels use the
Rust kernel after asynchronous initialization. Smaller images, unavailable WASM,
fetch/compile failures and requests exceeding the 64 MiB arena retain the original
TypeScript reference implementation. The reference file is byte-identical to the
original decoder, making differential tests and fallback behavior inspectable.

The checked Rust ABI has no host imports or dynamic allocations. A call handles
an entire surface, including padded block rows and cropped edge blocks. Input spans,
output spans, integer overflow, arena boundaries and overlap are checked before
writing. Guest emulator RAM is never directly dereferenced by this sidecar module.
The byte-buffer wrapper also validates geometry, supports unaligned output views,
and refreshes its own views after real WebAssembly memory growth.

This is **not zero-copy**: there is one compressed-input copy and one decoded-output
copy. Reusable staging storage avoids allocating image-sized buffers per call; both
copies and public-boundary validation are included in the benchmarks. Tiny 4x4
fallback calls can cost more than the unchecked original because of validation.
The 3,283-byte compiled module is committed, so normal development/production builds
do not need Rust. It is portable scalar WASM; this patch does not claim SIMD gains.

### Sampler-cache hits without transient descriptors or string keys

DDraw/D3D7, D3D8 and D3D9 share the sampler cache. Hits reuse a scratch descriptor and
a collision-free 14-bit encoding of normalized filters, address modes, anisotropy and
base-level pinning. LOD values are separate numeric keys, never truncated to integers.
Descriptor copies and GPU sampler creation occur only on misses. Quality changes,
point-sampled textures, mip disabling, anisotropy requirements and cache clearing
retain their semantics. Non-number anisotropy NaN normalizes to 1 rather than creating
an invalid sampler/key.

### Guest-memory correctness

The normalization cache now distinguishes views by buffer, byte offset and length,
so two proxied subviews cannot alias the wrong span. The diagnostic stale-view proxy
uses the underlying typed array as the receiver for branded accessors. Tests cover
real WASM growth, stale reads/writes, subviews and working typed-array accessors.

## Reproduce validation and benchmarks

```sh
bun install --frozen-lockfile
bun tools/generate-index.ts
bun tools/validate-signatures.ts
bun tools/validate-struct-offsets.ts
bun run typecheck
bun test
bun run build

# Rebuild only after editing the Rust kernel; output must match the committed asset.
rustup toolchain install 1.85.0 --profile minimal --target wasm32-unknown-unknown
node tools/build-dxt-kernel/build.mjs
git diff --exit-code -- src/worker/backends/webgpu/shared/dxt-kernel.wasm

# Original main is the fixed baseline; pass another ref explicitly for future comparisons.
bun tools/perf/runtime-fastpaths.ts a7c8543d75569d48890d48744897a0ffe3fb02f7 bun-results.json
node tools/perf/browser-fastpaths.mjs a7c8543d75569d48890d48744897a0ffe3fb02f7 chromium-results.json
```

The browser runner needs installed Chromium/Chrome (or CHROME_BIN). It serves only
localhost, uses a temporary browser profile, disables GPU for this CPU-only test and
uses real performance.now time, not Chrome's virtual-time mode. It is not the game
harness and must not be used as evidence of real rendering or native-driver speed.

The new Runtime performance workflow runs the canonical checks, full test suite,
production build, deterministic Rust rebuild and both benchmark runners. Reports
include the exact baseline/candidate commits, runtime/browser version, CPU and raw
samples. The baseline modules are read from Git, not rewritten approximations.
Measurements alternate order across nine samples after warm-up. Timing results are
artifacts, not brittle hosted-runner pass/fail thresholds; correctness and build
reproducibility are gates. Bash pipefail preserves test failures through tee.

The added tests exercise 1,440 deterministic DXT cases across all five formats,
38,880 sampler/quality combinations, raw-ABI malformed spans, memory growth and guest
memory regressions. Full-game startup, frame times, audio, saves and actual Metal,
Vulkan and D3D12 hardware still need canary runs through the existing harness.

## Remaining work before broader performance claims

Profile complete representative game scenes before moving more APIs. In particular,
the existing D3D9 WASM arena and optional numeric pipeline lookup are not enabled
blindly: state coverage, cache-key equivalence and invalidation require differential
rendering tests. Integrating kernels with the existing v86 memory can remove staging
copies, but requires ownership/lease and growth-safe ABI work in its separate fork.
Do not trade memory protections, correct flags/x87/thread state, or device-loss
handling for favorable microbenchmark numbers.
