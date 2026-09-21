import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { alienShooterMousePrelude, ALIEN_SHOOTER_SOURCE_SHA256 } from '../../src/worker/core/game-fixes/alien-shooter';
import type { LoadedPEModule } from '../../src/worker/core/module-registry';
import { System } from '../../src/worker/core/system';
import { createMessageExports } from '../../src/worker/modules/user32/message';
import { windows, type WindowInfo } from '../../src/worker/modules/user32/shared-state';

const fixture = () => {
    const memory = new Uint8Array(0x426000);
    const view = new DataView(memory.buffer);
    view.setUint32(0x40003c, 0x118, true);
    view.setUint32(0x400118, 0x4550, true);
    view.setUint32(0x400120, 0x40c94276, true);
    memory.set([0x8b, 0x0d, 0x38, 0x07, 0x49, 0x00, 0x8b, 0x01, 0x83, 0xec, 0x08, 0x53], 0x404c30);
    memory.set([0x8b, 0x44, 0x24, 0x08, 0x83, 0xec, 0x10, 0x3d, 0x01, 0x02, 0x00, 0x00, 0x56, 0x8b, 0xf1], 0x425d80);
    memory.set([0x8b, 0x4c, 0x24, 0x18, 0x8d, 0x44, 0x24, 0x04, 0x50, 0x51, 0xff, 0x15, 0x90, 0xa1, 0x47, 0x00], 0x425dc7);
    const module = { name: 'alienshooter', isExecutable: true, baseAddress: 0x400000,
        size: 0x1f9000, sourceHash: ALIEN_SHOOTER_SOURCE_SHA256 } as LoadedPEModule;
    const window = { handle: 0x10012, title: 'AlienShooter', wndProc: 0x404c30,
        x: 100, y: 50, width: 640, height: 480, children: [], style: 0, visible: true } as WindowInfo;
    return { memory, view, module, window };
};
let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; windows.delete(0x10012); });

describe('Alien Shooter mouse hit-test compatibility', () => {
    test('keeps signed client coordinates and converts them to screen coordinates', () => {
        const { memory, module, window } = fixture();
        const result = alienShooterMousePrelude(module, memory, window, 0x200, (-20 << 16) | 0xfff6);
        expect(result).toEqual({ message: 0x84, wParam: 0, lParam: (30 << 16) | 90 });
        module.sourceHash = undefined;
        expect(alienShooterMousePrelude(module, memory, window, 0x201, 0)?.message).toBe(0x84);
    });
    test('guard misses leave unrelated editions, windows, and messages unchanged', () => {
        const { memory, module, window } = fixture();
        expect(alienShooterMousePrelude(module, memory, window, 0x100, 0)).toBeUndefined();
        expect(alienShooterMousePrelude(module, memory, { ...window, parent: 42 }, 0x200, 0)).toBeUndefined();
        expect(alienShooterMousePrelude({ ...module, sourceHash: 'different' }, memory, window, 0x200, 0)).toBeUndefined();
        memory[0x425dc7] ^= 1;
        expect(alienShooterMousePrelude(module, memory, window, 0x200, 0)).toBeUndefined();
    });
    test('checks virtual header bytes instead of bypassing their memory mapping', () => {
        const { memory, module, window } = fixture();
        const mapped = new Proxy(memory, {
            get(target, property) {
                if (property === 'buffer') throw new Error('physical memory bypass');
                return Reflect.get(target, property, target);
            },
        });
        expect(alienShooterMousePrelude(module, mapped, window, 0x200, 0)?.message).toBe(0x84);
    });
    test('uses the same suspended owner frame and returns the original mouse message result', () => {
        const { memory, view, module, window } = fixture();
        windows.set(window.handle, window);
        view.setUint32(0x1000, window.handle, true);
        view.setUint32(0x1004, 0x201, true);
        view.setUint32(0x1008, 1, true);
        view.setUint32(0x100c, (240 << 16) | 320, true);
        view.setUint32(0x2000, 0x401234, true);
        const calls: unknown[][] = [];
        let saved = 0;
        const callbackManager = {
            saveSuspendedThunkContext: () => { saved++; return 7; },
            invokeCallback: (...args: unknown[]) => { calls.push(args); return { callbackId: calls.length }; },
        };
        const system = { process: { moduleRegistry: { getExecutableModule: () => module }, dispatcher: { callbackManager } } };
        const spy = spyOn(System, 'getInstance').mockReturnValue(system as unknown as System);
        restore = () => spy.mockRestore();
        const result = createMessageExports().DispatchMessageW({ esp: 0x2000 } as any, memory, [0x1000]);
        expect(result).toMatchObject({ suspendedForCallback: true, stackCleanup: 4 });
        expect(calls[0][1]).toEqual([window.handle, 0x84, 0, (290 << 16) | 420]);
        expect((calls[0][3] as (n: number) => unknown)(1)).toBeNull();
        expect(calls[1][1]).toEqual([window.handle, 0x201, 1, (240 << 16) | 320]);
        expect(calls[0][6]).toBe(7);
        expect(calls[1][6]).toBe(7);
        expect((calls[1][3] as (n: number) => unknown)(123)).toBe(123);
        expect(saved).toBe(1);
    });
});
