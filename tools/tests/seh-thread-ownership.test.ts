import { expect, test } from 'bun:test';
import { ThunkDispatcher } from '../../src/worker/core/thunking/thunk-dispatcher';

test('a timer thread cannot unwind or unpin a parked fault handler on another stack', () => {
  const d = new ThunkDispatcher({ add_listener() {} } as any, {} as any) as any;
  let current = 1;
  const pins = new Map([[1, 0], [2, 0]]);
  const sched = {
    getCurrentThreadId: () => current,
    enterCriticalRuntime() {}, exitCriticalRuntime() {},
    registerTransientExecRange() {}, unregisterTransientExecRange() {},
    pinThread: (id: number) => pins.set(id, pins.get(id)! + 1),
    unpinThread: (id: number) => pins.set(id, pins.get(id)! - 1),
  };
  d.ensureScheduler = () => sched;
  const owner = { ownerThreadId: 1, generation: 1, startEsp: 0x1000 };
  d.sehDispatchStack.push(owner);
  d._enterSehCriticalRuntime(1);
  current = 2;
  d.cachedCpu = { reg32: new Int32Array([0, 0, 0, 0, 0x9000]) };
  d._checkSehNonLocalJump(123);
  d.notifySehHandlerCaught(0x9100);
  expect(d.sehDispatchStack).toEqual([owner]);
  expect([...pins.values()]).toEqual([1, 0]);
  // Nested fault on the timer stack owns its own pin.
  d.sehDispatchStack.push({ ownerThreadId: 2, generation: 2, startEsp: 0x8000 });
  d._enterSehCriticalRuntime(2);
  d.sehDispatchStack.pop();
  d._leaveSehCriticalRuntime('dispatch_result', 2, 2);
  expect([...pins.values()]).toEqual([1, 0]);
  current = 1;
  d.cachedCpu.reg32[4] = 0x1100;
  d._checkSehNonLocalJump(124);
  expect(d.sehDispatchStack).toHaveLength(0);
  expect([...pins.values()]).toEqual([0, 0]);
});
