import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createMachine,LEFT,RIGHT,LEAF,ENTRY} from './bulk-machine.mjs';
const binary=readFileSync(process.env.V86_TEST_BINARY||new URL('../../public/v86.wasm',import.meta.url));

test('a writable supervisor-only resident page cannot bypass CPL3 access checks',async()=>{
    const m=await createMachine(binary);
    try{
        m.paging();m.guest().fill(47,LEFT,LEFT+64);m.guest().fill(173,RIGHT,RIGHT+64);
        m.map(RIGHT>>>12,RIGHT>>>12,3);m.api.full_clear_tlb();
        m.warm(LEFT,64);m.warm(RIGHT,64,true); // writable TLB entry, not a read-only guard rejection
        m.cpu.cpl[0]=3;m.state().setUint32(120,0x3002,true);m.state().setUint32(100,0,true);
        m.call('memmove',RIGHT,LEFT,64);
        assert.equal(m.hostCalls,1);assert.ok(m.guest().subarray(RIGHT,RIGHT+64).every(x=>x===173));
        m.cpu.cpl[0]=0;m.call('memmove',RIGHT,LEFT,64);
        assert.equal(m.hostCalls,1);assert.ok(m.guest().subarray(RIGHT,RIGHT+64).every(x=>x===47));
    }finally{m.close();}
});

test('copying over a JIT-compiled thunk falls back and invalidates the old code',async()=>{
    const m=await createMachine(binary,{jit:true});
    try{
        m.paging();m.warm(ENTRY,4096,true);m.warm(LEAF,4096,true);
        m.warm(LEFT,4096,true);m.warm(RIGHT,4096,true);
        m.call('memcpy',RIGHT,LEFT,64,250000);
        for(let i=0;i<100&&!m.finalized;i++)await new Promise(r=>setTimeout(r,5));
        m.call('memcpy',RIGHT,LEFT,64,10000);
        await new Promise(r=>setTimeout(r,20));
        assert.ok(m.finalized>0);
        const mem=m.guest();mem.set(mem.slice(LEAF+1,LEAF+65),LEFT);
        new DataView(mem.buffer,mem.byteOffset).setUint32(LEFT,2,true); // MOV EAX,2 in thunk
        const hp=m.api.get_hypercall_page_ptr()>>>0;
        new Uint8Array(m.cpu.wasm_memory.buffer)[hp+0x102]=57; // function2 is memset
        const before=m.stats();m.call('memcpy',LEAF+1,LEFT,64);
        assert.equal(m.stats()[0],before[0]);assert.ok(m.stats()[5]>before[5]);
        m.call('memcpy',RIGHT,49,64); // rewritten guest thunk must now call memset
        assert.ok(m.guest().subarray(RIGHT,RIGHT+64).every(x=>x===49));
        assert.equal(m.hostCalls,0);
    }finally{m.close();}
});
