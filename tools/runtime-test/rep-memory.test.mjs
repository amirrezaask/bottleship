import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRepMachine,repLeaf,LEFT,RIGHT,STACK,ENTRY,LEAF,DONE,FAULT} from './rep-machine.mjs';
import {PT} from './bulk-machine.mjs';
const binary=readFileSync(process.env.V86_TEST_BINARY||new URL('../../public/v86.wasm',import.meta.url));
async function use(fn,options){const m=await createRepMachine(binary,options);try{assert.equal(m.api.get_rep_memory_abi(),1);m.paging();await fn(m);}finally{m.close();}}
const put=(v,p,size,x)=>size===1?v.setUint8(p,x):size===2?v.setUint16(p,x,true):v.setUint32(p,x>>>0,true);
const get=(v,p,size)=>size===1?v.getUint8(p):size===2?v.getUint16(p,true):v.getUint32(p,true);
function subtractFlags(a,b,size,flags){
    const bits=size*8,mask=2**bits-1,sign=2**(bits-1),r=((a-b)&mask)>>>0;
    let parity=r&255;parity^=parity>>>4;parity^=parity>>>2;parity^=parity>>>1;
    return ((flags&~0x8d5)|(a<b?1:0)|((parity&1)?0:4)|((a^b^r)&16)|(r===0?64:0)|((r&sign)?128:0)|(((a^b)&(a^r)&sign)?2048:0))>>>0;
}

test('REP CMPS/SCAS match independent element-count and subtraction-flag models',async()=>use(m=>{
    const mem=m.guest(),v=new DataView(mem.buffer,mem.byteOffset);
    for(const op of ['cmps','scas'])for(const size of [1,2,4])for(const equal of [false,true])for(const backwards of [false,true]){
        for(const count of [0,1,7,15,16,17,31,64,129,1027])for(const offset of [0,3,4092]){
            const a=LEFT+offset,b=RIGHT+offset+size*2,mask=2**(size*8)-1,value=0x89abf17e,constant=(value&mask)>>>0;
            for(const stop of new Set([-1,0,1,7,15,16,count-1])){
                for(let i=0;i<count;i++){
                    put(v,a+i*size,size,constant);
                    const index=backwards?count-1-i:i;
                    put(v,b+i*size,size,index===stop?(equal?constant^0x81:constant):(equal?constant:constant^0x81));
                }
                const src=a+(backwards&&count?(count-1)*size:0),dst=b+(backwards&&count?(count-1)*size:0),direction=backwards?-1:1;
                let consumed=0,left=constant,right=constant,flags=0x8d7|(backwards?0x400:0);
                while(consumed<count){left=op==='cmps'?get(v,src+consumed*direction*size,size):constant;right=get(v,dst+consumed*direction*size,size);consumed++;if((left===right)!==equal)break;}
                if(consumed)flags=subtractFlags(left,right,size,flags);
                const r=m.rep(op,size,src,dst,count,{equal,backwards,value,flags:0x8d7});
                assert.deepEqual(r,{eax:value,ecx:count-consumed,esi:src+(op==='cmps'?consumed*direction*size:0),edi:dst+consumed*direction*size,flags,esp:STACK},`${op}/${size}/${equal}/${backwards}/${count}/${offset}/${stop}`);
            }
        }
    }
    assert.equal(m.hostCalls,0);assert.ok(m.repStats()[0]>0&&m.repStats()[1]>0);
}));

