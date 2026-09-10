import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRepMachine,repLeaf,LEFT,RIGHT,STACK,ENTRY,DONE,FAULT} from './rep-machine.mjs';
import {PT} from './bulk-machine.mjs';
const binary=readFileSync(process.env.V86_TEST_BINARY||new URL('../../public/v86.wasm',import.meta.url));
async function use(fn,options){const m=await createRepMachine(binary,options);try{assert.equal(m.api.get_unaligned_rep_abi(),1);m.paging();await fn(m);}finally{m.close();}}
const stats=m=>Array.from(new Uint32Array(m.cpu.wasm_memory.buffer,m.api.get_unaligned_rep_stats_ptr()>>>0,8));
const view=m=>new DataView(m.guest().buffer,m.guest().byteOffset);
const put=(v,p,size,x)=>size===2?v.setUint16(p,x,true):v.setUint32(p,x>>>0,true);
const get=(v,p,size)=>size===2?v.getUint16(p,true):v.getUint32(p,true);
function flagsAfter(a,b,size,flags){
    const sign=2**(size*8-1),r=((a-b)&(2**(size*8)-1))>>>0;
    let parity=r&255;parity^=parity>>>4;parity^=parity>>>2;parity^=parity>>>1;
    return ((flags&~0x8d5)|(a<b?1:0)|((parity&1)?0:4)|((a^b^r)&16)|(r===0?64:0)|((r&sign)?128:0)|(((a^b)&(a^r)&sign)?2048:0))>>>0;
}

test('unaligned REP covers independent pointer residues, stop lanes and scalar bridges',async()=>use(m=>{
    const mem=m.guest(),v=view(m),value=0x89abf17e;
    for(const size of [2,4])for(const aoff of [0,1,2,3])for(const boff of [0,1,2,3])for(const backwards of [false,true]){
        for(const op of ['cmps','scas'])for(const equal of [false,true])for(const count of [0,1,15,16,17,31,32,33,65,1057]){
            const a=LEFT+4064+aoff,b=RIGHT+4064+boff,constant=(value&(2**(size*8)-1))>>>0;
            for(const stop of new Set([-1,0,1,7,15,16,count-1])){
                for(let i=0;i<count;i++){
                    // Nonuniform CMPS data catches mismatched source/destination lane selection.
                    const index=backwards?count-1-i:i,left=op==='cmps'?(constant+i*17)>>>0:constant;
                    put(v,a+i*size,size,left);put(v,b+i*size,size,index===stop?(equal?left^0x81:left):(equal?left:left^0x81));
                }
                const start=backwards&&count?(count-1)*size:0,src=a+start,dst=b+start,dir=backwards?-1:1;
                let done=0,left=0,right=0,flags=0x8d7|(backwards?0x400:0);
                while(done<count){left=op==='cmps'?get(v,src+done*dir*size,size):constant;right=get(v,dst+done*dir*size,size);done++;if((left===right)!==equal)break;}
                if(done)flags=flagsAfter(left,right,size,flags);
                const r=m.rep(op,size,src,dst,count,{value,equal,backwards,flags:0x8d7});
                assert.deepEqual(r,{eax:value,ecx:count-done,esi:src+(op==='cmps'?done*dir*size:0),edi:dst+done*dir*size,flags,esp:STACK},`${op}/${size}/${aoff}/${boff}/${backwards}/${equal}/${count}/${stop}`);
            }
        }
    }
    assert.ok(stats(m).slice(0,4).every(n=>n>0));assert.ok(stats(m)[6]>0);assert.equal(m.hostCalls,0);
}));

