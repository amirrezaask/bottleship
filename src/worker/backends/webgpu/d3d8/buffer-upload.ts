const tail = new Uint8Array(4);

/** WebGPU requires four-byte writes; a DX8 index buffer may end with one
 * uint16. Copy only its final partial word, without reading past guest storage. */
export function uploadD3D8Buffer(
    queue: GPUQueue, buffer: GPUBuffer, memory: Uint8Array, pointer: number, size: number,
): void {
    if (!Number.isSafeInteger(pointer) || !Number.isSafeInteger(size) || pointer < 0 || size < 0 ||
        pointer + size > memory.byteLength) throw new RangeError('Invalid D3D8 buffer range');
    const aligned = size - size % 4;
    if (aligned) queue.writeBuffer(buffer, 0, memory.buffer, memory.byteOffset + pointer, aligned);
    if (size !== aligned) {
        tail.fill(0);
        tail.set(memory.subarray(pointer + aligned, pointer + size));
        queue.writeBuffer(buffer, aligned, tail);
    }
}
