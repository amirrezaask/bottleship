import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {cpus,platform,arch} from 'node:os';
import {createHash} from 'node:crypto';
import {benchmarkUnaligned} from './unaligned-workloads.mjs';
const base=process.argv[2]||'822b0f214bb36e9757784be0f524557d59a4fe94';
const parent=execFileSync('git',['show',`${base}:public/v86.wasm`],{maxBuffer:16*1024*1024});
const candidate=readFileSync(process.env.V86_TEST_BINARY||new URL('../../public/v86.wasm',import.meta.url));
const variants={parent,candidate};
if(process.env.V86_REBUILT_BASELINE)variants.rebuilt=readFileSync(process.env.V86_REBUILT_BASELINE);
const report={base,head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),cpu:cpus()[0]?.model,
    os:platform(),arch:arch(),runtime:process.versions,
    binaryHashes:Object.fromEntries(Object.entries(variants).map(([name,bytes])=>[name,createHash('sha256').update(bytes).digest('hex')])),
    ...await benchmarkUnaligned(variants)};
console.table(report.results.map(r=>({case:r.case,parentMs:r.mediansMs.parent,candidateMs:r.mediansMs.candidate,speedup:r.speedupVsParent})));
if(process.argv[3])writeFileSync(process.argv[3],JSON.stringify(report,null,2)+'\n');
