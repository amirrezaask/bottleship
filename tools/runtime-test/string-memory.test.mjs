import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createMachine,LEFT,RIGHT,RAM,PT,LEAF,ENTRY,STACK} from './bulk-machine.mjs';
const binary=readFileSync(process.env.V86_TEST_BINARY||new URL('../../public/v86.wasm',import.meta.url));
async function use(fn,options){
    const m=await createMachine(binary,options);
    try{assert.equal(m.api.get_string_memory_abi(),1);m.paging();await fn(m);}finally{m.close();}
}
function store(m,ptr,values,wide=false){
    const mem=m.guest(),v=new DataView(mem.buffer,mem.byteOffset),stride=wide?2:1;
    values.forEach((x,i)=>wide?v.setUint16(ptr+i*2,x,true):mem[ptr+i]=x);
    if(wide)v.setUint16(ptr+values.length*2,0,true);else mem[ptr+values.length]=0;
    m.warm(ptr,(values.length+1)*stride);
}
const lower=x=>x>=65&&x<=90?x+32:x;
const diff=(a,b,fold=false)=>{
    for(let i=0;;i++){
        const x=a[i]??0,y=b[i]??0,d=(fold?lower(x):x)-(fold?lower(y):y);
        if(d||!x)return d;
    }
};

test('native lengths and copies match scalar handlers across SIMD tails and odd page boundaries',async()=>use(m=>{
    for(const wide of [false,true])for(const offset of [0,1,7,15,4093])for(const length of [0,1,7,8,15,16,17,31,32,33,255,4095,4096,4097,65535]){
        const a=LEFT+offset,b=RIGHT+offset+5,stride=wide?2:1;
        const values=Array.from({length},(_,i)=>wide?1+((i*331)%65535):1+((i*79)%255));
        store(m,a,values,wide);const bytes=(length+1)*stride;
        const op=wide?'wcslen':'strlen',copy=wide?'wcscpy':'strcpy';
        m.api.set_string_memory_enabled(0);assert.equal(m.call(op,a,0,0),length);
        m.api.set_string_memory_enabled(1);assert.equal(m.call(op,a,0,0),length);
        const mem=m.guest();mem.fill(173,b-1,b+bytes+1);m.warm(b,bytes,true);
        assert.equal(m.call(copy,b,a,0)>>>0,b);
        assert.deepEqual(mem.slice(b,b+bytes),mem.slice(a,a+bytes));
        assert.equal(mem[b-1],173);assert.equal(mem[b+bytes],173);
    }
    assert.equal(m.hostCalls,0);for(const i of [0,1,8,9])assert.ok(m.stringStats()[i]>0);
}));

test('SIMD comparisons preserve exact unsigned differences, ASCII folding and the earliest NUL',async()=>use(m=>{
    for(const wide of [false,true])for(const offset of [0,1,4093])for(const length of [0,1,8,16,17,31,64,4097]){
        const a=LEFT+offset,b=RIGHT+offset+5;
        const values=Array.from({length},(_,i)=>[65,90,97,122,91,64,127,128,255,...(wide?[256,0x8000,0xd800,0xffff]:[])][i%(wide?13:9)]);
        for(const op of wide?['wcsicmp']:['strcmp','stricmp']){
            const folded=op!=='strcmp';
            for(const pos of new Set([0,7,8,15,16,Math.max(0,length-1),length])){
                const other=[...values];if(pos<length)other[pos]=values[pos]===1?2:1;
                store(m,a,values,wide);store(m,b,other,wide);
                const expected=diff(values,other,folded);
                m.api.set_string_memory_enabled(0);assert.equal(m.call(op,a,b,0),expected);
                m.api.set_string_memory_enabled(1);assert.equal(m.call(op,a,b,0),expected);
            }
            store(m,a,values,wide);store(m,b,folded?values.map(lower):values,wide);
            // Different bytes after the first terminator must not affect a vector result.
            m.guest().fill(9,a+(length+1)*(wide?2:1),a+(length+1)*(wide?2:1)+32);
            m.guest().fill(17,b+(length+1)*(wide?2:1),b+(length+1)*(wide?2:1)+32);
            assert.equal(m.call(op,a,b,0),0);
        }
    }
    assert.equal(m.hostCalls,0);for(const i of [2,3,4])assert.ok(m.stringStats()[i]>0);
}));

test('all nonzero UTF-16 code units are counted as units rather than bytes',async()=>use(m=>{
    const values=Array.from({length:65535},(_,i)=>i+1);
    store(m,LEFT+1,values,true);store(m,RIGHT+3,values,true);
    assert.equal(m.call('wcslen',LEFT+1,0,0),65535);
    assert.equal(m.call('wcsicmp',LEFT+1,RIGHT+3,0),0);
    for(const target of [1,65,256,0x8000,0xd800,0xffff,0])
        assert.equal(m.call('wcschr',LEFT+1,target,0)>>>0,LEFT+1+(target?target-1:65535)*2);
    assert.equal(m.hostCalls,0);
}));

