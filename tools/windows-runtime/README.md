# Windows runtime performance and compatibility evidence

## Scope and baseline

Baseline: `3c194209799afea7cbaecb0eb1e8170a5cafb735` (the runtime pinned by GameBox at the start of this change). No game preprocessing, offline binary translation, cache generation, or graphics-quality reduction is added.

This patch reduces float-view and D3DX temporary allocations, fixes the left-handed camera convention, adds twelve real math implementations, corrects ten stdcall descriptors, repairs the 28-byte image-info write, preserves source image file type/mip count, and suppresses duplicate loading-phase DOM events. Existing memory permissions, fresh-memory acquisition, archive/cache behavior and save flushing remain in place.

New math exports: MatrixMultiplyTranspose, MatrixTranspose, MatrixScaling, MatrixRotationX/Z, MatrixPerspectiveFovRH, MatrixOrthoLH/RH, MatrixLookAtRH, MatrixInverse, Vec3TransformNormal and Vec3Transform (all prefixed D3DX).

This is not complete Windows/D3DX support. Correct font argument counts do not implement font rendering. Existing effect/sprite gaps, texture resize/format/color-key overrides and full DDS cube/volume/source-format metadata remain outside this change. The image decoder still exposes RGBA8 2D data.

## Run the independent evidence

Use Node 22.16.0 and a checkout with the baseline commit available:

```sh
node --experimental-vm-modules --test tools/windows-runtime/conformance.mjs tools/windows-runtime/bridge.mjs
node --experimental-vm-modules tools/windows-runtime/benchmark.mjs --assert-gain
```

The tests execute actual production TS/JS sources. Unrelated logger, scheduler and GPU dependencies are isolated; these are NOT x86 guest-execution tests. Conformance covers memory growth/replacement/subviews, permission faults, zero per-call scratch allocations, aliasing, independent scalar matrix results, camera/projection conventions, inverse singularity, ABI registration and image-info canaries. The bridge test compares actual baseline/candidate source and retains all worker progress messages.

The benchmark alternates baseline/candidate order across eleven pairs after five warmup batches, checks output and full-memory hashes, and records raw samples, source SHA-256, Node/CPU information, medians and a paired bootstrap interval. CI requires at least one >5% gain with its interval above that threshold and rejects an interval entirely below 0.9x. This is a kernel gate, not a claim that every game is faster. Timings from shared hosted runners remain noisy.

## Original Windows sample games

```sh
sudo apt-get install gcc-mingw-w64-i686 binutils-mingw-w64-i686
bash tools/windows-runtime/samples/build.sh "$PWD/evidence/windows-samples"
```

The three original MIT-licensed, asset-free PE32 games use Direct3D 8, Direct3D 9/D3DX9, and DirectDraw 7. Arrow keys move the player and collect stars. D3D9 runs per-sprite D3DX transforms and checks a left-handed camera, D3DXCheckVersion, file-backed texture loading and an image-info canary. All versions exercise Win32 window/messages, keyboard state and file I/O. `--audio` adds a generated-PCM WinMM waveOut smoke path. It is not enabled in the default timed workload.

Launch a sample with `--benchmark` for 120 warmup frames and 600 measured frames. It writes `gamebox-sample-result.json` in its working directory with QPC-based first-present time, p50/p95/p99 frame intervals, aggregate duration, simulation checksum and checked present-call count. Failures exit nonzero and write `gamebox-sample-error.txt`. D3D9 on native Windows needs the legacy D3DX9_43 runtime; no proprietary DLL is redistributed here. CI publishes the EXEs, compiler identity, import tables and SHA256SUMS.

Compilation success is NOT gameplay success. The timing starts inside the guest and therefore excludes engine/game downloads. A successful Present call is NOT proof of visible rendering. Pair the existing browser harness (`docs/harness.md`) with non-black/changed-frame checks, interactive input, clean guest exit and wall-clock first_present measurement before publishing browser FPS/loading claims. Do not take screenshots, park the guest or inject harness sleeps into the timed interval. Compare identical binaries, settings, browser and cache states. A failing/crashing baseline cannot be assigned an infinite FPS improvement.

## Current full-runtime blocker (18 September 2026)

`vendor/v86` points to `8631fb38074d3d611bbf5067a112c481283c179a`, but the configured `https://github.com/jenissimo/v86.git` remote rejects that object (`upload-pack: not our ref`). No matching user-owned v86 fork was found. The existing build tool also refers to the older `a05cc6e51a4a493daede9fda63f6a4f733315f75` pin. Restore the exact intended CPU source and reconcile the build manifest before a full build; do NOT silently substitute upstream HEAD or an unrelated prebuilt runtime.

The `full-runtime-source` CI job deliberately fails on this prerequisite. The existing canonical quality gate remains unchanged. HLE tests, microbenchmarks and sample compilation run in independent jobs, so they can produce useful evidence without presenting a partial pass as a green full-runtime build. End-to-end sample execution, retail-game FPS, browser cold/warm launch time and the full project typecheck are not yet verified by this patch.
