/** Names and styles needed to expose installed TrueType/OpenType fonts through GDI. */
export function readFontInfo(bytes: Uint8Array) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || ![0x00010000, 0x4f54544f, 0x74727565].includes(v.getUint32(0)))
    throw new Error('Unsupported font format');
  const tables = new Map<string, { start: number; size: number }>();
  const count = v.getUint16(4);
  if (12 + count * 16 > bytes.length) throw new Error('Truncated font directory');
  for (let i = 0; i < count; i++) {
    const p = 12 + i * 16;
    const tag = String.fromCharCode(...bytes.subarray(p, p + 4));
    const start = v.getUint32(p + 8),
      size = v.getUint32(p + 12);
    if (start + size > bytes.length) throw new Error('Truncated font table');
    tables.set(tag, { start, size });
  }
  const names = tables.get('name');
  if (!names || names.size < 6) throw new Error('Font has no names');
  const n = v.getUint16(names.start + 2),
    strings = names.start + v.getUint16(names.start + 4);
  if (6 + n * 12 > names.size) throw new Error('Truncated font names');
  const values = new Map<number, { value: string; score: number }>();
  for (let i = 0; i < n; i++) {
    const p = names.start + 6 + i * 12;
    const platform = v.getUint16(p),
      language = v.getUint16(p + 4),
      id = v.getUint16(p + 6);
    const length = v.getUint16(p + 8),
      start = strings + v.getUint16(p + 10);
    if (start < names.start || start + length > names.start + names.size)
      throw new Error('Invalid font name offset');
    if (![0, 1, 3].includes(platform)) continue;
    const value = new TextDecoder(platform === 1 ? 'macintosh' : 'utf-16be')
      .decode(bytes.subarray(start, start + length))
      .replace(/\0/g, '');
    const score = (language === 0x409 ? 4 : 0) + (platform === 3 ? 2 : platform === 0 ? 1 : 0);
    if (!values.has(id) || values.get(id)!.score < score) values.set(id, { value, score });
  }
  const family = values.get(1)?.value;
  if (!family) throw new Error('Font has no family name');
  const style = values.get(2)?.value ?? 'Regular';
  const os2 = tables.get('OS/2');
  const weight =
    os2 && os2.size >= 6 ? v.getUint16(os2.start + 4) : /bold/i.test(style) ? 700 : 400;
  return {
    family,
    fullName: values.get(4)?.value ?? family,
    style,
    weight,
    italic: /italic|oblique/i.test(style),
  };
}
