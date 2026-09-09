import { describe, expect, test } from 'bun:test';
import { parseCrtArguments, writeCrtArgv } from '../../src/worker/modules/crt-argv';

describe('MSVC command line arguments', () => {
    test.each([
        ['', []],
        [' \t ', []],
        ['-skipstartup -nodialog', ['-skipstartup', '-nodialog']],
        ['"" next', ['', 'next']],
        ['"two words"\tthree', ['two words', 'three']],
        ['ab"cd ef"gh', ['abcd efgh']],
        ['"unclosed value', ['unclosed value']],
        [String.raw`"C:\Games\Max Payne\\"`, ['C:\\Games\\Max Payne\\']],
        [String.raw`a\\\"b c`, ['a\\"b', 'c']],
        [String.raw`"a""b"`, ['a"b']],
        ['trailing\\', ['trailing\\']],
    ] as [string, string[]][])('parses %s', (source, expected) => {
        expect(parseCrtArguments(source)).toEqual(expected);
    });

    test('writes a null-terminated guest argv with complete strings and no adjacent overwrite', () => {
        const memory = new Uint8Array(4096).fill(0xcd);
        const view = new DataView(memory.buffer);
        const values = ['Max Payne.exe', '-nodialog', '', 'x'.repeat(600), 'caf\u00e9'];
        const encoded = values.map(value => Uint8Array.from(value, c => c.charCodeAt(0)));
        let allocation = 0;
        const base = writeCrtArgv(encoded, size => { allocation = size; return 64; },
            (ptr, bytes) => memory.set(bytes, ptr),
            (ptr, value) => view.setUint32(ptr, value, true));
        expect(base).toBe(64);
        expect(view.getUint32(base + values.length * 4, true)).toBe(0);
        const decoded = values.map((_, index) => {
            const start = view.getUint32(base + index * 4, true);
            const end = memory.indexOf(0, start);
            expect(end).toBeLessThan(base + allocation);
            return String.fromCharCode(...memory.subarray(start, end));
        });
        expect(decoded).toEqual(values);
        expect(memory[base - 1]).toBe(0xcd);
        expect(memory[base + allocation]).toBe(0xcd);
    });
});
