import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { V86 } from '../../vendor/v86/build/libv86.mjs';

// Exercise emitted Wasm, including both sides of the thunk/ROM exclusion and
// loads crossing its boundaries. Nonidentity mappings in excluded regions make
// an accidentally admitted fast read return observably wrong bytes.
const RAM = 0x26000000, BASE = 0x200000, ENTRY = BASE + 0x40;
const LEAF = BASE + 0x1000, DONE = BASE + 0x80, STACK = 0x300000;
const OUTPUT = 0x400000, LOW = 0x100000, GUARD = 0x23000000, END = 0x24000000;
const PD = 0x80000, PT = 0x1000000, ALIAS = 0x900000;
const binary = await readFile(process.env.V86_TEST_BINARY ?? new URL('../../public/v86.wasm', import.meta.url));

test('fast reads preserve width, range boundaries, slow mappings and generation invalidation', async () => {
    const image = new Uint8Array(0x2000), header = new DataView(image.buffer);
    [0x1badb002, 0x10000, -(0x1badb002 + 0x10000), BASE, BASE, BASE + image.length,
        BASE + image.length, ENTRY].forEach((v, i) => header.setUint32(i * 4, v >>> 0, true));
    image.set([0xe8, 0, 0, 0, 0, 0x4f, 0x75, 0xf8, 0xe9], 0x40);
    header.setInt32(0x41, LEAF - ENTRY - 5, true);
    header.setInt32(0x49, DONE - ENTRY - 13, true);
    image.set([0xeb, 0xfe], 0x80);
    const emulator = new V86({ memory_size: RAM, autostart: false,
        wasm_fn: async imports => (await WebAssembly.instantiate(binary, imports)).instance.exports });
    await new Promise(resolve => emulator.add_listener('emulator-loaded', resolve));
    const cpu = emulator.v86.cpu, api = cpu.wm.exports;
    try {
        cpu.reboot_internal(); cpu.reset_memory(); cpu.load_multiboot(image.buffer);
        const mem = cpu.mem8, view = new DataView(mem.buffer, mem.byteOffset);
        const state = new DataView(cpu.wasm_memory.buffer), reg = cpu.reg32;
        const map = (virtual, physical) => view.setUint32(PT + (virtual >>> 12) * 4, physical | 7, true);
        for (let p = 0; p <= RAM; p += 4096) map(p, p);
        for (let p = 0; p <= RAM >>> 22; p++) view.setUint32(PD + p * 4, (PT + p * 4096) | 7, true);
        const aliases = new Map([[LOW - 4096, ALIAS], [GUARD, ALIAS + 4096],
            [END - 4096, ALIAS + 8192], [RAM, ALIAS + 12288]]);
        for (const [virtual, physical] of aliases) map(virtual, physical);
        cpu.cr[3] = PD; cpu.cr[0] |= 0x80010000; api.full_clear_tlb(); cpu.update_state_flags();
        api.set_jit_config(9, 1); api.set_jit_config(18, 1);
        const physical = address => (aliases.get(address & ~4095) ?? (address & ~4095)) + (address & 4095);
        const invoke = (address, count) => {
            reg[4] = STACK; reg[6] = address; reg[7] = count; reg[2] = OUTPUT;
            state.setUint32(556, ENTRY, true); cpu.in_hlt[0] = 0;
            assert.equal(api.run_guest_until(DONE, 0, 10_000_000, 0, 0), 0);
            assert.equal(reg[4], STACK); assert.equal(reg[7], 0);
        };
        for (const width of [1, 2, 4, 8, 16]) {
            const instructions = width === 1 ? [0x0f, 0xb6, 0x06, 0x89, 0x02]
                : width === 2 ? [0x0f, 0xb7, 0x06, 0x89, 0x02]
                : width === 4 ? [0x8b, 0x06, 0x89, 0x02]
                : width === 8 ? [0xf3, 0x0f, 0x7e, 0x06, 0x66, 0x0f, 0xd6, 0x02]
                : [0xf3, 0x0f, 0x6f, 0x06, 0xf3, 0x0f, 0x7f, 0x02];
            mem.fill(0x90, LEAF, LEAF + 64); mem.set([...instructions, 0xc3], LEAF);
            cpu.jit_clear_cache();
            const compiledBefore = api.fastmem_get_speculated_loads_compiled();
            invoke(LOW, 150000);
            // Native compilation is asynchronous. Await an actual installed
            // module before running the boundary cases against the JIT.
            const deadline = Date.now() + 10000;
            while (!api.jit_snapshot_cache()) {
                assert.ok(Date.now() < deadline, 'JIT module must install');
                await new Promise(resolve => setTimeout(resolve, 5));
                invoke(LOW, 150000);
            }
            assert.ok(api.fastmem_get_speculated_loads_compiled() > compiledBefore,
                `width ${width} emitted fast read code`);
            for (const boundary of [LOW, GUARD, END, RAM]) {
                for (const delta of [-width, -width + 1, -1, 0, 1]) {
                    const address = boundary + delta;
                    // Give the identity location different bytes from its alias.
                    for (let i = 0; i < width; i++) {
                        if (address + i < RAM) mem[address + i] = 0x11;
                        mem[physical(address + i)] = (i * 37 + width * 13) & 255;
                    }
                    const expected = Array.from({ length: width }, (_, i) => mem[physical(address + i)]);
                    invoke(address, 2000);
                    assert.deepEqual(Array.from(mem.subarray(OUTPUT, OUTPUT + width)), expected,
                        `width ${width}, address 0x${address.toString(16)}`);
                }
            }
        }
        const before = api.fastmem_get_deopt_recompiles();
        api.fastmem_bump_generation(0);
        invoke(LOW, 2000);
        assert.ok(api.fastmem_get_deopt_recompiles() > before, 'generation change invalidates generated fast reads');

        // The last leaf reads 16 bytes. Crossing an excluded, unmapped page
        // must report a guest page fault at that instruction, not a host trap
        // or a partial/identity read. Install a real guest #PF interrupt gate.
        const GDT = 0x70000, IDT = 0x71000, FAULT = BASE + 0x300;
        mem.set([255, 255, 0, 0, 0, 0x9a, 0xcf, 0], GDT + 8);
        cpu.gdtr_offset[0] = GDT; cpu.gdtr_size[0] = 15; cpu.sreg[1] = 8;
        const gate = IDT + 14 * 8;
        view.setUint16(gate, FAULT & 65535, true); view.setUint16(gate + 2, 8, true);
        view.setUint16(gate + 4, 0x8e00, true); view.setUint16(gate + 6, FAULT >>> 16, true);
        cpu.idtr_offset[0] = IDT; cpu.idtr_size[0] = 2047; cpu.update_state_flags();
        for (const address of [LOW - 1, GUARD - 1, END - 1, RAM - 1]) {
            const excluded = address < LOW ? LOW - 4096 : address < GUARD ? GUARD : address < END ? END - 4096 : RAM;
            view.setUint32(PT + (excluded >>> 12) * 4, 0, true); api.full_clear_tlb();
            reg[4] = STACK; reg[6] = address; reg[2] = OUTPUT;
            state.setUint32(556, LEAF, true); cpu.in_hlt[0] = 0;
            assert.equal(api.run_guest_until(FAULT, 0, 100000, 0, 0), 0, 'guest fault handler reached');
            assert.equal(view.getUint32((reg[4] >>> 0) + 4, true), LEAF, 'fault reports the faulting load');
            assert.equal(cpu.cr[2] >>> 12, excluded >>> 12, 'fault reports the missing page');
            map(excluded, aliases.get(excluded)); api.full_clear_tlb();
        }
    } finally { emulator.destroy(); }
});