test('unaligned STOS patterns preserve canaries across all page-edge residues',async()=>use(m=>{
    const mem=m.guest(),v=view(m);
    for(const size of [2,4])for(const offset of [1,2,3,4093,4094,4095])for(const backwards of [false,true])for(const count of [0,1,15,16,17,31,32,33,2051]){
        for(const value of [0,0xabababab,0x12345678,0x80000100]){
            const low=RIGHT+offset,dst=low+(backwards&&count?(count-1)*size:0);mem.fill(173,low-1,low+count*size+1);
            const r=m.rep('stos',size,LEFT,dst,count,{value,backwards,flags:0x8d7});
            for(let i=0;i<count;i++)assert.equal(get(v,low+i*size,size),(value&(2**(size*8)-1))>>>0);
            assert.equal(mem[low-1],173);assert.equal(mem[low+count*size],173);
            assert.equal(r.ecx,0);assert.equal(r.edi,dst+(backwards?-1:1)*count*size);assert.equal(r.flags,0x8d7|(backwards?0x400:0));
        }
    }
    assert.ok(stats(m)[4]>0&&stats(m)[5]>0&&stats(m)[6]>0);
}));

test('huge unaligned REP counts yield after one bounded page without prewalking the next',async()=>use(m=>{
    const v=view(m),mem=m.guest();mem.fill(7,LEFT,LEFT+8192);mem.fill(7,RIGHT,RIGHT+8192);
    for(const op of ['cmps','scas','stos'])for(const size of [2,4]){
        m.paging();const count=0xfffffff0,src=LEFT+3,dst=RIGHT+3,n=Math.floor(4093/size),leaf=repLeaf(op,size);
        const pte=PT+((RIGHT>>>12)+1)*4,before=v.getUint32(pte,true);
        m.prepareRep(op,size,src,dst,count,{single:true,value:0x07070707,flags:0x8d7});
        assert.equal(m.api.run_guest_until(DONE,leaf,1,0,0),1);
        assert.equal(m.state().getUint32(556,true),leaf);assert.equal(m.reg()[1]>>>0,count-n);
        assert.equal(m.reg()[7]>>>0,dst+n*size);assert.equal(m.cpu.get_eflags(),0x8d7);
        assert.equal(v.getUint32(pte,true),before);
    }
}));

function restoreFault(m){const v=view(m),sp=m.reg()[4]>>>0;m.reg()[4]+=16;m.state().setUint32(556,v.getUint32(sp+4,true),true);m.state().setUint32(120,v.getUint32(sp+12,true),true);m.state().setUint32(100,0,true);}

test('cross-page unaligned stores fault before a partial element and resume exactly',async()=>use(m=>{
    const mem=m.guest(),v=view(m);m.installFaultGate();
    for(const size of [2,4])for(const residue of Array.from({length:size-1},(_,i)=>i+1)){
        m.paging();const dst=RIGHT+residue,count=4096/size+65,n=Math.floor((4096-residue)/size),edge=dst+n*size;
        mem.fill(173,RIGHT,RIGHT+12288);m.map((RIGHT>>>12)+1,0,0);m.api.full_clear_tlb();
        m.prepareRep('stos',size,LEFT,dst,count,{value:0x12345678,single:true,flags:0x8d7});
        assert.equal(m.api.run_guest_until(FAULT,repLeaf('stos',size),10000,0,0),0);
        assert.equal(m.cpu.cr[2]>>>0,RIGHT+4096);assert.equal(m.reg()[1]>>>0,count-n);assert.equal(m.reg()[7]>>>0,edge);
        assert.ok(mem.subarray(edge,RIGHT+8192).every(x=>x===173),'faulting element is not partially written');
        const sp=m.reg()[4]>>>0;assert.equal(v.getUint32(sp,true),2);assert.equal(v.getUint32(sp+4,true),repLeaf('stos',size));
        m.map((RIGHT>>>12)+1);m.api.full_clear_tlb();restoreFault(m);m.execute();
        assert.equal(m.reg()[1],0);assert.equal(m.reg()[7]>>>0,dst+count*size);
        for(let i=0;i<count;i++)assert.equal(get(v,dst+i*size,size),size===2?0x5678:0x12345678);
        assert.equal(mem[dst-1],173);assert.equal(mem[dst+count*size],173);
    }
}));

