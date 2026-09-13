import {createMachine,LEFT,RIGHT} from '../runtime-test/bulk-machine.mjs';
const median=xs=>[...xs].sort((a,b)=>a-b)[xs.length>>1];
const pause=()=>new Promise(r=>setTimeout(r,5));
const operations=['strlen','wcslen','strcpy','wcscpy','strcmp','stricmp','wcsicmp','wcschr'];
const statIndex={strlen:0,wcslen:1,strcmp:2,stricmp:3,wcsicmp:4,wcschr:7,strcpy:8,wcscpy:9};

/** Same guest loop for each binary; setup, page priming and validation are not timed. */
export async function benchmarkStrings(variants){
    const machines=[];
    try{
        for(const [name,binary] of Object.entries(variants)){
            const m=await createMachine(binary,{jit:true,halt:true});machines.push([name,m]);m.paging();
            m.guest().fill(65,LEFT,LEFT+128);m.guest()[LEFT+128]=0;m.warm(LEFT,129);
            m.call('strlen',LEFT,0,0,250000);
            for(let i=0;i<100&&!m.finalized;i++)await pause();
            if(!m.finalized)throw new Error(`${name}: guest loop did not JIT compile`);
            m.call('strlen',LEFT,0,0,10000);await pause();
        }
        const results=[];
        for(const op of operations)for(const length of [0,8,32,256,4096,65536])for(const offset of [0,3]){
            const wide=op.startsWith('wcs'),stride=wide?2:1,copy=op.endsWith('cpy'),compare=op.endsWith('cmp'),find=op==='wcschr';
            const modes=compare?['equal','first','last']:find?['absent','first','last']:['full'];
            for(const mode of modes){
                const a=LEFT+offset,b=RIGHT+offset+2,bytes=(length+1)*stride;
                const pos=mode==='first'?0:length-1,hasDifference=length>0&&mode!=='equal';
                const expected=copy?b:compare?(hasDifference?-1:0):find?(length&&mode!=='absent'?a+pos*stride:0):length;
                const folded=op==='stricmp'||op==='wcsicmp';
                const args=copy?[b,a,0]:compare?[a,b,0]:find?[a,66,0]:[a,0,0];
                for(const [,m] of machines){
                    const mem=m.guest(),view=new DataView(mem.buffer,mem.byteOffset);
                    const put=(ptr,i,value)=>wide?view.setUint16(ptr+i*2,value,true):mem[ptr+i]=value;
                    for(let i=0;i<length;i++){put(a,i,65);put(b,i,folded?97:65);}
                    put(a,length,0);put(b,length,0);
                    if(compare&&hasDifference)put(b,pos,folded?98:66);
                    if(find&&length&&mode!=='absent')put(a,pos,66);
                    if(copy)mem.fill(173,b-1,b+bytes+1);
                    m.warm(a,bytes);m.warm(b,bytes,copy);
                    if(m.call(op,...args,64)!==expected)throw new Error(`Wrong ${op} ${mode} result before timing`);
                }
                const hits=machines.find(([name])=>name==='candidate')?.[1].stringStats()?.[statIndex[op]];
                const seedIterations=length===0||mode==='first'?20000:Math.max(8,Math.min(20000,Math.floor(524288/bytes)));
                const iterationsByVariant={};
                // Calibrate each engine to real millisecond batches, not clock-sized fast-path samples.
                for(const [name,m] of machines){
                    let count=seedIterations;
                    for(let attempt=0;attempt<10;attempt++){
                        m.prepare(op,...args,count);const start=performance.now();const result=m.execute();
                        const elapsed=performance.now()-start;
                        if(result!==expected)throw new Error(`Wrong calibration ${op} result`);
                        if(elapsed>=3||count===500000)break;
                        count=Math.min(500000,Math.max(count+1,Math.ceil(count*3.3/Math.max(elapsed,0.001))));
                    }
                    iterationsByVariant[name]=count;
                }
                const samples=Object.fromEntries(machines.map(([name])=>[name,[]]));
                const batchSamples=Object.fromEntries(machines.map(([name])=>[name,[]]));
                for(let round=0;round<9;round++)for(const [name,m] of round&1?[...machines].reverse():machines){
                    const iterations=iterationsByVariant[name];
                    m.prepare(op,...args,iterations);const start=performance.now();const result=m.execute();
                    const elapsed=performance.now()-start;
                    batchSamples[name].push(elapsed);samples[name].push(elapsed/iterations);
                    if(result!==expected)throw new Error(`Wrong timed ${op} ${mode} result`);
                }
                for(const [name,m] of machines){
                    if(m.hostCalls)throw new Error(`${name}: unexpected host dispatch`);
                    if(copy){
                        const mem=m.guest();
                        if(!mem.subarray(b,b+bytes).every((v,i)=>v===mem[a+i])||mem[b-1]!==173||mem[b+bytes]!==173)throw new Error('Copy output/canary mismatch');
                    }
                    if(name==='candidate'&&m.stringStats()?.[statIndex[op]]===hits)throw new Error(`${op}: native path not exercised`);
                }
                const medians=Object.fromEntries(Object.entries(samples).map(([name,xs])=>[name,median(xs)]));
                results.push({case:`${op} ${mode} ${length} units +${offset}`,op,length,stride,offset,mode,iterationsByVariant,
                    mediansMs:medians,samplesMs:samples,batchSamplesMs:batchSamples,speedupVsParent:medians.parent/medians.candidate,
                    speedupVsRebuilt:medians.rebuilt?medians.rebuilt/medians.candidate:null});
            }
        }
        return {note:'CPU microbenchmarks in JIT-warmed guest CALL/OUT/RET loops; resident pages; batches calibrated per binary toward >=3 ms; no staging copies; not game FPS or a native-runtime comparison.',
            engines:Object.fromEntries(machines.map(([name,m])=>[name,{jitFinalizations:m.finalized,hostCalls:m.hostCalls,stringStats:m.stringStats()}])),results};
    }finally{for(const [,m] of machines)m.close();}
}
