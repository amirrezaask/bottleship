/** Compare the public surface API against the exact parent PR source. */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { cpus, arch, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { initializeDxtKernel, dxtSimdKernelUrl, getDxtKernelStatus } from '../../src/worker/backends/webgpu/shared/dxt-kernel';
import { benchmarkPixels } from './pixel-workloads';

const root = fileURLToPath(new URL('../../', import.meta.url));
const base = process.argv[2] ?? 'd99c61599bbe5adcb2031cdc88cef7a35c964d2f';
const git = (...args: string[]) => execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
const temporary = `${root}src/worker/modules/ddraw/.perf-base-pixels-${process.pid}.ts`;
try {
    writeFileSync(temporary,git('show',`${base}:src/worker/modules/ddraw/gpu-texture-utils.ts`));
    const baseline = await import(temporary);
    if (!await initializeDxtKernel(readFileSync(dxtSimdKernelUrl))) throw new Error('SIMD texture kernel initialization failed');
    const results = benchmarkPixels(baseline);
    const report = {
        baseline:git('rev-parse',base),candidate:git('rev-parse','HEAD'),dirty:!!git('status','--porcelain','--untracked-files=no'),
        runtime:process.versions,cpu:cpus()[0]?.model,arch:arch(),os:platform(),kernel:getDxtKernelStatus(),
        note:'Public API CPU microbenchmarks; SIMD module explicitly loaded; both staging copies included; not game FPS.',results,
    };
    const json = JSON.stringify(report,null,2);
    if(process.argv[3])writeFileSync(process.argv[3],json+'\n');
    console.table(results.map(({case:name,beforeMs,afterMs,speedup})=>({case:name,beforeMs,afterMs,speedup})));
    console.log(json);
} finally { unlinkSync(temporary); }
