/** bun tools/perf/runtime-fastpaths.ts [base-ref] [report.json]
 * Uses the actual base revision, alternates measurement order, and includes the
 * public WASM boundary plus both copies. Timings are not game FPS or GPU results.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { cpus, platform, arch } from "node:os";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { initializeDxtKernel, dxtKernelUrl } from "../../src/worker/backends/webgpu/shared/dxt-kernel";

import { benchmarkFastpaths } from "./fastpaths-workloads";

const root = fileURLToPath(new URL("../../", import.meta.url));
const base = process.argv[2] ?? "a7c8543d75569d48890d48744897a0ffe3fb02f7";
const output = process.argv[3];
const temporary: string[] = [];
function git(...args: string[]): string { return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(); }
async function loadBase(name: string) {
    const path = `src/worker/backends/webgpu/shared/${name}.ts`;
    const file = `${root}src/worker/backends/webgpu/shared/.perf-base-${name}-${process.pid}.ts`;
    writeFileSync(file, git("show", `${base}:${path}`));
    temporary.push(file);
    return import(file);
}
try {
    const baselineDxt = await loadBase("dxt");
    const baselineSampler = await loadBase("dx-sampler");
    const wasm = readFileSync(dxtKernelUrl);
    assert.equal(await initializeDxtKernel(wasm), true);
    const results = benchmarkFastpaths(baselineDxt, baselineSampler);
    const report = {
        baseline: git("rev-parse", base), candidate: git("rev-parse", "HEAD"), dirty: !!git("status", "--porcelain", "--untracked-files=no"),
        runtime: process.versions, os: platform(), arch: arch(), cpu: cpus()[0]?.model,
        wasmBytes: wasm.length, note: "CPU microbenchmarks only; WASM copies included; no GPU or game-FPS claim.", results,
    };
    const text = JSON.stringify(report, null, 2);
    if (output) writeFileSync(output, text + "\n");
    console.table(results.map(({ case: name, beforeMs, afterMs, speedup }) => ({ case: name, beforeMs, afterMs, speedup })));
    console.log(text);
} finally {
    for (const file of temporary) unlinkSync(file);
}
