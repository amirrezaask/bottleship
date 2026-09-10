# Integrated REP instruction intrinsics (stacked on PR #4)

This patch accelerates actual guest x86 instructions, not additional CRT import
names. An inlined or statically linked routine benefits when it executes these
opcodes; other hand-written, compiler-generated or vectorized loops are unchanged.
This is not an AOT compiler, a rewritten JIT, or proof of native Windows performance.

## Production path

`REP(E/NE) CMPSB/W/D` and `SCASB/W/D` compare/search 16 bytes per SIMD iteration
inside the existing v86 WASM instance. Forward and backward directions select the
first terminating element in execution order. The final subtraction is performed
by v86's existing `cmp8/16/32`, preserving CF/PF/AF/ZF/SF/OF and the existing REP
restart behavior. Initial ZF does not skip the first iteration; a zero count does.

`REP STOSW/D` writes repeated words/dwords through vector stores. Repeated-byte
patterns (including zero) use bulk `memory.fill`. These operate on the guest's
existing physical RAM with no staging copy, extra instance, worker, host thunk or
per-invocation allocation. `REP MOVS` and byte `STOS` already used bulk operations;
they were not rewritten and are included as benchmark controls.

The large helpers are marked `inline(never)` to limit their effect on the surrounding
specialized instruction functions. This is a measured code-generation tradeoff,
not a claim that inlining is always bad: an internal WASM call per eligible page
chunk is preferable to inflating the caller and slowing its scalar fallbacks.
Recheck the full workload, including unaligned paths, before changing this boundary.

The intrinsic runs only inside the existing translated-page fast path. Normal CPU
translation still enforces access permissions and updates accessed/dirty bits.
Unlike the earlier HLE resident-identity guards, remapped ordinary RAM is supported
because the inputs here are already-validated physical addresses. The helper
rechecks ordinary RAM bounds and a single physical-page span before raw SIMD loads.
No vector load crosses an unchecked page; later lanes in an already-checked RAM
chunk may be read speculatively but cannot override the first terminating result.

Each invocation retains the existing page-sized limit and instruction-pointer
restart. A large REP operation is not turned into one uninterruptible bulk job.
Faults, partial ECX/ESI/EDI progress, segment handling and the opportunity to return
to the scheduler remain in the existing instruction engine. The tests exercise
these CPU boundaries, not the full application scheduler or Windows SEH layer.

## Conservative fallbacks and observability

Existing 16-bit-address and unaligned word/dword fallbacks remain. Small comparisons
(less than one vector) and fills (less than 64 bytes) use the original loop. Mapped
I/O is excluded by the original translation path and the helper's RAM checks.
Active write watches retain per-element stores. Compiled-code writes run the
existing JIT invalidation before an intrinsic can write the page. No correctness,
protection, precise arithmetic, x87 or browser security option was disabled.

Exports: `get_rep_memory_abi() === 1`, `set_rep_memory_enabled(0|1)`, and
`get_rep_memory_stats_ptr()`. The five wrapping u32 counters are CMPS chunks, SCAS
chunks, STOSW chunks, STOSD chunks, and rejected eligible chunks. These are page
chunks, not function-call counts or FPS. Disabling REP intrinsics is independent
of the preceding HLE bulk/string switches. Older cached cores simply lack this
instruction optimization; no new host registration is required.

## Verification

Eleven new compiled-CPU tests cover prefix modes, direction, counts, independent
subtraction-flag calculations, unaligned/odd addresses, lane tails, 16-bit wrap,
segment offsets, remapped pages, write watches and memory growth. They also check:

- A real #PF gate receives the correct address/error/IP after partial stores;
  mapping the page and restoring the fault frame resumes from the remaining count.
- CPL3 supervisor-page reads and write-protected stores actually fault, rather
  than merely invoking a recording-only API fallback.
- Single-page progress leaves the next page's PTE untouched and early search
  termination never reads the next unmapped page in either direction.
- A JIT-warmed REP caller observes the rollback switch. REP STOS overwrites a
  compiled probe, and its next execution observes the new instructions.

A separate GCC-built native x86-64 oracle checks 12,672 cases against real host REP
instructions: element counts, pointer deltas, arithmetic/DF flags and output hashes.
This independently checks data semantics, not guest paging, 16-bit address wrap,
Windows behavior, or speed relative to a native application. Its buffers include
padding so backward final pointers remain inside their C allocations.

## Reproduce

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
V86_REP_BASELINE_OUTPUT=performance-results/v86-pr4-rebuilt.wasm node tools/build-v86-runtime/build.mjs
git diff --exit-code -- public/v86.wasm tools/build-v86-runtime/manifest.json vendor/v86

# Native x86-64 Linux correctness oracle (not a performance comparison).
gcc -O2 -Wall -Wextra -Werror tools/runtime-test/rep-native-oracle.c -o /tmp/rep-native-oracle
node tools/perf/verify-rep-native.mjs /tmp/rep-native-oracle

node tools/perf/rep-memory.mjs fb04401f30b1267548b05cb2574ace7b9d47f4dc node-rep.json
node tools/perf/browser-rep-memory.mjs fb04401f30b1267548b05cb2574ace7b9d47f4dc chromium-rep.json
```

## Benchmark and release limits

The REP performance workflow uses PR #4's actual shipped binary and a same-toolchain
parent rebuild, required to be byte-identical. It verifies the patched binary and
source manifest, runs the full suite and native oracle, and records 212 cases per
engine: zero/small/large counts, forward/backward traversal, first/last/full outcomes,
aligned/unaligned buffers, and unchanged MOVSB/STOSB controls. Cases run actual
JIT-warmed REP opcodes, not mocked CRT handlers. Return progress and writes/canaries
are checked outside timing; observed JIT finalization and zero API host calls are
asserted. Intrinsic counters must advance for eligible workloads.

Timed batches include guest register loading, CALL/RET, the instruction and normal
page translations. Setup, page priming, calibration and verification are excluded.
Each binary's count is calibrated toward >=3 ms and nine alternating-order samples
are recorded with raw batch durations. Timing on shared runners is reported rather
than used as a brittle pass/fail threshold. Tiny/early-result cases and unchanged
fallbacks or controls may regress; all results are retained. Do not multiply these
ratios by earlier HLE/texture improvements or interpret them as game FPS.

The pinned v86 submodule is unchanged. The build helper applies this repository's
patch in isolation, retains previous optimizations and records all input/output
hashes. Normal app builds use the committed binary and need no Rust installation.
Full-game startup, audio/save/scheduling and hardware GPU canaries remain required
before release; graphics routing is unchanged. Keep this stacked change draft
until integration validation is complete.