test('REP STOS preserves patterns, canaries, flags and direction for byte/word/dword stores',async()=>use(m=>{
    const mem=m.guest(),v=new DataView(mem.buffer,mem.byteOffset);
    for(const size of [1,2,4])for(const backwards of [false,true])for(const count of [0,1,15,16,17,31,32,64,257,2051]){
        for(const offset of [0,1,3,4092])for(const value of [0,0xabababab,0x12345678,0x80000100,0xffffffff]){
            const low=RIGHT+offset,dst=low+(backwards&&count?(count-1)*size:0);mem.fill(173,low-1,low+count*size+1);
            const r=m.rep('stos',size,LEFT,dst,count,{value,backwards,flags:0x8d7});
            for(let i=0;i<count;i++)assert.equal(get(v,low+i*size,size),(value&(2**(size*8)-1))>>>0);
            assert.equal(mem[low-1],173);assert.equal(mem[low+count*size],173);
            assert.deepEqual(r,{eax:value,ecx:0,esi:LEFT,edi:dst+(backwards?-1:1)*count*size,flags:0x8d7|(backwards?0x400:0),esp:STACK});
        }
    }
    assert.ok(m.repStats()[2]>0&&m.repStats()[3]>0);assert.equal(m.hostCalls,0);
}));

test('REP keeps page-sized restart points and does not pretranslate the next page',async()=>use(m=>{
    const mem=m.guest(),v=new DataView(mem.buffer,mem.byteOffset);
    mem.fill(7,LEFT,LEFT+8192);mem.fill(7,RIGHT,RIGHT+8192);
    for(const op of ['cmps','scas','stos']){
        const size=op==='stos'?4:1,count=8192/size,leaf=repLeaf(op,size);
        m.map((RIGHT>>>12)+1);m.api.full_clear_tlb();
        const pte=PT+((RIGHT>>>12)+1)*4,before=v.getUint32(pte,true);
        m.prepareRep(op,size,LEFT,RIGHT,count,{single:true,value:7,flags:0x8d7});
        assert.equal(m.api.run_guest_until(DONE,leaf,1,0,0),1);
        assert.equal(m.state().getUint32(556,true),leaf);assert.equal(m.reg()[1]>>>0,count-4096/size);
        assert.equal(m.reg()[7]>>>0,RIGHT+4096);assert.equal(m.cpu.get_eflags(),0x8d7);
        assert.equal(v.getUint32(pte,true),before,'no ahead-of-time page walk');
        m.execute();assert.equal(m.reg()[1],0);
    }
}));

test('actual page fault preserves partial REP progress and resumes after remapping',async()=>use(m=>{
    const mem=m.guest(),v=new DataView(mem.buffer,mem.byteOffset);m.installFaultGate();
    mem.fill(173,RIGHT,RIGHT+8192);m.map((RIGHT>>>12)+1,0,0);m.api.full_clear_tlb();
    m.prepareRep('stos',4,LEFT,RIGHT,2048,{value:0x12345678,single:true,flags:0x8d7});
    assert.equal(m.api.run_guest_until(FAULT,LEAF,1000,0,0),0);
    assert.equal(m.cpu.cr[2]>>>0,RIGHT+4096);assert.equal(m.reg()[1],1024);assert.equal(m.reg()[7]>>>0,RIGHT+4096);
    for(let i=0;i<4096;i+=4)assert.equal(v.getUint32(RIGHT+i,true),0x12345678);
    assert.ok(mem.subarray(RIGHT+4096,RIGHT+8192).every(x=>x===173));
    const sp=m.reg()[4]>>>0;assert.equal(v.getUint32(sp,true),2);assert.equal(v.getUint32(sp+4,true),repLeaf('stos',4));
    assert.equal(v.getUint32(sp+12,true)&0x8d5,0x8d5);
    m.map((RIGHT>>>12)+1);m.api.full_clear_tlb();m.reg()[4]+=16;
    m.state().setUint32(556,v.getUint32(sp+4,true),true);m.state().setUint32(120,v.getUint32(sp+12,true),true);m.state().setUint32(100,0,true);
    m.execute();assert.equal(m.reg()[1],0);assert.equal(m.reg()[7]>>>0,RIGHT+8192);
    for(let i=0;i<8192;i+=4)assert.equal(v.getUint32(RIGHT+i,true),0x12345678);
}));

