import {createRepMachine,LEFT,RIGHT} from '../runtime-test/rep-machine.mjs';
const median=xs=>[...xs].sort((a,b)=>a-b)[xs.length>>1];
const pause=()=>new Promise(r=>setTimeout(r,5));
export function repCases(){
    const configs=[];
    for(const op of ['cmps','scas'])for(const size of [1,2,4])for(const equal of [false,true])configs.push({op,size,equal,value:0x89abf17e});
    for(const size of [2,4])for(const value of [0,0x12345678])configs.push({op:'stos',size,equal:true,value});
    for(const op of ['movs','stos'])configs.push({op,size:1,equal:true,value:47}); // existing bulk controls
    const cases=[];
    for(const c of configs)for(const length of [0,8,4096,65536])for(const backwards of [false,true])cases.push({...c,length,backwards,offset:0,mode:'full'});
    for(const c of configs)for(const backwards of [false,true])cases.push({...c,length:4096,backwards,offset:3,mode:'full'});
    for(const c of configs.filter(x=>x.op!=='stos'&&x.op!=='movs'&&x.size===1))for(const length of [8,4096])for(const backwards of [false,true])for(const mode of ['first','last'])cases.push({...c,length,backwards,offset:0,mode});
    return cases;
}
export async function benchmarkRep(variants,cases=repCases()){
    const machines=[];
    try{
        for(const [name,binary] of Object.entries(variants)){
            const m=await createRepMachine(binary,{jit:true,halt:true});machines.push([name,m]);m.paging();
            m.guest().fill(7,LEFT,LEFT+4096);m.guest().fill(7,RIGHT,RIGHT+4096);
            for(const op of ['cmps','scas','stos','movs'])for(const size of [1,2,4])for(const equal of [false,true]){
                m.prepareRep(op,size,LEFT,RIGHT,32,{value:7,equal,iterations:30000});m.execute();
                await pause();
            }
            for(let i=0;i<100&&!m.finalized;i++)await pause();
            if(!m.finalized)throw new Error(`${name}: guest REP loop did not compile`);
        }
        const results=[];
        for(const c of cases){
            const {op,size,equal,value,length,backwards,offset,mode}=c,bytes=length*size;
            const start=backwards&&length?(length-1)*size:0,a=LEFT+offset,b=RIGHT+(c.dstOffset??offset),src=a+start,dst=b+start;
            const stop=mode==='first'?0:mode==='last'?length-1:-1,done=stop<0?length:Math.min(length,stop+1);
            const expectedCount=length-done,expectedSrc=src+((op==='cmps'||op==='movs')?done*size*(backwards?-1:1):0),expectedDst=dst+done*size*(backwards?-1:1);
            const options={equal,backwards,value};
            const check=m=>{const r=m.snapshot();if(r.ecx!==expectedCount||r.esi!==expectedSrc||r.edi!==expectedDst||r.eax!==(value>>>0)||m.reg()[3]!==0)throw new Error(`REP result mismatch ${JSON.stringify(c)} ${JSON.stringify(r)}`);};
            for(const [,m] of machines){
                const mem=m.guest(),v=new DataView(mem.buffer,mem.byteOffset),put=(p,x)=>size===1?v.setUint8(p,x):size===2?v.setUint16(p,x,true):v.setUint32(p,x>>>0,true);
                for(let i=0;i<length;i++){
                    put(a+i*size,value);const index=backwards?length-1-i:i;
                    put(b+i*size,index===stop?(equal?value^0x81:value):(equal?value:value^0x81));
                }
                if(op==='stos'||op==='movs')mem.fill(173,b-1,b+bytes+1);
                m.warm(a,bytes);m.warm(b,bytes,op==='stos'||op==='movs');
                m.prepareRep(op,size,src,dst,length,{...options,iterations:64});m.execute();check(m);
            }
            // Permit asynchronous browser/WASM compilation to settle between phases.
            await pause();
            const statIndex=op==='cmps'?0:op==='scas'?1:op==='stos'&&size>1?size===2?2:3:-1;
            const shouldHit=statIndex>=0&&offset%size===0&&(c.dstOffset??offset)%size===0&&length>=(op==='stos'?64/size:16/size);
            const candidate=machines.find(([n])=>n==='candidate')?.[1];
            const before=candidate?.repStats()?.[statIndex];
            const extraStats=m=>m?.api.get_unaligned_rep_stats_ptr?Array.from(new Uint32Array(m.cpu.wasm_memory.buffer,m.api.get_unaligned_rep_stats_ptr()>>>0,8)):null;
            const extraBefore=extraStats(candidate);
            const counts={},samples=Object.fromEntries(machines.map(([n])=>[n,[]])),batches=Object.fromEntries(machines.map(([n])=>[n,[]]));
            for(const [name,m] of machines){
                let iterations=length===0||mode==='first'?20000:Math.max(8,Math.min(20000,Math.floor(262144/Math.max(1,bytes))));
                for(let tries=0;tries<10;tries++){
                    m.prepareRep(op,size,src,dst,length,{...options,iterations});const begin=performance.now();m.execute();const elapsed=performance.now()-begin;check(m);
                    if(elapsed>=3||iterations===500000)break;
                    iterations=Math.min(500000,Math.max(iterations+1,Math.ceil(iterations*3.3/Math.max(0.001,elapsed))));
                }
                counts[name]=iterations;
            }
            await pause();
            for(let round=0;round<9;round++){
              await pause();
              for(const [name,m] of round&1?[...machines].reverse():machines){
                m.prepareRep(op,size,src,dst,length,{...options,iterations:counts[name]});const begin=performance.now();m.execute();const elapsed=performance.now()-begin;
                batches[name].push(elapsed);samples[name].push(elapsed/counts[name]);check(m);
              }
            }
            for(const [name,m] of machines){
                if(m.hostCalls)throw new Error(`${name}: unexpected API host dispatch`);
                if(name==='candidate'&&shouldHit&&m.repStats()?.[statIndex]===before)throw new Error(`REP intrinsic not exercised ${JSON.stringify(c)}`);
                if(name==='candidate'&&c.requireUnaligned){
                    const index=(op==='cmps'?0:op==='scas'?2:4)+Number(size===4);
                    if(!extraBefore||extraStats(m)[index]===extraBefore[index])throw new Error('Unaligned intrinsic not exercised');
                }
                if(op==='stos'||op==='movs'){
                    const mem=m.guest();for(let i=0;i<bytes;i++)if(mem[b+i]!==((value>>>((i%size)*8))&255))throw new Error('REP write mismatch');
                    if(mem[b-1]!==173||mem[b+bytes]!==173)throw new Error('REP write canary changed');
                }
            }
            const medians=Object.fromEntries(Object.entries(samples).map(([name,xs])=>[name,median(xs)]));
            results.push({case:`${equal?'REPE':'REPNE'} ${op}${size*8} ${mode} ${length} units ${backwards?'backward':'forward'} +${offset}/+${c.dstOffset??offset} value=${value>>>0}`,...c,
                mediansMs:medians,iterationsByVariant:counts,samplesMs:samples,batchSamplesMs:batches,speedupVsParent:medians.parent/medians.candidate,speedupVsRebuilt:medians.rebuilt?medians.rebuilt/medians.candidate:null});
        }
        return {note:'Real JIT-warmed guest REP instructions, resident pages, same caller; event-loop yields between warm-up/calibration/sample batches allow async tiering to settle. Timings include register setup/CALL/RET/loop and page translation; no API thunks, staging copies, GPU or native-performance comparison. All supplied cases retained, including controls and fallbacks.', caseCount:cases.length,
            engines:Object.fromEntries(machines.map(([n,m])=>[n,{jitFinalizations:m.finalized,hostCalls:m.hostCalls,repStats:m.repStats(),unalignedStats:m.api.get_unaligned_rep_stats_ptr?Array.from(new Uint32Array(m.cpu.wasm_memory.buffer,m.api.get_unaligned_rep_stats_ptr()>>>0,8)):null}])),results};
    }finally{for(const [,m] of machines)m.close();}
}
