import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createMachine, BASE, LEAF, DONE } from './bulk-machine.mjs';

test('a compiled conditional backedge across pages is counted exactly once', async () => {
    const binary = await readFile(process.env.V86_TEST_BINARY ?? new URL('../../public/v86.wasm', import.meta.url));
    const m = await createMachine(binary, { jit: true });
    const loop = BASE + 0xfe0, branch = LEAF;
    const blocks = () => {
        const count = m.api.trace2_block_snapshot(), result = new Map();
        for (let i = 0; i < count; i++) result.set(m.api.trace2_block_addr(i) >>> 0, m.api.trace2_block_exec_u64(i));
        return result;
    };
    const edges = () => {
        const count = m.api.trace2_edge_snapshot(), result = new Map();
        for (let i = 0; i < count; i++) result.set(`${m.api.trace2_edge_from(i) >>> 0}:${m.api.trace2_edge_to(i) >>> 0}`, m.api.trace2_edge_count_u64(i));
        return result;
    };
    const run = count => {
        m.reg()[0] = 0; m.reg()[1] = count;
        m.state().setUint32(556, loop, true); m.cpu.in_hlt[0] = 0;
        m.execute();
        assert.equal(m.reg()[0], count);
        assert.equal(m.reg()[1], 0);
    };
    try {
        m.paging();
        const bytes = m.guest(), view = new DataView(bytes.buffer, bytes.byteOffset);
        // inc eax; jmp next page; dec ecx; jnz previous page; jmp DONE.
        bytes.set([0x40, 0xe9], loop); view.setInt32(loop + 2, branch - (loop + 6), true);
        bytes.set([0x49, 0x0f, 0x85], branch); view.setInt32(branch + 3, loop - (branch + 7), true);
        bytes[branch + 7] = 0xe9; view.setInt32(branch + 8, DONE - (branch + 12), true);
        for (const [index, value] of [[1,4],[3,0],[6,1],[7,0],[8,4],[9,0],[12,0],[13,0],[15,0],[17,4],[19,0]]) m.api.set_jit_config(index, value);
        m.api.trace2_reset(); m.api.trace2_watch_page(loop); m.api.trace2_watch_page(branch);
        m.api.jit_clear_cache_js();
        for (let i = 0; i < 20 && !(blocks().get(branch) > 0n); i++) {
            run(250000);
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert.ok(blocks().get(branch) > 0n, 'must execute an instrumented native JIT block');
        const beforeBlocks = blocks(), beforeEdges = edges();
        run(20000);
        const count = blocks().get(branch) - beforeBlocks.get(branch);
        const afterEdges = edges();
        const delta = target => (afterEdges.get(`${branch}:${target}`) ?? 0n) - (beforeEdges.get(`${branch}:${target}`) ?? 0n);
        assert.equal(count, 20000n);
        assert.equal(delta(loop), 19999n);
        assert.equal(delta(branch + 7), 1n);
        assert.equal(delta(loop) + delta(branch + 7), count);
    } finally { m.close(); }
});