test('early REP results do not touch a following unmapped page, in either direction',async()=>use(m=>{
    const mem=m.guest();
    for(const backwards of [false,true])for(const op of ['cmps','scas'])for(const equal of [false,true]){
        m.paging();const src=LEFT+(backwards?0:4095),dst=RIGHT+(backwards?0:4095);mem[src]=7;mem[dst]=equal?8:7;
        m.map((LEFT>>>12)+(backwards?-1:1),0,0);m.map((RIGHT>>>12)+(backwards?-1:1),0,0);m.api.full_clear_tlb();
        const r=m.rep(op,1,src,dst,8192,{equal,backwards,value:7});
        assert.equal(r.ecx,8191);assert.equal(r.edi,dst+(backwards?-1:1));assert.equal(m.cpu.cr[2],0);
    }
}));

test('real user-access and write-protection faults cannot bypass REP translation',async()=>{
    for(const user of [false,true])await use(m=>{
        const mem=m.guest();mem.fill(173,RIGHT,RIGHT+4096);m.map(RIGHT>>>12,RIGHT>>>12,user?3:5);m.api.full_clear_tlb();m.installFaultGate(user);
        const hits=m.repStats();m.prepareRep(user?'scas':'stos',4,LEFT,RIGHT,256,{single:true,value:173,flags:0x3002});
        assert.equal(m.api.run_guest_until(FAULT,LEAF,1000,0,0),0);assert.equal(m.cpu.cr[2]>>>0,RIGHT);assert.equal(m.reg()[1],256);
        const v=new DataView(mem.buffer,mem.byteOffset);assert.equal(v.getUint32(m.reg()[4]>>>0,true),user?5:3);
        assert.ok(mem.subarray(RIGHT,RIGHT+4096).every(x=>x===173));assert.deepEqual(m.repStats(),hits);
    });
});

test('translated physical RAM and FS source offsets use the same intrinsics without identity assumptions',async()=>use(m=>{
    const mem=m.guest(),physicalA=LEFT+0x20000,physicalB=RIGHT+0x30000;
    m.map(LEFT>>>12,physicalA>>>12);m.map(RIGHT>>>12,physicalB>>>12);m.api.full_clear_tlb();mem.fill(7,physicalA,physicalA+1024);mem.fill(7,physicalB,physicalB+1024);
    const before=m.repStats();assert.equal(m.rep('cmps',1,LEFT,RIGHT,1024).ecx,0);assert.ok(m.repStats()[0]>before[0]);
    m.rep('stos',4,LEFT,RIGHT,256,{value:0x78787878});assert.ok(mem.subarray(physicalB,physicalB+1024).every(x=>x===0x78));
    m.cpu.segment_offsets[4]=0x10000;m.cpu.segment_is_null[4]=0;m.map((LEFT+0x10000)>>>12,physicalB>>>12);m.api.full_clear_tlb();
    const r=m.rep('cmps',1,LEFT,RIGHT,1024,{fs:true});assert.equal(r.ecx,0);assert.equal(r.esi,LEFT+1024);
}));

test('watched patterned REP stores preserve per-element callbacks and runtime rollback works',async()=>use(m=>{
    for(const size of [2,4])for(const backwards of [false,true]){
        m.api.dbg_set_write_watch(RIGHT+16);const before=m.repStats();
        m.rep('stos',size,LEFT,backwards?RIGHT+256-size:RIGHT,256/size,{backwards,value:0});
        assert.equal(m.repStats()[size===2?2:3],before[size===2?2:3]);assert.equal(m.api.dbg_ww_hits(),1);assert.equal(m.api.dbg_ww_zero_hits(),1);
    }
    m.api.dbg_set_write_watch(0);m.api.set_rep_memory_enabled(0);const before=m.repStats();
    m.rep('stos',4,LEFT,RIGHT,256,{value:47});assert.deepEqual(m.repStats(),before);
    m.api.set_rep_memory_enabled(1);m.rep('stos',4,LEFT,RIGHT,256,{value:47});assert.ok(m.repStats()[3]>before[3]);
}));

