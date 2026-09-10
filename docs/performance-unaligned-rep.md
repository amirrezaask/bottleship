# Unaligned REP execution (stacked on PR #5)

This extends the integrated instruction path to unaligned word/dword CMPS, SCAS
and STOS. It does not replace the JIT or translate arbitrary loops ahead of time.
A game benefits when it executes these REP opcodes with eligible operands, whether
the code is imported, inlined, or statically linked. No native-Windows/FPS claim
follows from a faster synthetic memory workload.

## Runtime path

The generic CPU instruction dispatcher selects the new helper only for unaligned
32-bit-address REP operations. PR #5's SIMD compare and patterned-fill routines
are reused in the same v86 instance, on the existing guest RAM. There are no staging
copies, new workers, API thunks, or per-call allocations. The helper is out-of-line
to avoid duplicating its control flow in each specialized CPU entry point.

Unaligned WASM loads are legal, but a host vector load is not a substitute for guest
access validation. Normal CPU translation resolves virtual pages, permissions,
accessed/dirty bits and physical mappings first. Source translation precedes
destination translation for CMPS, matching the old unaligned scalar path. Mapped
device memory retains scalar callbacks; it is never inspected with raw vector loads.
The existing code-dirty mechanism runs before stores into translated-code pages.

Each vector chunk ends before either operand's current page boundary. Even a
backward word/dword accesses bytes above its start address: the entire element
must fit. A straddling element uses the original safe_read/safe_write accessors,
then returns to the instruction restart point. This handles discontiguous physical
pages, faults and two-page writes without losing completed count/pointer progress.
Small fragments at page ends also take precise scalar bridge steps. Remaining
requests under 64 bytes use the original path to avoid bulk-dispatch overhead.

Compared with the old unaligned per-element loop, large eligible operations now
return at page-sized progress boundaries (or a single scalar bridge), instead of
processing the entire remaining count in one helper invocation. This improves the
CPU's opportunities to observe its existing execution budget. Tests assert the
bounded progress; they are not end-to-end audio/input-latency measurements.

The final compare flags are computed by the existing cmp16/cmp32 helpers only when
the REP ends, matching the parent's restart semantics. A fault before a scalar
bridge completes does not advance ECX/ESI/EDI. Neither the bridge nor SIMD modifies
guest XMM registers. Active write watches retain their ordinary store callbacks.
16-bit address wrapping, non-REP instructions, and MOVS remain on their old paths.

## Controls and compatibility

Exports: `get_unaligned_rep_abi() === 1`, `set_unaligned_rep_enabled(0|1)`, and
`get_unaligned_rep_stats_ptr()`. Eight wrapping u32 counters record CMPSW, CMPSD,
SCASW, SCASD, STOSW, STOSD, scalar bridge elements, and rejected chunks. They are
not FPS statistics. Turning off PR #5's REP switch also disables the new helper;
turning off only the new switch leaves aligned PR #5 intrinsics available. Old
cached cores need no new host registration; they simply lack this optimization.

The pinned v86 submodule stays unmodified. An owned patch is applied after all
parent patches in an isolated build. Normal application builds use the committed
core without Rust; `build:v86` preserves the whole patch stack. A manifest hashes
patches, source kernels, the build helper, and the output core.

## Correctness and measurement

New compiled-CPU tests execute actual REP opcodes with independent source/destination
alignment residues and nonuniform data. Coverage includes both directions, REPE/
REPNE modes, early/late stop lanes, page fragments, remapping, actual page faults and
resume, source-before-destination double-fault ordering, no partial straddling
stores, CPL3/protection faults, MMIO callbacks, write watches, FS offsets, 16-bit
wrap, huge-count bounded progress, WASM growth, preserved registers/SIMD, JIT-warmed
rollback, and compiled-code overwrite/invalidation. The native x86-64 oracle also
runs offsets 0/1/2/3; it checks data/count/flags, not guest page tables or Windows SEH.

The new workflow checks out the exact candidate head, verifies a reproducible build,
and requires an identically compiled PR #5 control to match its shipped WASM byte
for byte. Node and Chromium benchmarks compare actual guest instructions using
resident pages and calibrated real-clock batches. Public guest-loop overhead,
normal translation and scalar bridges are included; setup and page priming are
excluded. Event-loop yields allow asynchronous tiering between sample batches.
There are 224 cases per engine: both directions, zero/tiny/large counts, independent
alignments, near-page-end starts, early/late/full results, aligned controls and
unchanged MOVSB/STOSB controls. New-path counters must advance for designated cases;
observed JIT finalization and zero API-host-fallback counts are asserted. All raw
samples and regressions remain in reports; timings on shared runners are not a
brittle CI pass/fail gate or a speed ratio relative to native Windows.

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
mkdir -p performance-results
V86_UNALIGNED_BASELINE_OUTPUT=performance-results/v86-pr5-rebuilt.wasm node tools/build-v86-runtime/build.mjs
git diff --exit-code -- public/v86.wasm tools/build-v86-runtime/manifest.json vendor/v86

gcc -O2 -Wall -Wextra -Werror tools/runtime-test/rep-native-oracle.c -o performance-results/rep-native-oracle
V86_ORACLE_OFFSETS=0,1,2,3 node tools/perf/verify-rep-native.mjs ./performance-results/rep-native-oracle
node tools/perf/unaligned-memory.mjs 822b0f214bb36e9757784be0f524557d59a4fe94 node-unaligned.json
node tools/perf/browser-unaligned-memory.mjs 822b0f214bb36e9757784be0f524557d59a4fe94 chromium-unaligned.json
```

Full-game startup, frame times, input/audio/save/scheduling, Windows exception-path
integration and physical-GPU canaries are still required before release. No page
protections or precision settings are disabled. WebGPU/Chrome/Dawn is unchanged.

Reference for the raw vector-load alignment contract:
https://doc.rust-lang.org/core/arch/wasm32/fn.v128_load.html
