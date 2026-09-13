import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createMachine, ENTRY, LEAF, LEFT, RIGHT } from './bulk-machine.mjs';

test('tier-2 heat resets cannot invent profile executions or lose unsampled entries', async () => {
    const binary = await readFile(process.env.V86_TEST_BINARY ?? new URL('../../public/v86.wasm', import.meta.url));
    const m = await createMachine(binary, { jit: true });
    const snapshot = now => {
        const count = m.api.aot_profile_snapshot(now);
        return Array.from({ length: count }, (_, i) => ({
            executions: Number(m.api.aot_profile_executions(i)),
            first: m.api.aot_profile_first_execution_at(i),
            last: m.api.aot_profile_last_execution_at(i),
        }));
    };
    const total = now => snapshot(now).reduce((sum, row) => sum + row.executions, 0);
    try {
        m.paging();
        m.api.set_jit_config(15, 0); // Warm real code without promoting it.
        m.warm(ENTRY, 4096, true); m.warm(LEAF, 4096, true);
        m.guest().fill(0x42, LEFT, LEFT + 4096);
        let slot;
        const deadline = Date.now() + 10000;
        do {
            m.call('memcpy', RIGHT, LEFT, 64, 150000);
            await new Promise(resolve => setTimeout(resolve, 5));
            const count = m.api.jit_snapshot_cache();
            for (let i = 0; i < count; i++) {
                if ((m.api.jit_snapshot_get_phys_addr(i) >>> 0) === LEAF)
                    slot = m.api.jit_snapshot_get_wasm_idx(i);
            }
            assert.ok(Date.now() < deadline, 'fixture must install real native JIT code');
        } while (slot === undefined);

        // Compilation completed after the guest yielded; explicitly enter the
        // installed unit's native accounting path while promotions are disabled.
        m.api.jit_tier2_note_execution(slot);
        assert.ok(total(500) > 0, 'disabling promotions must not disable entry profiling');
        m.api.set_jit_config(20, 0); // Refuse promotions, retaining the table slot.
        m.api.set_jit_config(15, 31);
        m.api.jit_tier2_note_execution(slot);
        const before = total(1000);
        for (let entered = 1; entered <= 1200; entered++) {
            assert.equal(m.api.jit_tier2_note_execution(slot), 0);
            if (entered % 37 === 0) assert.equal(total(1000 + entered), before + entered);
        }
        assert.equal(total(3000), before + 1200);
        const last = snapshot(3000).map(row => row.last);
        assert.equal(total(4000), before + 1200, 'an idle snapshot cannot add executions');
        assert.deepEqual(snapshot(4000).map(row => row.last), last, 'idle time is not activity');

        // Retirement must drain the unsampled tail once, then clear ownership.
        for (let i = 0; i < 7; i++) m.api.jit_tier2_note_execution(slot);
        m.api.jit_dirty_cache(LEAF, LEAF + 4096);
        assert.equal(total(5000), before + 1207);
        assert.equal(total(6000), before + 1207);
        assert.ok(snapshot(6000).some(row => row.first === 500 && row.last === 5000));
    } finally { m.close(); }
});