test('backward straddling elements validate their high bytes and preserve fault progress',async()=>use(m=>{
    const mem=m.guest();m.installFaultGate();
    for(const size of [2,4]){
        m.paging();mem.fill(173,RIGHT,RIGHT+8192);m.map((RIGHT>>>12)+1,0,0);m.api.full_clear_tlb();
        const dst=RIGHT+4095,count=65;m.prepareRep('stos',size,LEFT,dst,count,{value:0x12345678,backwards:true,single:true,flags:0x8d7});
        assert.equal(m.api.run_guest_until(FAULT,repLeaf('stos',size),1000,0,0),0);
        assert.equal(m.cpu.cr[2]>>>0,RIGHT+4096);assert.equal(m.reg()[1],count);assert.equal(m.reg()[7]>>>0,dst);
        assert.ok(mem.subarray(RIGHT,RIGHT+8192).every(x=>x===173));
        m.map((RIGHT>>>12)+1);m.api.full_clear_tlb();restoreFault(m);m.execute();
        assert.equal(m.reg()[1],0);assert.equal(m.reg()[7]>>>0,dst-count*size);
    }
}));

test('unaligned CMPS preserves source-before-destination page-fault order',async()=>use(m=>{
    m.installFaultGate();const v=view(m);
    for(const straddle of [false,true]){
        m.paging();const src=LEFT+(straddle?4095:1),dst=RIGHT+1;
        m.map((LEFT>>>12)+Number(straddle),0,0);m.map(RIGHT>>>12,0,0);m.api.full_clear_tlb();
        const pte=PT+(RIGHT>>>12)*4,before=v.getUint32(pte,true);
        m.prepareRep('cmps',4,src,dst,65,{single:true,flags:0x8d7});
        assert.equal(m.api.run_guest_until(FAULT,repLeaf('cmps',4),1000,0,0),0);
        assert.equal(m.cpu.cr[2]>>>0,straddle?LEFT+4096:src);assert.equal(m.reg()[1],65);
        assert.equal(m.reg()[6]>>>0,src);assert.equal(m.reg()[7]>>>0,dst);assert.equal(v.getUint32(pte,true),before);
    }
}));

test('unaligned early comparison stops before an inaccessible following element',async()=>use(m=>{
    const v=view(m);m.installFaultGate();
    for(const size of [2,4])for(const op of ['cmps','scas'])for(const equal of [false,true]){
        m.paging();const src=LEFT+4095-size,dst=RIGHT+4095-size,value=0x12345678;
        put(v,src,size,value);put(v,dst,size,equal?value^0x81:value);
        m.map((LEFT>>>12)+1,0,0);m.map((RIGHT>>>12)+1,0,0);m.api.full_clear_tlb();
        const r=m.rep(op,size,src,dst,65,{equal,value,flags:0x8d7});assert.equal(r.ecx,64);assert.equal(r.edi,dst+size);
        assert.equal(v.getUint32(PT+((RIGHT>>>12)+1)*4,true),0);
    }
}));

test('unaligned page chunks handle discontiguous physical remapping and cold translations',async()=>use(m=>{
    const mem=m.guest();for(const backwards of [false,true]){
        m.paging();for(let i=0;i<3;i++){
            const a=LEFT+0x20000+i*0x20000,b=RIGHT+0x20000+i*0x20000;
            mem.fill(71,a,a+4096);mem.fill(71,b,b+4096);m.map((LEFT>>>12)+i,a>>>12);m.map((RIGHT>>>12)+i,b>>>12);
        }
        m.api.full_clear_tlb();const start=3+(backwards?8192:0),before=stats(m);
        assert.equal(m.rep('cmps',4,LEFT+start,RIGHT+start,2049,{backwards}).ecx,0);assert.ok(stats(m)[1]>before[1]);
        m.rep('stos',4,LEFT,RIGHT+start,2049,{backwards,value:0x31313131});
        for(let i=3;i<3+2049*4;i++)assert.equal(mem[RIGHT+0x20000+Math.floor(i/4096)*0x20000+i%4096],49);
    }
}));

