/** Paired measurements of actual HLE sources. This is NOT game FPS or cold-start time. */
import { loadMath } from './source-loader.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cpus, platform, arch } from 'node:os';
import { performance } from 'node:perf_hooks';

const args=process.argv.slice(2);
const option=(key,fallback)=>args.includes(key)?args[args.indexOf(key)+1]:fallback;
const baselineRef=option('--baseline-ref','3c194209799afea7cbaecb0eb1e8170a5cafb735');
const output=option('--output','evidence/hle-benchmark.json');
const pairs=Number(option('--pairs','11'));
if(!Number.isInteger(pairs)||pairs<9||pairs>101) throw new Error('pairs must be an integer from 9 to 101');
const paths=['src/worker/core/memory/mem-accessor.ts','src/worker/modules/d3dx9/math.ts'];
const git=(...a)=>execFileSync('git',a,{encoding:'utf8'}).trim();
const hash=s=>createHash('sha256').update(s).digest('hex');
const baseline=await loadMath({ref:baselineRef}),candidate=await loadMath();
const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const bitView=new DataView(new ArrayBuffer(4));
function bits(x){bitView.setFloat32(0,x,true);return bitView.getUint32(0,true);}
function initialize(runtime){
    const memory=new Uint8Array(8192);
    runtime.Mem.bind(()=>memory,(p,n)=>p>=64 && p+n<=memory.length);
    [128,256].forEach(p=>identity.forEach((v,i)=>runtime.Mem.writeFloat32(p+i*4,v)));
    [1.25,-2,0.5].forEach((v,i)=>runtime.Mem.writeFloat32(600+i*4,v));
    return memory;
}
function workload(runtime,name,n){
    const memory=initialize(runtime),{Mem,functions}=runtime,ctx={};
    let checksum=0;
    const argumentsByName={multiply:[384,128,256],translation:[384,bits(1.25),bits(-2),bits(0.5)],transform:[704,600,128]};
    const fn=name==='multiply'?functions.D3DXMatrixMultiply:name==='translation'?functions.D3DXMatrixTranslation:functions.D3DXVec3TransformCoord;
    const callArgs=argumentsByName[name];
    const start=performance.now();
    if(name==='float-access'){
        for(let i=0;i<n;i++){
            Mem.writeFloat32(800,i*0.25); Mem.writeFloat64(808,i*0.5);
            checksum+=Mem.readFloat32(800)+Mem.readFloat64(808);
        }
    } else {
        for(let i=0;i<n;i++){
            // Include a live memory dependency, identical for both versions.
            Mem.writeFloat32(128,1+(i&15)*0.03125);
            checksum+=fn(ctx,memory,callArgs);
        }
    }
    const ms=performance.now()-start;
    let memoryHash=2166136261;
    for(const byte of memory) memoryHash=Math.imul(memoryHash^byte,16777619)>>>0;
    if(!Number.isFinite(checksum)||!Number.isFinite(ms)||ms<=0)throw new Error('Invalid measurement');
    return {ms,checksum,memoryHash};
}
const median=xs=>{const s=[...xs].sort((a,b)=>a-b),m=s.length>>1;return s.length%2?s[m]:(s[m-1]+s[m])/2;};
function interval(ratios){
    let seed=0x51a7;const boots=[];
    for(let k=0;k<5000;k++){
        const sample=[];
        for(let i=0;i<ratios.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;sample.push(ratios[seed%ratios.length]);}
        boots.push(median(sample));
    }
    boots.sort((a,b)=>a-b);return [boots[125],boots[4874]];
}
const results=[];
for(const [name,iterations] of [['float-access',100000],['multiply',10000],['translation',20000],['transform',15000]]){
    for(let i=0;i<5;i++){workload(baseline,name,iterations);workload(candidate,name,iterations);}
    const samples=[];
    for(let i=0;i<pairs;i++){
        const order=i%2?[['candidate',candidate],['baseline',baseline]]:[['baseline',baseline],['candidate',candidate]];
        const pair={order:order.map(([label])=>label)};
        for(const [label,runtime] of order)pair[label]=workload(runtime,name,iterations);
        if(pair.baseline.checksum!==pair.candidate.checksum||pair.baseline.memoryHash!==pair.candidate.memoryHash)throw new Error(`${name}: output mismatch`);
        samples.push(pair);
    }
    const ratios=samples.map(p=>p.baseline.ms/p.candidate.ms);
    const result={name,iterations,baselineMedianMs:median(samples.map(p=>p.baseline.ms)),candidateMedianMs:median(samples.map(p=>p.candidate.ms)),pairedMedianSpeedup:median(ratios),pairedBootstrap95:interval(ratios),samples};
    results.push(result);
    console.log(`${name}: ${result.baselineMedianMs.toFixed(3)} -> ${result.candidateMedianMs.toFixed(3)} ms; paired ${result.pairedMedianSpeedup.toFixed(3)}x [${result.pairedBootstrap95.map(x=>x.toFixed(3)).join(', ')}]`);
}
const report={schemaVersion:1,scope:'isolated-real-source-HLE; NOT x86 execution, game FPS, GPU timing, or loading time',timestamp:new Date().toISOString(),baselineRef,baselineCommit:git('rev-parse',baselineRef),candidateCommit:git('rev-parse','HEAD'),workingTreeDirty:!!git('status','--porcelain','--untracked-files=no'),sources:paths.map(path=>({path,baselineSha256:hash(execFileSync('git',['show',`${baselineRef}:${path}`],{encoding:'utf8'})),candidateSha256:hash(readFileSync(path))})),environment:{node:process.version,platform:platform(),arch:arch(),cpu:cpus()[0]?.model},warmupBatches:5,pairs,results};
mkdirSync(output.slice(0,output.lastIndexOf('/'))||'.',{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');
if(args.includes('--assert-gain')&&!results.some(r=>r.pairedBootstrap95[0]>1.05))throw new Error('No HLE improvement above 5% with a positive paired bootstrap interval');
if(args.includes('--assert-gain')&&results.some(r=>r.pairedBootstrap95[1]<0.9))throw new Error('An HLE workload regressed by more than 10% with a negative paired interval');
