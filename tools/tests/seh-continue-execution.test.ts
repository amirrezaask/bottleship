import { describe, expect, test } from 'bun:test';
import { ThunkDispatcher } from '../../src/worker/core/thunking/thunk-dispatcher';
import { SEH_SCRATCH_LAYOUT } from '../../src/worker/core/thunking/seh-layout';

describe('SEH access-violation continuation', () => {
    test.each([0x9000, 0x9200])('resumes with the handler-selected stack %#', (resumeEsp) => {
        const dispatcher = new ThunkDispatcher({ add_listener() {} } as any, {} as any) as any;
        const memory = new Uint8Array(0x10000);
        const view = new DataView(memory.buffer);
        const scratch = 0x1000;
        const context = scratch + SEH_SCRATCH_LAYOUT.CONTEXT;
        Object.assign(dispatcher, {
            cachedMem8: memory, cachedDataView: view, memLength: memory.length,
            sehScratchAddr: scratch,
        });
        const cpu = {
            reg32: new Int32Array(8), flags: new Int32Array([0x202]),
            flags_changed: new Int32Array([0x8d5]),
        };
        cpu.reg32[4] = 0x8e00; // temporary dispatcher stack
        view.setUint32(0x8e00, 0xdeadbeef, true);
        view.setUint32(resumeEsp, 0x12345678, true); // original function return address
        view.setUint32(context + 0xb8, 0x401234, true);
        view.setUint32(context + 0xc0, 0x647, true); // carry, zero, direction
        view.setUint32(context + 0xc4, resumeEsp, true);
        for (const [offset, value] of [[0x9c, 7], [0xa0, 6], [0xa4, 3], [0xa8, 2], [0xac, 1], [0xb0, 10], [0xb4, 5]]) {
            view.setUint32(context + offset!, value!, true);
        }

        dispatcher._handleSehDispatchResult(cpu);
        // Execute the production dispatch stub's final RET.
        const resumedEip = view.getUint32(cpu.reg32[4]!, true);
        cpu.reg32[4] += 4;
        expect(resumedEip).toBe(0x401234);
        expect([...cpu.reg32]).toEqual([10, 1, 2, 3, resumeEsp, 5, 6, 7]);
        expect(cpu.flags[0]).toBe(0x647);
        expect(cpu.flags_changed[0]).toBe(0);
        expect(view.getUint32(resumeEsp, true)).toBe(0x12345678);
        expect(view.getUint32(0x8e00, true)).toBe(0xdeadbeef);
    });
});
