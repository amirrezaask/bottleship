import { afterEach, describe, expect, test } from 'bun:test';
import { installGameBoxBridge } from '../../src/gamebox-bridge.js';

class FakeWorker extends EventTarget {
  requests: Array<Record<string, unknown>> = [];
  onPost: (request: Record<string, unknown>) => void = () => {};
  terminated = false;

  postMessage(value: Record<string, unknown>): void {
    this.requests.push(value);
    this.onPost(value);
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(type: string, id: unknown, result: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: { type, id, result } }));
  }

  fail(message: string): void {
    const event = new Event('error');
    Object.defineProperty(event, 'message', { value: message });
    this.dispatchEvent(event);
  }
}

const originalWindow = (globalThis as any).window;
const originalLocation = (globalThis as any).location;
afterEach(() => {
  (globalThis as any).window = originalWindow;
  (globalThis as any).location = originalLocation;
});

function setup(worker: FakeWorker): void {
  (globalThis as any).window = {
    dispatchEvent: () => true,
    loadApp: async () => {},
  };
  (globalThis as any).location = { href: 'http://localhost/', origin: 'http://localhost' };
  installGameBoxBridge(worker as unknown as Worker, async () => {});
}

describe('GameBox bridge profile RPC', () => {
  test('retains the one-time process creation milestone', () => {
    const worker = new FakeWorker();
    setup(worker);
    worker.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'gamebox_milestone', milestone: 'process_created' },
      }),
    );

    expect(
      (globalThis as any).window.GameBoxBottleShip.startupMilestones.processCreationMs,
    ).toBeGreaterThanOrEqual(0);
  });

  test('wraps direct start options in the worker contract', async () => {
    const worker = new FakeWorker();
    setup(worker);
    worker.onPost = (request) => {
      if (request.type === 'gamebox_profile')
        queueMicrotask(() => worker.reply('gamebox_profile_result', request.id, { started: true }));
    };

    await expect(
      (globalThis as any).window.GameBoxBottleShip.profile('start', {
        gameContentHash: 'a'.repeat(64),
        scenario: 'fixture',
      }),
    ).resolves.toEqual({ started: true });
    expect(worker.requests[0]).toMatchObject({
      type: 'gamebox_profile',
      mode: 'start',
      options: { gameContentHash: 'a'.repeat(64), scenario: 'fixture' },
    });
  });

  test('preserves explicit options and graphics payloads', async () => {
    const worker = new FakeWorker();
    setup(worker);
    worker.onPost = (request) => {
      if (request.type === 'gamebox_profile')
        queueMicrotask(() => worker.reply('gamebox_profile_result', request.id, { started: true }));
    };
    const options = { gameContentHash: 'b'.repeat(64), scenario: 'fixture' };
    const graphics = { runtime: 'fixture' };

    await (globalThis as any).window.GameBoxBottleShip.profile('start', {
      options,
      graphics,
    });
    expect(worker.requests[0]).toMatchObject({ options, graphics });
  });

  test('loads the bundle before awaiting queued AOT work', async () => {
    const worker = new FakeWorker();
    const order: string[] = [];
    setup(worker);
    (globalThis as any).window.loadApp = async () => order.push('loadApp');
    worker.dispatchEvent(new MessageEvent('message', { data: { type: 'ready' } }));
    worker.onPost = (request) => {
      if (request.type === 'gamebox_aot') {
        order.push('aot');
        queueMicrotask(() => worker.reply('gamebox_aot_result', request.id, { loaded: true }));
      }
    };

    await (globalThis as any).window.GameBoxBottleShip.start({
      gameUrl: '/assets/fixture.wgb',
      saveNamespace: 'fixture',
      aotUrl: '/assets/fixture/aot.json',
    });
    expect(order).toEqual(['loadApp', 'aot']);
  });

  test('rejects immediately when the worker fails during a request', async () => {
    const worker = new FakeWorker();
    setup(worker);
    worker.onPost = () => queueMicrotask(() => worker.fail('worker crashed'));

    await expect((globalThis as any).window.GameBoxBottleShip.profile('cancel')).rejects.toThrow(
      'worker crashed',
    );
  });

  test('rejects pending profile requests when stop tears down the worker', async () => {
    const worker = new FakeWorker();
    setup(worker);
    worker.onPost = (request) => {
      if (request.type === 'gamebox_stop')
        queueMicrotask(() => worker.reply('gamebox_stopped', request.id, undefined));
    };

    const profile = (globalThis as any).window.GameBoxBottleShip.profile('cancel');
    const stop = (globalThis as any).window.GameBoxBottleShip.stop();

    await expect(profile).rejects.toThrow('stopped during profiling');
    await stop;
    expect(worker.terminated).toBe(true);
  });
});
