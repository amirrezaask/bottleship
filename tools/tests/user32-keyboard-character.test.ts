import { expect, test } from 'bun:test';
import { createSystemExports } from '../../src/worker/modules/user32/system';

const api = createSystemExports();
test('MapVirtualKey A/W returns uppercase action codes for every letter', () => {
    const memory = new Uint8Array(16);
    for (const name of ['MapVirtualKeyA', 'MapVirtualKeyW']) {
        for (let vk = 0x41; vk <= 0x5a; vk++) {
            expect(api[name]({} as never, memory, [vk, 2])).toBe(vk);
        }
        expect(api[name]({} as never, memory, [0x31, 2])).toBe(0x31);
        expect(api[name]({} as never, memory, [0x20, 2])).toBe(0x20);
        expect(api[name]({} as never, memory, [0xba, 2])).toBe(0x3b);
        expect(api[name]({} as never, memory, [0x70, 2])).toBe(0);
    }
});

test('ToAscii still observes shift and caps for text entry', () => {
    const memory = new Uint8Array(512), output = 320, state = 32;
    for (const [shift, caps, expected] of [[0, 0, 0x77], [0x80, 0, 0x57], [0, 1, 0x57], [0x80, 1, 0x77]]) {
        memory[state + 0x10] = shift; memory[state + 0x14] = caps;
        expect(api.ToAscii({} as never, memory, [0x57, 0x11, state, output, 0])).toBe(1);
        expect(memory[output]).toBe(expected);
    }
});
