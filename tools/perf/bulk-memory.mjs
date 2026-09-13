import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {cpus,platform,arch} from 'node:os';
import {benchmarkBulk} from './bulk-workloads.mjs';
const base=process.argv[2] || '9501efd8bc208be8e67f72f226bb795255451bc7';
const parent=execFileSync('git',['show',`${base}:public/v86.wasm`],{maxBuffer:16*1024*1024});
const candidate=readFileSync(process.env.V86_TEST_BINARY || new URL('../../public/v86.wasm',import.meta.url));
const variants={parent,candidate};
if(process.env.V86_REBUILT_BASELINE) variants.rebuilt=readFileSync(process.env.V86_REBUILT_BASELINE);
const report={base,head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),cpu:cpus()[0]?.model,
    os:platform(),arch:arch(),runtime:process.versions,...await benchmarkBulk(variants)};
console.table(report.results.map(r=>({case:r.case,parentMs:r.mediansMs.parent,candidateMs:r.mediansMs.candidate,speedup:r.speedupVsParent,controlled:r.speedupVsRebuilt})));
if(process.argv[3])writeFileSync(process.argv[3],JSON.stringify(report,null,2)+'\n');
