import { afterEach, beforeEach, expect, test } from 'bun:test';
import { DSound } from '../../src/worker/modules/dsound/dsound';
import { Mem } from '../../src/worker/core/memory/mem-accessor';
import { ThunkGenerator } from '../../src/worker/core/thunking/thunk-generator';
import { System } from '../../src/worker/core/system';

let ds: DSound, memory: Uint8Array, view: DataView, buffer: number;
const system = System.getInstance();
const previousSelf = globalThis.self;
let previousProcess: typeof system.process;
const descriptors = 0x500, results = 0x600, output = 0x700;
function call(method: string, args: number[]): number {
    return ds.exports[method]({} as never, memory, args) as number;
}
beforeEach(() => {
    previousProcess = system.process;
    globalThis.self = { postMessage() {} } as never;
    memory = new Uint8Array(2 * 1024 * 1024); view = new DataView(memory.buffer);
    Mem.bind(() => memory);
    const thunks = new ThunkGenerator(); thunks.setBaseAddress(0x10000, 1024 * 1024);
    let next = 0x120000; const sizes = new Map<number, number>();
    const process = {
        getCurrentMemory: () => memory, v86: { mem8: memory }, thunkGenerator: thunks,
        memory: { alloc(size: number) { const p = next; next += size; sizes.set(p, size); return p; },
            allocAt() {}, free(p: number) { sizes.delete(p); }, getSize: (p: number) => sizes.get(p) },
        dispatcher: { applyPendingRegistrations() {} },
    } as unknown as NonNullable<typeof system.process>;
    system.process = process; ds = new DSound(); ds.initialize(process);
    expect(call('directsoundcreate8', [0, 0x100, 0])).toBe(0);
    view.setUint16(0x200, 1, true); view.setUint16(0x202, 2, true);
    view.setUint32(0x204, 48000, true); view.setUint32(0x208, 192000, true);
    view.setUint16(0x20c, 4, true); view.setUint16(0x20e, 16, true);
    view.setUint32(0x300, 36, true); view.setUint32(0x304, 0x202e8, true);
    view.setUint32(0x308, 4096, true); view.setUint32(0x310, 0x200, true);
    expect(call('idirectsound8_createsoundbuffer', [view.getUint32(0x100, true), 0x300, 0x104, 0])).toBe(0);
    buffer = view.getUint32(0x104, true);
    for (let i = 0; i < 2; i++) {
        view.setUint32(descriptors + i * 32, 32, true);
        memory.set([0x89,0xed,0x0c,0x12,0xf4,0x3b,0x73,0x41,0xa1,0x32,0x3c,0xb4,0x06,0xcf,0x32,0x31], descriptors + i * 32 + 8);
    }
});
afterEach(() => {
    system.process = previousProcess; globalThis.self = previousSelf;
    Mem.bind(() => previousProcess?.getCurrentMemory() ?? new Uint8Array());
});
test('vehicle EQ setup fails instead of promising a missing effect object', () => {
    // GTA CAEStreamingChannel::AddFX only enters GetObjectInPath on SUCCEEDED(SetFX).
    const hr = call('idirectsoundbuffer8_setfx', [buffer, 2, descriptors, 0]);
    expect(hr).toBe(0x80004002); expect(hr | 0).toBeLessThan(0);
    memory.fill(0xa5, results - 4, results + 12);
    expect(call('idirectsoundbuffer8_setfx', [buffer, 2, descriptors, results])).toBe(hr);
    expect(view.getUint32(results, true)).toBe(5); expect(view.getUint32(results + 4, true)).toBe(5);
    expect(view.getUint32(results - 4, true)).toBe(0xa5a5a5a5);
    expect(view.getUint32(results + 8, true)).toBe(0xa5a5a5a5);
    view.setUint32(output, 0xdeadbeef, true);
    expect(call('idirectsoundbuffer8_getobjectinpath', [buffer, descriptors + 8, 0, descriptors + 8, output])).toBe(0x88781161);
    expect(view.getUint32(output, true)).toBe(0);
});
test('bounded validation rejects malformed descriptors and output ranges without writes', () => {
    for (const args of [[buffer, 65, descriptors, results], [buffer, 2, memory.length - 32, results],
        [buffer, 2, descriptors, memory.length - 4], [buffer, 0, descriptors, 0], [buffer, 2, 0, 0]]) {
        const before = memory.slice();
        expect(call('idirectsoundbuffer8_setfx', args)).toBe(0x80070057); expect(memory).toEqual(before);
    }
    view.setUint32(descriptors + 32, 31, true);
    expect(call('idirectsoundbuffer8_setfx', [buffer, 2, descriptors, results])).toBe(0x80070057);
    expect(call('idirectsoundbuffer8_getobjectinpath', [buffer, descriptors, 0, descriptors, memory.length - 2])).toBe(0x80070057);
});
test('empty-chain removal and ordinary playback remain available; playing/locked changes fail', () => {
    expect(call('idirectsoundbuffer8_setfx', [buffer, 0, 0, 0])).toBe(0);
    expect(call('idirectsoundbuffer8_play', [buffer, 0, 0, 1])).toBe(0);
    expect(call('idirectsoundbuffer8_setfx', [buffer, 2, descriptors, 0])).toBe(0x88780032);
    expect(call('idirectsoundbuffer8_getstatus', [buffer, output])).toBe(0);
    expect(view.getUint32(output, true) & 1).toBe(1);
    expect(call('idirectsoundbuffer8_stop', [buffer])).toBe(0);
    expect(call('idirectsoundbuffer8_lock', [buffer, 0, 16, output, output + 4, 0, 0, 0])).toBe(0);
    expect(call('idirectsoundbuffer8_setfx', [buffer, 2, descriptors, 0])).toBe(0x88780032);
    expect(call('idirectsoundbuffer8_unlock', [buffer, view.getUint32(output, true), 16, 0, 0])).toBe(0);
    expect(call('idirectsoundbuffer8_setfx', [buffer, 0, 0, 0])).toBe(0);
    expect(call('idirectsoundbuffer8_acquireresources', [buffer, 0, 0, 0])).toBe(0);
    expect(call('idirectsoundbuffer8_acquireresources', [buffer, 0, 2, results])).toBe(0x80070057);
});
