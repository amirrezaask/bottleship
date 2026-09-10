# In-core string fast paths (stacked on PR #3)

Parent: `dd9914a7f4cf90bb2bc833d34733d2d0ce0ec9e8`. This extends the same v86
Rust/WASM module and guest memory as the bulk-memory patch. It does not add a
second kernel instance, staging copies, a worker, or per-call host dispatch.

## Execution changes

Eight existing WASM handlers gain page-guarded SIMD scan/compare paths: strlen,
wcslen, strcmp, _stricmp, _wcsicmp, wcschr, strcpy and wcscpy. Their previous cost
was repeated emulated byte/word reads and writes, not TypeScript execution.
SIMD scans use 16 byte lanes or eight UTF-16 code-unit lanes. Comparisons select
the first differing unsigned byte/code unit and stop at the first terminator.
Case-insensitive comparisons deliberately retain the parent's ASCII-only folding;
this is not a new Unicode/locale implementation.

strcpy/wcscpy first find the terminator, validate both complete spans, then perform
a bulk copy including the terminator. Undefined overlapping inputs keep the
existing sequential fallback. The fast branch never partially writes before a
guard rejection; the original scalar fallback retains its own fault/write behavior.

strchr and strrchr additionally gain in-core handlers 84/85, enabled only when
`get_string_memory_abi() === 1`. Older cached CPU binaries retain their JS fallback.
The msvcrt/crtdll and existing msvcr90 aliases share these bindings. Invalid named
or raw function IDs, raw handler IDs and unregister IDs are rejected before table
or mirror mutation, preventing fractional/NaN input from targeting another slot.

## Guard and compatibility boundary

All pointer probes reuse PR #3's resident-span guard: ordinary identity-mapped guest
RAM, present and permitted TLB entries, no MMIO/remapping/overflow, and no prohibited
writes. The probes neither populate cold entries nor set accessed/dirty bits or
raise speculative faults. Searches validate each page chunk separately, so an
answer in one page does not require the following page to be mapped. An odd-addressed
UTF-16 code unit straddling a page boundary is checked as exactly two bytes.

SIMD may inspect bytes after NUL within the already-validated ordinary RAM chunk;
those lanes cannot affect the result. It never vector-loads across an unchecked
page. Copies reject protected, watched and JIT-code destinations, leaving existing
writers and their code invalidation in control. The historical scan cap remains.

`get_string_memory_stats_ptr()` exposes 11 u32 counters, in this order: strlen,
wcslen, strcmp, stricmp, wcsicmp, strchr, strrchr, wcschr, strcpy, wcscpy, guard
misses. Re-fetch its view after memory growth. `set_string_memory_enabled(0)` is
an independent diagnostic rollback; PR #3's bulk-memory switch also disables the
shared guard. Counters are per operation and are not game-FPS measurements.

## Verification and reproduction

```sh
bun install --frozen-lockfile
bun tools/generate-index.ts
bun tools/validate-signatures.ts
bun tools/validate-struct-offsets.ts
bun run typecheck
bun test
node --test tools/runtime-test/*.test.mjs
bun run build

rustup toolchain install 1.90.0 --profile minimal --target wasm32-unknown-unknown
V86_STRING_BASELINE_OUTPUT=performance-results/v86-pr3-rebuilt.wasm node tools/build-v86-runtime/build.mjs
git diff --exit-code -- public/v86.wasm tools/build-v86-runtime/manifest.json vendor/v86
V86_REBUILT_BASELINE=performance-results/v86-pr3-rebuilt.wasm node tools/perf/string-memory.mjs dd9914a7f4cf90bb2bc833d34733d2d0ce0ec9e8 node-strings.json
V86_REBUILT_BASELINE=performance-results/v86-pr3-rebuilt.wasm node tools/perf/browser-string-memory.mjs dd9914a7f4cf90bb2bc833d34733d2d0ce0ec9e8 chromium-strings.json
```

The build requires Clang 18 and pinned Rust; normal app builds use the committed
WASM. The parent control includes the bulk-memory patch but not the string patch,
and uses identical settings. CI checks that it is byte-identical to PR #3's actual
shipped binary, and verifies the candidate binary/manifest reproducibly. The v86
submodule itself stays pinned and unmodified. CI has read-only permissions.

The shared guest fixture executes real x86 CALL/OUT/RET loops with observed JIT
finalizations and zero API-host-fallback counts. Both engines report all 192 cases:
eight existing operations, empty through 65,536-unit strings, aligned and odd
pointers, and equal/early/late/absent results. Nine alternating-order batches follow
warm-up. Guards, guest calls and work are timed; setup, page priming and correctness
checks are not. Return values and copied bytes/canaries are validated. New narrow
search handlers are correctness-tested rather than assigned a misleading ratio
against an artificial JS fallback. Tiny/early calls can regress; consult all rows.

Regression tests cover scalar-vs-SIMD results, all nonzero UTF-16 values, NUL lane
positions, unsigned differences, odd pitches/addresses, real memory growth, code
invalidation, flags/SSE/nonvolatile state, cold/remapped/denied pages, historical
caps and capability-gated host registration. Some new-handler rejection tests use
a recording-only host fallback and do not model complete Windows exception handling.

These are warm-resident CPU microbenchmarks, not FPS gains or a comparison against
native Windows. Statically linked/inlined CRT instructions are not automatically
replaced. There is no JIT rewrite, AOT compilation or new graphics backend here.
Real-game startup/frame-time/audio/save/scheduling and physical GPU canaries remain
required before removing draft status. The WebGPU/Chrome/Dawn path is unchanged.