test('unaligned protection faults and write watches retain CPU semantics',async()=>use(m=>{
    const mem=m.guest(),v=view(m);m.installFaultGate();mem.fill(173,RIGHT,RIGHT+8192);
    m.map(RIGHT>>>12,RIGHT>>>12,5);m.api.full_clear_tlb();
    m.prepareRep('stos',4,LEFT,RIGHT+3,129,{single:true,value:0});assert.equal(m.api.run_guest_until(FAULT,repLeaf('stos',4),1000,0,0),0);
    assert.equal(m.cpu.cr[2]>>>0,RIGHT+3);assert.equal(v.getUint32(m.reg()[4]>>>0,true),3);assert.equal(m.reg()[1],129);
    assert.ok(mem.subarray(RIGHT,RIGHT+8192).every(x=>x===173));
    m.paging();const original=m.cpu.wasm_memory;
    m.api.dbg_set_write_watch(RIGHT+19);const before=stats(m);
    m.rep('stos',4,LEFT,RIGHT+3,65,{value:0x12345678});
    assert.deepEqual(stats(m).slice(0,7),before.slice(0,7));assert.ok(stats(m)[7]>before[7]);
    assert.strictEqual(m.cpu.wasm_memory,original);assert.equal(m.api.dbg_ww_hits(),1);m.api.dbg_set_write_watch(0);
}));

test('unaligned REP retains nonvolatile/SIMD state and survives memory growth',async()=>use(m=>{
    m.guest().fill(19,LEFT,LEFT+8192);m.guest().fill(19,RIGHT,RIGHT+8192);
    const old=m.guest().buffer;m.cpu.wasm_memory.grow(1);assert.notEqual(m.guest().buffer,old);
    const xmm=new Uint8Array(m.cpu.wasm_memory.buffer,832,128);for(let i=0;i<xmm.length;i++)xmm[i]=i*17;
    const expected=xmm.slice();m.prepareRep('cmps',4,LEFT+1,RIGHT+3,129,{single:true,flags:0x8d7});
    m.reg()[2]=0x12344321;m.reg()[3]=0x23455432;m.reg()[5]=0x34566543;m.execute();
    assert.equal(m.reg()[2],0x12344321);assert.equal(m.reg()[3],0x23455432);assert.equal(m.reg()[5],0x34566543);
    assert.deepEqual(new Uint8Array(m.cpu.wasm_memory.buffer,832,128),expected);assert.ok(stats(m)[1]>0);
}));

test('JIT-warmed unaligned REP observes rollback and invalidates overwritten compiled code',async()=>use(async m=>{
    const mem=m.guest(),v=view(m),before=m.finalized;mem.fill(7,LEFT,LEFT+8192);mem.fill(7,RIGHT,RIGHT+8192);
    m.prepareRep('cmps',4,LEFT+3,RIGHT+3,129,{iterations:100000});m.execute();
    for(let i=0;i<100&&m.finalized===before;i++)await new Promise(r=>setTimeout(r,5));assert.ok(m.finalized>before);
    m.api.set_unaligned_rep_enabled(0);const s=stats(m);assert.equal(m.rep('cmps',4,LEFT+3,RIGHT+3,129).ecx,0);assert.deepEqual(stats(m),s);
    m.api.set_unaligned_rep_enabled(1);assert.equal(m.rep('cmps',4,LEFT+3,RIGHT+3,129).ecx,0);assert.ok(stats(m)[1]>s[1]);
    const probe=ENTRY+0x8000+3;mem.fill(0x90,probe,probe+64);mem[probe-1]=0xb8;v.setUint32(probe,0x11111111,true);mem[probe+64]=0xc3;
    function invoke(n){m.prepareRep('stos',4,LEFT,RIGHT,1,{iterations:n});m.reg()[5]=probe-1;return m.execute();}
    const compiled=m.finalized;assert.equal(invoke(100000)>>>0,0x11111111);
    for(let i=0;i<100&&m.finalized===compiled;i++)await new Promise(r=>setTimeout(r,5));assert.ok(m.finalized>compiled);
    m.rep('stos',4,LEFT,probe,16,{value:0x90909090});assert.equal(invoke(1)>>>0,0x90909090);assert.equal(m.hostCalls,0);
},{jit:true}));