test('first and last character searches mask matches after NUL and truncate byte targets',async()=>use(m=>{
    for(const offset of [0,1,7,4093])for(let zero=0;zero<65;zero++){
        const at=LEFT+offset,values=Array.from({length:zero},(_,i)=>i%3?65:255);
        store(m,at,values);m.guest().fill(255,at+zero+1,at+zero+33);
        for(const arg of [-1,255,511,65,66,0,256]){
            const target=arg&255,first=target===0?zero:values.indexOf(target),last=target===0?zero:values.lastIndexOf(target);
            assert.equal(m.call('strchr',at,arg,0)>>>0,first<0?0:at+first);
            assert.equal(m.call('strrchr',at,arg,0)>>>0,last<0?0:at+last);
        }
    }
    assert.equal(m.hostCalls,0);assert.ok(m.stringStats()[5]>0&&m.stringStats()[6]>0);
}));

test('early results never probe an unmapped following page or set its accessed/dirty bits',async()=>use(m=>{
    const a=LEFT+4096-33,b=RIGHT+4096-33;
    store(m,a,Array(32).fill(65));store(m,b,Array(32).fill(65));
    m.map((LEFT>>>12)+1,(LEFT>>>12)+1,0);m.map((RIGHT>>>12)+1,(RIGHT>>>12)+1,0);
    const mem=m.guest(),v=new DataView(mem.buffer,mem.byteOffset),pte=PT+((LEFT>>>12)+1)*4;
    const before=v.getUint32(pte,true),misses=m.stringStats()[10];
    assert.equal(m.call('strlen',a,0,0),32);assert.equal(m.call('strcmp',a,b,0),0);
    assert.equal(m.call('strchr',a,65,0)>>>0,a);assert.equal(m.call('strrchr',a,65,0)>>>0,a+31);
    assert.equal(m.call('strrchr',a,0,0)>>>0,a+32);
    assert.equal(m.stringStats()[10],misses);assert.equal(v.getUint32(pte,true),before);
    assert.equal(m.state().getUint8(540),0);assert.equal(m.hostCalls,0);
    // A wide terminator occupies the final two bytes of the valid page.
    store(m,LEFT+4096-34,Array(16).fill(0x100),true);
    assert.equal(m.call('wcslen',LEFT+4096-34,0,0),16);
    assert.equal(m.call('wcschr',LEFT+4096-34,0,0)>>>0,LEFT+4094);
    assert.equal(v.getUint32(pte,true),before);
}));

test('cold, remapped, denied-user and invalid spans use fallback without speculative guest faults',async()=>use(m=>{
    let calls=m.hostCalls;
    // These new-handler fallbacks only record; no JS exception behavior is claimed.
    for(const p of [LEFT,0x90000,0xfffffff0,RAM]){
        m.call('strchr',p,65,0);assert.equal(m.hostCalls,++calls);
        assert.equal(m.state().getUint8(540),0);
    }
    store(m,LEFT,[65,66]);assert.equal(m.call('strchr',LEFT,65,0)>>>0,LEFT);
    m.map(LEFT>>>12,(LEFT>>>12)+1,7);m.api.full_clear_tlb();m.warm(LEFT,16);
    m.call('strchr',LEFT,65,0);assert.equal(m.hostCalls,++calls);
    m.paging();store(m,LEFT,[65]);m.map(LEFT>>>12,LEFT>>>12,3);m.api.full_clear_tlb();m.warm(LEFT,16);
    m.cpu.cpl[0]=3;m.state().setUint32(120,0x3002,true);m.state().setUint32(100,0,true);
    m.call('strchr',LEFT,65,0);assert.equal(m.hostCalls,++calls);assert.equal(m.state().getUint8(540),0);
    m.cpu.cpl[0]=0;assert.equal(m.call('strchr',LEFT,65,0)>>>0,LEFT);
    m.api.set_string_memory_enabled(0);m.call('strchr',LEFT,65,0);assert.equal(m.hostCalls,++calls);
    m.api.set_string_memory_enabled(1);m.api.set_bulk_memory_enabled(0);
    m.call('strchr',LEFT,65,0);assert.equal(m.hostCalls,++calls);
    m.api.set_bulk_memory_enabled(1);assert.equal(m.call('strchr',LEFT,65,0)>>>0,LEFT);
}));

test('unterminated strings leave later-page fault handling to fallback',async()=>use(m=>{
    const mem=m.guest();mem.fill(65,LEFT,LEFT+4096);m.warm(LEFT,4096);
    m.map((LEFT>>>12)+1,(LEFT>>>12)+1,0);
    const v=new DataView(mem.buffer,mem.byteOffset),pte=PT+((LEFT>>>12)+1)*4,before=v.getUint32(pte,true);
    m.call('strrchr',LEFT,65,0);assert.equal(m.hostCalls,1);
    assert.equal(m.state().getUint8(540),0);assert.equal(v.getUint32(pte,true),before);
    const stats=m.stringStats();
    // Guard exercise via an unterminated narrow string at RAM's final byte.
    mem[RAM-1]=65;m.warm(RAM-1,1);m.call('strrchr',RAM-1,65,0);
    assert.equal(m.hostCalls,2);assert.equal(m.stringStats()[6],stats[6]);
    assert.equal(m.state().getUint8(540),0);
}));

