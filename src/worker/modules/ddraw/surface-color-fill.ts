import { toPlainGuestMemory } from "../../core/memory/guest-memory";

/**
 * Fill a clipped DirectDraw rectangle in guest memory.
 *
 * The operation is synchronous, so using a plain view is safe: guest execution
 * cannot grow or replace the WASM buffer during the loop.
 */
export function fillSurfaceColor(
    mem: Uint8Array,
    surfacePtr: number,
    pitch: number,
    left: number,
    top: number,
    width: number,
    height: number,
    bytesPerPixel: number,
    fillColor: number,
): void {
    const writableMem = toPlainGuestMemory(mem);
    const rowBytes = width * bytesPerPixel;
    for (let y = 0; y < height; y++) {
        const rowStart = surfacePtr + (top + y) * pitch + left * bytesPerPixel;
        if (rowStart < 0 || rowStart + rowBytes > writableMem.length) continue;
        if (bytesPerPixel === 2) {
            for (let x = 0; x < width; x++) {
                writableMem[rowStart + x * 2] = fillColor & 0xff;
                writableMem[rowStart + x * 2 + 1] = (fillColor >> 8) & 0xff;
            }
        } else if (bytesPerPixel === 4) {
            for (let x = 0; x < width; x++) {
                writableMem[rowStart + x * 4] = fillColor & 0xff;
                writableMem[rowStart + x * 4 + 1] = (fillColor >> 8) & 0xff;
                writableMem[rowStart + x * 4 + 2] = (fillColor >> 16) & 0xff;
                writableMem[rowStart + x * 4 + 3] = (fillColor >> 24) & 0xff;
            }
        } else {
            writableMem.fill(fillColor & 0xff, rowStart, rowStart + rowBytes);
        }
    }
}