test('zero REP count and 16-bit address wrap preserve upper registers and fallbacks',async()=>use(m=>{
    for(const op of ['cmps','scas','stos'])for(const size of [1,2,4]){
        const before=m.repStats(),r=m.rep(op,size,0xffffffff,0xffffffff,0,{flags:0x8d7});
        assert.equal(r.ecx,0);assert.equal(r.esi,0xffffffff);assert.equal(r.edi,0xffffffff);assert.equal(r.flags,0x8d7);assert.deepEqual(m.repStats(),before);
    }
    m.cpu.segment_offsets[3]=LEFT;m.cpu.segment_offsets[0]=RIGHT;
    const mem=m.guest();mem.fill(65,LEFT,LEFT+65536);mem.fill(65,RIGHT,RIGHT+65536);
    const r=m.rep('cmps',2,0x1234fffc,0x5678fffc,0xabcd0004,{address16:true});
    assert.equal(r.esi,0x12340004);assert.equal(r.edi,0x56780004);assert.equal(r.ecx,0xabcd0000);
}));

test('real JIT REP loops preserve SSE/flags and invalidate overwritten translated code',async()=>use(async m=>{
    m.prepareRep('stos',4,LEFT,RIGHT,64,{value:47,iterations:250000});m.execute();
    for(let i=0;i<100&&!m.finalized;i++)await new Promise(r=>setTimeout(r,5));assert.ok(m.finalized>0);
    await new Promise(r=>setTimeout(r,10));m.api.set_rep_memory_enabled(0);const hits=m.repStats();
    m.prepareRep('stos',4,LEFT,RIGHT,64,{value:49,iterations:10000});m.execute();assert.deepEqual(m.repStats(),hits);
    m.api.set_rep_memory_enabled(1);const xmm=new Uint8Array(m.cpu.wasm_memory.buffer,824,132).slice();
    m.rep('stos',4,LEFT,RIGHT,64,{value:51,flags:0x8d7});assert.equal(m.cpu.get_eflags(),0x8d7);assert.deepEqual(new Uint8Array(m.cpu.wasm_memory.buffer,824,132),xmm);
    const probe=LEAF+0x1000+16,mem=m.guest(),v=new DataView(mem.buffer,mem.byteOffset);
    mem.fill(0x90,probe-1,probe+64);mem[probe-1]=0xb8;v.setUint32(probe,0x11111111,true);mem[probe+64]=0xc3;
    function invoke(n){m.prepareRep('stos',4,LEFT,RIGHT,1,{iterations:n});m.reg()[5]=probe-1;return m.execute();}
    const compiled=m.finalized;assert.equal(invoke(250000)>>>0,0x11111111);
    for(let i=0;i<100&&m.finalized===compiled;i++)await new Promise(r=>setTimeout(r,5));assert.ok(m.finalized>compiled);assert.equal(invoke(1000)>>>0,0x11111111);
    m.rep('stos',4,LEFT,probe,16,{value:0x90909090});assert.equal(invoke(1)>>>0,0x90909090);assert.equal(m.hostCalls,0);
},{jit:true}));

test('REP intrinsics remain valid after actual WASM memory growth',async()=>use(m=>{
    const old=m.guest().buffer;m.cpu.wasm_memory.grow(1);assert.notEqual(m.guest().buffer,old);
    m.guest().fill(79,RIGHT,RIGHT+8192);assert.equal(m.rep('scas',1,LEFT,RIGHT,8192,{value:79}).ecx,0);
    m.rep('stos',4,LEFT,RIGHT,2048,{value:0x31313131});assert.ok(m.guest().subarray(RIGHT,RIGHT+8192).every(x=>x===49));assert.ok(m.repStats()[3]>0);
}));