test('cold to warm transitions, memory growth and state preservation remain correct',async()=>use(m=>{
    const mem=m.guest();mem.fill(65,LEFT,LEFT+200);mem[LEFT+200]=0;
    const before=m.stringStats();assert.equal(m.call('strlen',LEFT,0,0),200);
    assert.equal(m.stringStats()[0],before[0]);assert.ok(m.stringStats()[10]>before[10]);
    assert.equal(m.call('strlen',LEFT,0,0),200);assert.ok(m.stringStats()[0]>before[0]);
    const old=m.cpu.wasm_memory.buffer;m.cpu.wasm_memory.grow(1);assert.notStrictEqual(old,m.cpu.wasm_memory.buffer);
    m.warm(RIGHT,201,true);
    const xmm=new Uint8Array(m.cpu.wasm_memory.buffer,832,128);xmm.fill(173);const saved=xmm.slice();
    for(const op of ['strlen','strcpy']){
        m.reg()[3]=0x12345678;m.reg()[5]=0x23456789;m.reg()[6]=0x3456789a;
        const args=op==='strlen'?[LEFT,0,0]:[RIGHT,LEFT,0];
        m.api.set_string_memory_enabled(0);m.state().setUint32(120,0x202,true);m.state().setUint32(100,0,true);m.call(op,...args);
        const flags=m.cpu.get_eflags();
        m.api.set_string_memory_enabled(1);m.state().setUint32(120,0x202,true);m.state().setUint32(100,0,true);m.call(op,...args);
        assert.equal(m.cpu.get_eflags(),flags);assert.equal(m.reg()[3],0x12345678);assert.equal(m.reg()[5],0x23456789);assert.equal(m.reg()[6],0x3456789a);
        assert.equal(m.reg()[4],STACK);assert.deepEqual(new Uint8Array(m.cpu.wasm_memory.buffer,832,128),saved);
    }
    assert.equal(m.hostCalls,0);
}));

test('overlapping string copies and active write watches retain scalar copy behavior',async()=>use(m=>{
    for(const wide of [false,true]){
        const a=LEFT+64,b=a-(wide?2:1),op=wide?'wcscpy':'strcpy',index=wide?9:8;
        const values=Array.from({length:127},(_,i)=>65+i%26);store(m,a,values,wide);m.warm(b,300,true);
        const before=m.stringStats();assert.equal(m.call(op,b,a,0)>>>0,b);
        assert.equal(m.stringStats()[index],before[index]);assert.ok(m.stringStats()[10]>before[10]);
        assert.equal(m.call(wide?'wcslen':'strlen',b,0,0),127);
        store(m,a,values,wide);m.warm(RIGHT,300,true);m.api.dbg_set_write_watch(RIGHT);
        const stats=m.stringStats();m.call(op,RIGHT,a,0);m.api.dbg_set_write_watch(0);
        assert.equal(m.stringStats()[index],stats[index]);assert.equal(m.call(wide?'wcslen':'strlen',RIGHT,0,0),127);
    }
    assert.equal(m.hostCalls,0);
}));

test('historical unterminated-string cap is retained instead of introducing an unbounded scan',async()=>use(m=>{
    const limit=0x100001;const mem=m.guest();mem.fill(65,LEFT,LEFT+limit+32);m.warm(LEFT,limit+32);
    const before=m.stringStats();assert.equal(m.call('strlen',LEFT,0,0),limit);
    assert.equal(m.stringStats()[0],before[0]);assert.ok(m.stringStats()[10]>before[10]);assert.equal(m.hostCalls,0);
}));

test('JIT-warmed string calls stay inside WASM and compiled-code writes still invalidate JIT code',async()=>use(async m=>{
    store(m,LEFT,Array(128).fill(65));m.warm(RIGHT,4096,true);m.warm(ENTRY,4096,true);m.warm(LEAF,4096,true);
    m.call('strcpy',RIGHT,LEFT,0,250000);
    for(let i=0;i<100&&!m.finalized;i++)await new Promise(r=>setTimeout(r,5));
    m.call('strcpy',RIGHT,LEFT,0,10000);await new Promise(r=>setTimeout(r,20));assert.ok(m.finalized>0);
    assert.equal(m.call('strcmp',RIGHT,LEFT,0,1000),0);assert.equal(m.hostCalls,0);
    const before=m.stringStats();store(m,LEFT,[2]);
    const hp=m.api.get_hypercall_page_ptr()>>>0;new Uint8Array(m.cpu.wasm_memory.buffer)[hp+0x102]=57;
    m.call('strcpy',LEAF+1,LEFT,0); // Change MOV EAX,1 into MOV EAX,2.
    assert.equal(m.stringStats()[8],before[8]);assert.ok(m.stringStats()[10]>before[10]);
    m.call('strcpy',RIGHT,49,64);assert.ok(m.guest().subarray(RIGHT,RIGHT+64).every(x=>x===49));
    assert.equal(m.hostCalls,0);
},{jit:true}));
