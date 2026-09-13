import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PageTableManager } from '../../src/worker/core/memory/page-table-manager';
import { createMachine, ENTRY, LEAF, LEFT, RIGHT } from './bulk-machine.mjs';

test('page commits retain unrelated native JIT modules and invalidate overwritten guest code', async () => {
    const binary = await readFile(process.env.V86_TEST_BINARY ?? new URL('../../public/v86.wasm', import.meta.url));
    const m = await createMachine(binary, { jit: true });
    const pages = new PageTableManager(m.guest, () => m.api, 0x1400000);
    const snapshot = () => Array.from({ length: m.api.jit_snapshot_cache() }, (_, i) => ({
        page: m.api.jit_snapshot_get_phys_addr(i) >>> 0,
        slot: m.api.jit_snapshot_get_wasm_idx(i),
    }));
    try {
        pages.initialize(m.guest().length); pages.enablePaging(m.cpu);
        m.api.set_jit_config(9, 1);
        m.warm(ENTRY, 4096, true); m.warm(LEAF, 4096, true);
        m.guest().fill(0x5a, LEFT, LEFT + 4096);
        const deadline = Date.now() + 10000;
        do {
            m.call('memcpy', RIGHT, LEFT, 64, 150000);
            await new Promise(resolve => setTimeout(resolve, 5));
            assert.ok(Date.now() < deadline, 'real JIT compilation must complete');
        } while (!snapshot().some(row => row.page === LEAF));
        const before = snapshot();
        const generation = m.api.fastmem_get_generation();
        const deopts = m.api.fastmem_get_deopt_recompiles();
        pages.commitPages(RIGHT, 4096);
        assert.equal(m.api.fastmem_get_generation(), generation);
        assert.deepEqual(snapshot(), before, 'data commit preserves code table entries');
        assert.ok(m.guest().subarray(RIGHT, RIGHT + 4096).every((byte: number) => byte === 0));
        m.call('memcpy', RIGHT, LEFT, 64, 2000);
        assert.equal(m.api.fastmem_get_deopt_recompiles(), deopts);
        assert.ok(m.guest().subarray(RIGHT, RIGHT + 64).every((byte: number) => byte === 0x5a));

        pages.decommitPages(RIGHT, 4096);
        const afterDecommit = m.api.fastmem_get_generation();
        pages.commitPages(RIGHT, 4096);
        assert.ok(m.api.fastmem_get_generation() > afterDecommit, 'real recommit changes generation');
        const recompileDeadline = Date.now() + 10000;
        do {
            m.call('memcpy', RIGHT, LEFT, 64, 150000);
            await new Promise(resolve => setTimeout(resolve, 5));
            assert.ok(Date.now() < recompileDeadline, 'code must recompile after a true mapping change');
        } while (!snapshot().some(row => row.page === LEAF));
        // Overwrite actual code, not just the data destination. Native page
        // invalidation must remove all modules that referenced those bytes.
        pages.commitPages(LEAF, 4096);
        assert.ok(!snapshot().some(row => row.page === LEAF), 'zeroed code cannot remain executable');
        assert.ok(m.guest().subarray(LEAF, LEAF + 4096).every((byte: number) => byte === 0));
    } finally { m.close(); }
});
