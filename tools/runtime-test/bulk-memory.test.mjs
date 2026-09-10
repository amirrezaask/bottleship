import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMachine, LEFT, RIGHT, RAM, STACK, ENTRY, LEAF, DONE, PT } from './bulk-machine.mjs';
const binary = readFileSync(process.env.V86_TEST_BINARY || new URL('../../public/v86.wasm', import.meta.url));
async function use(fn, options) {
    const m = await createMachine(binary, options);
    try { assert.equal(m.api.get_bulk_memory_abi(), 1); m.paging(); await fn(m); }
    finally { m.close(); }
}
function pattern(mem, at, len) { for (let i = 0; i < len; i++) mem[at + i] = ((i * 79) ^ (i >>> 3)) & 255; }

test('bulk copy/fill/compare are exact at unaligned offsets, vector tails and page crossings', async () => use(m => {
    const sizes = [0, 1, 15, 16, 17, 63, 64, 65, 255, 256, 4095, 4096, 4097, 65537];
    for (const len of sizes) for (const offset of [0, 1, 7, 4093]) {
        const src = LEFT + offset, dst = RIGHT + offset + 2, mem = m.guest();
        pattern(mem, src, len); mem.fill(173, dst - 1, dst + len + 1);
        m.warm(src, len); m.warm(dst, len, true);
        assert.equal(m.call('memcpy', dst, src, len) >>> 0, dst);
        assert.deepEqual(mem.slice(dst, dst + len), mem.slice(src, src + len));
        assert.equal(mem[dst - 1], 173); assert.equal(mem[dst + len], 173);
        assert.equal(m.call('memcmp', dst, src, len), 0);
        for (const pos of new Set([0, 15, 16, Math.max(0, len - 1)])) if (pos < len) {
            const old = mem[dst + pos]; mem[dst + pos] ^= 255;
            assert.equal(m.call('memcmp', dst, src, len), mem[dst + pos] - mem[src + pos]);
            mem[dst + pos] = old;
        }
        assert.equal(m.call('memset', dst, 0x123456ad, len) >>> 0, dst);
        assert.ok(mem.subarray(dst, dst + len).every(x => x === 173));
    }
    assert.equal(m.hostCalls, 0);
    assert.ok(m.stats().slice(0, 3).every(n => n > 0));
}));

test('memmove handles forward/backward overlap and memchr returns the first unsigned byte', async () => use(m => {
    for (const delta of [-31, -1, 0, 1, 31]) for (const len of [1, 15, 17, 64, 4099, 65536]) {
        const src = LEFT + 64, dst = src + delta, mem = m.guest();
        pattern(mem, LEFT, len + 128); const expected = mem.slice(src, src + len);
        m.warm(LEFT, len + 128, true);
        assert.equal(m.call('memmove', dst, src, len) >>> 0, dst);
        assert.deepEqual(mem.slice(dst, dst + len), expected);
    }
    for (const offset of [0, 1, 4093]) for (const len of [1, 15, 16, 17, 64, 4099]) {
        const src = LEFT + offset, mem = m.guest(); mem.fill(0, src, src + len); m.warm(src, len);
        assert.equal(m.call('memchr', src, 255, len), 0);
        for (const pos of new Set([0, Math.min(15, len - 1), len - 1])) {
            mem[src + pos] = 255;
            assert.equal(m.call('memchr', src, -1, len) >>> 0, src + pos);
            mem[src + pos] = 0;
        }
    }
    assert.equal(m.call('memmove', 0, 0, 0), 0);
    assert.equal(m.call('memchr', 0, 0, 0), 0);
    assert.equal(m.hostCalls, 0);
    assert.ok(m.stats()[3] > 0 && m.stats()[4] > 0);
}));

test('guard misses do not partially write, fault speculatively, or set later page-table A/D bits', async () => use(m => {
    const mem = m.guest(); mem.fill(31, LEFT, LEFT + 8192); mem.fill(173, RIGHT, RIGHT + 8192);
    m.warm(LEFT, 8192); m.warm(RIGHT, 4096, true);
    m.map((RIGHT >>> 12) + 1, (RIGHT >>> 12) + 1, 0);
    const before = mem.slice(RIGHT, RIGHT + 8192), calls = m.hostCalls;
    const pte = PT + ((RIGHT >>> 12) + 1) * 4;
    const view = new DataView(mem.buffer, mem.byteOffset), flags = view.getUint32(pte, true);
    m.call('memmove', RIGHT, LEFT, 8192);
    assert.equal(m.hostCalls, calls + 1); // host fallback deliberately records but does not execute
    assert.deepEqual(mem.slice(RIGHT, RIGHT + 8192), before);
    assert.equal(view.getUint32(pte, true), flags);
    assert.equal(m.state().getUint8(540), 0);
    for (const flags of [5, 3]) {
        m.map(RIGHT >>> 12, RIGHT >>> 12, flags); m.api.full_clear_tlb();
        m.cpu.cpl[0] = 0; m.warm(RIGHT, 4096); m.warm(LEFT, 4096);
        if (flags === 3) m.cpu.cpl[0] = 3;
        m.state().setUint32(120, 0x3002, true); m.state().setUint32(100, 0, true);
        const n = m.hostCalls;
        m.call('memmove', RIGHT, LEFT, 64);
        assert.equal(m.hostCalls, n + 1); assert.deepEqual(mem.slice(RIGHT, RIGHT + 8192), before);
        m.cpu.cpl[0] = 0;
    }
}));