test('unaligned CPL3 reads cannot bypass supervisor page protection',async()=>use(m=>{
    m.installFaultGate(true);m.map(LEFT>>>12,LEFT>>>12,3);m.api.full_clear_tlb();
    m.prepareRep('cmps',4,LEFT+1,RIGHT+3,65,{single:true,flags:0x202});
    const before=stats(m);assert.equal(m.api.run_guest_until(FAULT,repLeaf('cmps',4),1000,0,0),0);
    assert.equal(m.cpu.cr[2]>>>0,LEFT+1);assert.equal(view(m).getUint32(m.reg()[4]>>>0,true),5);
    assert.equal(m.reg()[1],65);assert.deepEqual(stats(m),before);
}));

test('unaligned mapped device memory retains exact scalar MMIO callback order',async()=>use(m=>{
    for(const size of [2,4])for(const backwards of [false,true])for(const op of ['cmps','scas','stos']){
        m.paging();m.map(RIGHT>>>12,0xa0000>>>12);m.api.full_clear_tlb();
        const value=size===2?0x5678:0x12345678,count=65,src=LEFT+3,dst=RIGHT+3+(backwards?(count-1)*size:0),calls=[];
        for(let i=0;i<count;i++)put(view(m),src+i*size,size,value);
        const readName=`mmap_read${size*8}`,writeName=`mmap_write${size*8}`,read=m.cpu[readName],write=m.cpu[writeName];
        m.cpu[readName]=addr=>{calls.push([addr]);return value;};m.cpu[writeName]=(addr,x)=>{calls.push([addr,x]);};
        try {
            const before=stats(m),r=m.rep(op,size,src+(backwards?(count-1)*size:0),dst,count,{value,backwards});
            assert.equal(r.ecx,0);assert.equal(calls.length,count);assert.deepEqual(stats(m).slice(0,6),before.slice(0,6));assert.ok(stats(m)[7]>before[7]);
            for(let i=0;i<count;i++)assert.deepEqual(calls[i],op==='stos'?[0xa0000+(dst-RIGHT)+(backwards?-1:1)*i*size,value]:[0xa0000+(dst-RIGHT)+(backwards?-1:1)*i*size]);
        } finally {m.cpu[readName]=read;m.cpu[writeName]=write;}
    }
}));

test('unaligned FS offsets accelerate while 16-bit wrap retains the original path',async()=>use(m=>{
    m.guest().fill(7,LEFT,LEFT+65540);m.guest().fill(7,RIGHT,RIGHT+65540);
    m.cpu.segment_offsets[4]=3;m.cpu.segment_is_null[4]=0;const before=stats(m);
    assert.equal(m.rep('cmps',4,LEFT,RIGHT+1,65,{fs:true}).ecx,0);assert.ok(stats(m)[1]>before[1]);
    m.cpu.segment_offsets[3]=LEFT;m.cpu.segment_offsets[0]=RIGHT;const after=stats(m);
    const r=m.rep('cmps',4,0x1234fff9,0x5678fff9,0xabcd0021,{address16:true});
    assert.equal(r.ecx,0xabcd0000);assert.equal(r.esi,0x1234007d);assert.equal(r.edi,0x5678007d);assert.deepEqual(stats(m),after);
}));
