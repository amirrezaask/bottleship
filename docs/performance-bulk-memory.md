# Guarded bulk memory inside the CPU runtime

Stacked on PR #2 (`9501efd8bc208be8e67f72f226bb795255451bc7`). This is a
CPU-runtime change, not another texture sidecar and not a claim of native game FPS.

## Execution path

The existing x86 CALL/OUT/RET ABI is unchanged. Resident `memcpy`, `memset`, and
`memcmp` requests enter optimized Rust code inside v86's own WASM module instead
of repeatedly translating individual bytes/words. Copies/fills use WASM bulk-memory
instructions; comparisons/searches use SIMD128, first-lane detection, and scalar
tails. `msvcrt.memmove`/`memchr` and the existing VC9 aliases gain guarded handlers;
`crtdll.memmove` does too. Unsupported requests retain their original fallbacks.
There is no new worker, WASM sidecar, staging buffer, per-call allocation, or copy
between host and guest memory on a successful fast path.

This does not remove x86 execution, rewrite the JIT, or enable statically linked
CRT calls automatically. Only imports already resolved to these HLE handlers
benefit. Existing Win32/COM and WebGPU/Chrome/Dawn behavior is otherwise unchanged.

## Safety contract

A write validates its entire source/destination spans before changing bytes. Every
page must already have a valid, permitted, identity-mapped TLB entry backed by
ordinary guest RAM. The guard rejects low memory, MMIO/mapped ranges, overflowing
spans, cold entries, denied user access, write-protected pages, compiled-code pages,
and active write watches. It never walks guest page tables, raises speculative
faults, or changes page-table accessed/dirty bits. Normal CPU accesses establish
those effects before a resident fast path can use them. Guard failures leave the
existing scalar CPU or TypeScript handler in charge, including code invalidation.

`memmove` permits overlap; `memcpy` overlap deliberately falls back to preserve
the previous behavior rather than silently changing undefined CRT behavior.
`memcmp` and `memchr` validate one page chunk at a time and stop at the first result,
without probing a later unmapped page. Vector loads never cross the checked chunk.
Comparison returns the exact unsigned-byte difference used by the old handler.

The new handler IDs (82/83) require `get_bulk_memory_abi() === 1` before host binding.
Older cached v86 assets keep their TypeScript fallback. The compiled module exports
`set_bulk_memory_enabled(0)` as a diagnostic rollback switch. Existing memcpy,
memset and memcmp then use their scalar implementations; new handlers fall back.
`get_bulk_memory_stats_ptr()` points to six wrapping u32 counters: copy, fill,
compare, move, find successes and bulk guard misses. Counters count API calls,
not bytes, and are diagnostic evidence, not frame-rate estimates.

## Building and validation

The submodule stays pinned and untouched. `tools/build-v86-runtime/build.mjs`
creates an isolated local checkout, verifies the exact upstream commit, applies
the small owned patch, and builds with pinned Rust 1.90.0 and Clang 18. The normal
`build:v86` script now invokes this helper so rebuilding cannot silently discard
the optimizations. The manifest records source/toolchain and artifact hashes.
Normal application builds use the committed WASM and do not require Rust.

```sh
rustup toolchain install 1.90.0 --profile minimal --target wasm32-unknown-unknown
V86_BASELINE_OUTPUT=performance-results/v86-baseline-rebuilt.wasm bun run build:v86
git diff --exit-code -- public/v86.wasm tools/build-v86-runtime/manifest.json
bun run test:cpu-runtime

V86_REBUILT_BASELINE=performance-results/v86-baseline-rebuilt.wasm \
  node tools/perf/bulk-memory.mjs 9501efd8bc208be8e67f72f226bb795255451bc7 node-bulk.json
V86_REBUILT_BASELINE=performance-results/v86-baseline-rebuilt.wasm \
  node tools/perf/browser-bulk-memory.mjs 9501efd8bc208be8e67f72f226bb795255451bc7 chromium-bulk.json
```

The Dispatch performance workflow verifies a byte-identical rebuild, runs the
project quality gate, full tests, production build, compiled CPU regression suite,
and both benchmark runners. It is read-only; it does not push generated commits.
The new tests execute actual x86 guest calls, including a naturally JIT-compiled
loop, permission/remapping/watch guards, overlap, offsets, vector tails, page
boundaries, early-result behavior, memory growth, CPU flags and register state.
Guard-rejection tests intentionally install a recording-only host fallback so they
can assert there was no partial mutation before falling back; they do not claim
to test every downstream Windows exception path.

Benchmarks compare three cores: PR #2's shipped WASM, the unmodified pinned source
rebuilt with the same compiler/settings, and this patched core. Every timed batch
executes guest calls in an already JIT-warmed loop with resident pages; preparation
and validation are outside timing. Cases include tiny/large buffers, aligned and
unaligned pointers, and equal/first/last-mismatch comparisons. Nine sample batches
alternate execution order. Reports preserve all samples, binary hashes (Chromium),
JIT-finalization counts and host-transition/fast-path counters.

Warm-page component gains are not application-wide gains. Cold/mapped/code memory
can miss the guard; tiny calls and immediate comparisons may regress. Physical GPU,
full-game audio/save/scheduling canaries, and Windows fault-handler integration
still need validation before promoting the draft. No memory permission, floating
point accuracy, guest thread state, or browser security checks were disabled.
