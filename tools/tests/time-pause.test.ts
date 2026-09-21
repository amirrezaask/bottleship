import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { TimeService } from '../../src/worker/runtime/time';
import { HypercallDataManager } from '../../src/worker/core/cpu/hypercall-data';

let wall = 1_000;
let clock: TimeService;
let originalClock: unknown;
let nowSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
    wall = 1_000;
    nowSpy = spyOn(performance, 'now').mockImplementation(() => wall);
    originalClock = (TimeService as any).instance;
    clock = new TimeService();
    (TimeService as any).instance = clock;
});
afterEach(() => {
    nowSpy.mockRestore();
    (TimeService as any).instance = originalClock;
});

describe('emulator pause preserves the guest elapsed clock', () => {
    for (const pausedMs of [10_000, 60_000]) {
        test(`${pausedMs}ms pause leaves virtual ticks, deadlines, and idle ceiling continuous`, () => {
            clock.enableVirtualTime();
            wall += 5; clock.advanceVirtualTime(5);
            const before = clock.nowMs();
            const deadline = before + 25;
            clock.notifyPause();
            wall += pausedMs;
            clock.notifyPause(); // A second pause must not replace the anchor.
            clock.advanceVirtualTime(200);
            expect(clock.creditIdleMs(200)).toBe(0);
            expect(clock.nowMs()).toBe(before);
            clock.notifyPauseResume();
            expect(clock.nowMs()).toBe(before);
            expect(clock.guestWallClockMs()).toBe(before);
            clock.notifyPauseResume(); // Redundant resume does not re-anchor the guest.
            wall += 10;
            clock.creditIdleMs(10);
            expect(clock.nowMs()).toBe(before + 10);
            expect(clock.nowMs()).toBeLessThan(deadline);
            wall += 15; clock.creditIdleMs(15);
            expect(clock.nowMs()).toBe(deadline);
            expect(clock.wallClockMs()).toBe(wall);
        });
    }

    test('realtime clock also freezes before native hypercalls activate', () => {
        clock.notifyPause(); wall += 60_000;
        expect(clock.nowMs()).toBe(1_000);
        clock.notifyPauseResume(); wall += 7;
        expect(clock.nowMs()).toBe(1_007);
        clock.enableVirtualTime();
        expect(clock.nowMs()).toBe(1_007);
    });

    test('manual harness time remains explicit and game reset removes pause state', () => {
        clock.enableVirtualTime(); clock.setManualTime(42, 42000);
        clock.notifyPause(); wall += 60_000;
        clock.advanceByMs(250);
        expect(clock.nowMs()).toBe(292);
        expect(clock.nowUnixMs()).toBe(42250);
        clock.notifyPauseResume();
        expect(clock.nowMs()).toBe(292);
        clock.notifyPause(); wall += 20_000;
        clock.resetForGameSwitch();
        expect(clock.getMode()).toBe('realtime');
        expect(clock.nowMs()).toBe(wall);
        expect(clock.guestWallClockMs()).toBe(wall);
    });

    test('heavy-thunk re-anchor stays on the pause-adjusted ceiling', () => {
        clock.enableVirtualTime(); clock.notifyPause(); wall += 60_000;
        clock.reanchorToWallClock();
        expect(clock.nowMs()).toBe(1_000);
        clock.notifyPauseResume(); wall += 12;
        clock.reanchorToWallClock();
        expect(clock.nowMs()).toBe(1_012);
    });

    test('native tick/QPC page and next instruction delta exclude a sixty-second pause', () => {
        const memory = new WebAssembly.Memory({ initial: 2 });
        const cpu = { wasm_memory: memory, instruction_counter: new Uint32Array(1), wm: { exports: {} } };
        const manager = new HypercallDataManager();
        manager.initialize(cpu, 4096); manager.enable(); manager.updateTimeData();
        const view = new DataView(memory.buffer);
        const tick = () => view.getUint32(4096 + 0x10, true);
        const qpc = () => Number(view.getBigUint64(4096 + 0x14, true));
        const before = tick(); const beforeQpc = qpc();
        clock.notifyPause(); wall += 60_000;
        manager.updateTimeData();
        expect(tick()).toBe(before); expect(qpc()).toBe(beforeQpc);
        clock.notifyPauseResume(); manager.resetInsnBaseline();
        manager.updateTimeData();
        expect(tick()).toBe(before); expect(qpc()).toBe(beforeQpc);
        wall += 2; cpu.instruction_counter[0] += 100_003;
        manager.updateTimeData();
        expect(tick()).toBeGreaterThanOrEqual(before);
        expect(qpc()).toBeGreaterThan(beforeQpc);
        expect(qpc() - beforeQpc).toBeLessThanOrEqual(4_000);
    });
});