test('remapped, low-memory, cold, overflow and watched spans retain fallback', async () => use(m => {
    let n = m.hostCalls;
    for (const [dst, src, len] of [[RIGHT, LEFT, 64], [0x90000, LEFT, 64], [RIGHT, 0xfffffff0, 64], [RAM - 32, LEFT, 64]]) {
        m.call('memmove', dst, src, len); assert.equal(m.hostCalls, ++n);
    }
    m.map(RIGHT >>> 12, (RIGHT >>> 12) + 1, 7); m.api.full_clear_tlb();
    m.warm(LEFT, 64); m.warm(RIGHT, 64, true);
    m.call('memmove', RIGHT, LEFT, 64); assert.equal(m.hostCalls, ++n);
    m.paging(); m.warm(LEFT, 64); m.warm(RIGHT, 64, true);
    m.api.dbg_set_write_watch(RIGHT);
    m.call('memmove', RIGHT, LEFT, 64); assert.equal(m.hostCalls, ++n);
    m.api.dbg_set_write_watch(0);
    m.api.set_bulk_memory_enabled(0);
    m.call('memmove', RIGHT, LEFT, 64); assert.equal(m.hostCalls, ++n);
    m.api.set_bulk_memory_enabled(1);
    m.call('memmove', RIGHT, LEFT, 64); assert.equal(m.hostCalls, n);
}));

test('memcmp/memchr early results do not inspect the next unmapped page', async () => use(m => {
    const a = LEFT + 4093, b = RIGHT + 4093, mem = m.guest();
    mem[a] = 128; mem[b] = 7; m.warm(a, 3); m.warm(b, 3);
    m.map((LEFT >>> 12) + 1, 0, 0); m.map((RIGHT >>> 12) + 1, 0, 0);
    assert.equal(m.call('memcmp', a, b, 65536), 121);
    assert.equal(m.call('memchr', a, 128, 65536) >>> 0, a);
    assert.equal(m.hostCalls, 0); assert.equal(m.state().getUint8(540), 0);
}));

test('hot translated CALL/OUT/RET loops preserve CPU state and code-page invalidation', async () => use(async m => {
    m.guest().fill(47, LEFT, LEFT + 4096); m.warm(LEFT, 4096); m.warm(RIGHT, 4096, true);
    m.warm(ENTRY, 4096, true); m.warm(LEAF, 4096, true);
    m.call('memcpy', RIGHT, LEFT, 64, 250000);
    for (let i = 0; i < 100 && m.finalized === 0; i++) await new Promise(r => setTimeout(r, 5));
    assert.ok(m.finalized > 0, 'a real JIT module must have finalized');
    m.call('memcpy', RIGHT, LEFT, 4096, 2000);
    assert.equal(m.hostCalls, 0); assert.equal(m.reg()[4], STACK); assert.equal(m.reg()[7], 0);
    assert.ok(m.stats()[0] >= 2000);
    const before = m.stats(), calls = m.hostCalls;
    m.call('memmove', ENTRY + 512, LEFT, 64);
    assert.equal(m.hostCalls, calls + 1); assert.equal(m.stats()[3], before[3]);
}, { jit: true }));

test('cold memcpy fills translations then uses bulk; memcpy overlap preserves the old path', async () => use(m => {
    const mem = m.guest(); pattern(mem, LEFT, 512); const before = m.stats();
    assert.equal(m.call('memcpy', RIGHT, LEFT, 256), RIGHT);
    assert.equal(m.stats()[0], before[0]); assert.ok(m.stats()[5] > before[5]);
    assert.equal(m.call('memcpy', RIGHT, LEFT, 256), RIGHT);
    assert.equal(m.stats()[0], before[0] + 1);
    m.warm(LEFT, 512, true);
    const expected = mem.slice(LEFT, LEFT + 512);
    for (let i = 0; i < 64; i += 4) expected.set(expected.slice(i, i + 4), i + 4);
    const hits = m.stats()[0]; m.call('memcpy', LEFT + 4, LEFT, 64);
    assert.equal(m.stats()[0], hits); assert.deepEqual(mem.slice(LEFT, LEFT + 512), expected);
    assert.equal(m.hostCalls, 0);
}));

test('a single leaf preserves nonvolatile registers, SSE state and EFLAGS', async () => use(m => {
    const mem=m.guest(), dv=new DataView(mem.buffer,mem.byteOffset);
    m.warm(LEFT,256,true); m.warm(RIGHT,256,true);
    for(const name of ['memcpy','memset','memcmp','memmove','memchr']) {
        m.prepare(name, RIGHT, name==='memset'||name==='memchr'?173:LEFT,256);
        dv.setUint32(STACK-4,DONE,true); m.reg()[4]=STACK-4;
        for(const r of [3,5,6,7])m.reg()[r]=0x13570000+r;
        m.state().setUint32(556,LEAF,true);
        m.state().setUint32(120,0x8d7,true); m.state().setUint32(100,0,true);
        const before=m.cpu.get_eflags(), simd=new Uint8Array(m.cpu.wasm_memory.buffer,824,132).slice();
        m.execute();
        assert.equal(m.reg()[4],STACK); assert.equal(m.cpu.get_eflags(),before);
        for(const r of [3,5,6,7])assert.equal(m.reg()[r],0x13570000+r);
        assert.deepEqual(new Uint8Array(m.cpu.wasm_memory.buffer,824,132),simd);
    }
}));

test('growing core memory does not retain stale guest pointers or statistics views', async () => use(m => {
    const old=m.guest().buffer; m.cpu.wasm_memory.grow(1);
    assert.notEqual(m.guest().buffer,old);
    m.guest().fill(89,LEFT,LEFT+256); m.warm(LEFT,256); m.warm(RIGHT,256,true);
    assert.equal(m.call('memmove',RIGHT,LEFT,256),RIGHT);
    assert.ok(m.guest().subarray(RIGHT,RIGHT+256).every(x=>x===89));
    assert.ok(m.stats()[3]>0); assert.equal(m.hostCalls,0);
}));
