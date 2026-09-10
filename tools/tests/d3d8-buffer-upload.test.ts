import { expect, test } from 'bun:test';
import { uploadD3D8Buffer } from '../../src/worker/backends/webgpu/d3d8/buffer-upload';

test.each([0, 1, 2, 3, 4, 6, 10])('uploads %i bytes without reading beyond the source', size => {
    const input = Uint8Array.from({ length: size + 5 }, (_, i) => i + 1).subarray(5);
    const output = new Uint8Array(Math.ceil(size / 4) * 4);
    const calls: number[] = [];
    const queue = { writeBuffer: (_buffer: unknown, offset: number, data: ArrayBuffer | Uint8Array, start = 0, count?: number) => {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data, start, count);
        expect(bytes.byteLength % 4).toBe(0); expect(offset % 4).toBe(0);
        output.set(bytes, offset); calls.push(bytes.byteLength);
    } } as any;
    uploadD3D8Buffer(queue, {} as any, input, 0, size);
    expect([...output.slice(0, size)]).toEqual([...input]);
    expect([...output.slice(size)]).toEqual(Array(output.length - size).fill(0));
    expect(calls.length).toBeLessThanOrEqual(2);
    expect(() => uploadD3D8Buffer(queue, {} as any, input, 1, size)).toThrow();
});
