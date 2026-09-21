import { expect, test } from 'bun:test';
import { CallbackManager } from '../../src/worker/core/thunking/callback-manager';
import { System } from '../../src/worker/core/system';

test('releasing a suspended callback frame unpins its owner after a thread handoff', () => {
    const system = System.getInstance();
    const originalScheduler = system.scheduler;
    const pins = new Map([[1, 0], [2, 0]]);
    let currentThreadId = 1;
    const scheduler = {
        getCurrentThreadId: () => currentThreadId,
        pinCurrentThread: () => pins.set(currentThreadId, pins.get(currentThreadId)! + 1),
        unpinThread: (threadId: number) => pins.set(threadId, pins.get(threadId)! - 1),
    };
    (system as any).scheduler = scheduler;
    try {
        const memory = new Uint8Array(0x8_000_00);
        const stack = new DataView(memory.buffer);
        stack.setUint32(0x2000, 0x401000, true);
        const manager = new CallbackManager(
            { cpu: { reg32: new Int32Array(8) } },
            { allocateRawCodeArea: () => 0x1f0000 } as any,
            () => memory,
        );

        expect(manager.saveSuspendedThunkContext({ esp: 0x2000 }, 0, 'test')).toBe(1);
        expect([...pins.values()]).toEqual([1, 0]);

        currentThreadId = 2;
        (manager as any).releaseFrame(0);

        expect([...pins.values()]).toEqual([0, 0]);
    } finally {
        (system as any).scheduler = originalScheduler;
    }
});
