/** Copy Canvas RGBA to a DWORD-padded, MSB-first Windows monochrome DIB. */
export function writeMonochromeDib(
  pixels: Uint8ClampedArray,
  memory: Uint8Array,
  bits: number,
  width: number,
  height: number,
  stride: number,
  topDown: boolean,
  palette: Uint32Array = new Uint32Array([0xff000000, 0xffffffff]),
): void {
  if (
    width <= 0 ||
    height <= 0 ||
    stride < Math.ceil(width / 8) ||
    bits < 0 ||
    bits + stride * height > memory.length ||
    pixels.length < width * height * 4
  )
    throw new Error('Invalid monochrome DIB bounds');
  const c0 = palette[0] ?? 0xff000000,
    c1 = palette[1] ?? 0xffffffff;
  const distance = (r: number, g: number, b: number, c: number) =>
    (r - ((c >>> 16) & 255)) ** 2 + (g - ((c >>> 8) & 255)) ** 2 + (b - (c & 255)) ** 2;
  for (let y = 0; y < height; y++) {
    const row = bits + (topDown ? y : height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const index =
        distance(pixels[p]!, pixels[p + 1]!, pixels[p + 2]!, c0) <=
        distance(pixels[p]!, pixels[p + 1]!, pixels[p + 2]!, c1)
          ? 0
          : 1;
      const target = row + (x >> 3),
        mask = 0x80 >> (x & 7);
      memory[target] = (memory[target]! & ~mask) | (index ? mask : 0);
    }
  }
}
