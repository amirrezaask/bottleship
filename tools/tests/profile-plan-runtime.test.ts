import { describe, expect, test } from 'bun:test';
import { resolveProfilePlanRuntime } from '../../src/worker/core/debug/profile-plan-runtime';

describe('profile-plan live runtime resolution', () => {
    test('uses Process memory and the canonical V86Starter CPU', () => {
        const memory = new Uint8Array(256 * 1024 * 1024);
        const nestedCpu = { cr: new Uint32Array(5), mem8: new Uint8Array(4096) };
        const outerCpu = { cr: new Uint32Array(5), mem8: new Uint8Array(4096) };
        const process = {
            v86: { cpu: outerCpu, mem8: outerCpu.mem8, v86: { cpu: nestedCpu } },
            getCurrentMemory: () => memory,
        };

        const resolved = resolveProfilePlanRuntime(process);
        expect(resolved.cpu).toBe(outerCpu);
        expect(resolved.memory).toBe(memory);
        expect(resolved.memory.byteLength).toBe(256 * 1024 * 1024);
    });

    test('falls back to the canonical nested memory only when Process has no accessor', () => {
        const memory = new Uint8Array(16 * 1024 * 1024);
        const cpu = { cr: new Uint32Array(5), mem8: memory };
        const resolved = resolveProfilePlanRuntime({ v86: { v86: { cpu } } });
        expect(resolved.cpu).toBe(cpu);
        expect(resolved.memory).toBe(memory);
    });

    test('accepts the realm-safe proxy shape used by v86 memory views', () => {
        const backing = new Uint8Array(16 * 1024 * 1024);
        const memory = new Proxy({}, {
            get: (_target, property) => {
                const value = backing[property as keyof Uint8Array];
                return typeof value === 'function' ? value.bind(backing) : value;
            },
        });
        const cpu = { cr: new Uint32Array(5), mem8: memory };
        const resolved = resolveProfilePlanRuntime({
            v86: { cpu },
            getCurrentMemory: () => memory,
        });
        expect(resolved.memory).toBe(memory);
        expect(resolved.memory.length).toBe(backing.length);
    });

    test('fails closed when no bounded memory is available', () => {
        expect(() => resolveProfilePlanRuntime({ v86: { v86: { cpu: {} } } }))
            .toThrow('Profile plan requires bounded guest memory');
    });
});
