/** A mapped PE32 image for guests which discover exports without GetProcAddress. */
export const PE_IMAGE_SIZE = 0x10000;
const TEXT = 0x8000;
const EXPORTS = 0x1000;

export class PeImage {
  readonly exports = new Map<string, number>();
  private entries = new Map<string, { name: string; target: number; address: number }>();

  constructor(
    readonly name: string,
    readonly base: number,
  ) {}

  update(symbols: Array<{ name: string; address: number; data?: boolean }>): Uint8Array {
    const pending = new Map(this.entries);
    for (const symbol of symbols) {
      const key = symbol.name.toLowerCase();
      const previous = pending.get(key);
      const address = symbol.data
        ? symbol.address
        : (previous?.address ?? this.base + TEXT + pending.size * 16);
      if (!symbol.data && address + 16 > this.base + PE_IMAGE_SIZE)
        throw new Error(`Too many PE exports in ${this.name}`);
      pending.set(key, { name: symbol.name, target: symbol.address, address });
    }
    const bytes = new Uint8Array(PE_IMAGE_SIZE);
    const view = new DataView(bytes.buffer);
    const u16 = (p: number, v: number) => view.setUint16(p, v, true);
    const u32 = (p: number, v: number) => view.setUint32(p, v >>> 0, true);
    const string = (p: number, s: string) => {
      bytes.set(new TextEncoder().encode(s), p);
      return p + s.length + 1;
    };
    u16(0, 0x5a4d);
    u32(0x3c, 0x80);
    u32(0x80, 0x4550);
    u16(0x84, 0x14c);
    u16(0x86, 2);
    u16(0x94, 0xe0);
    u16(0x96, 0x2102);
    const opt = 0x98;
    u16(opt, 0x10b);
    u32(opt + 28, this.base);
    u32(opt + 32, 0x1000);
    u32(opt + 36, 0x200);
    u16(opt + 40, 4);
    u16(opt + 48, 4);
    u32(opt + 56, PE_IMAGE_SIZE);
    u32(opt + 60, 0x1000);
    u16(opt + 68, 2);
    u32(opt + 92, 16);
    u32(opt + 96, EXPORTS);
    const section = (p: number, name: string, start: number, size: number, flags: number) => {
      string(p, name);
      u32(p + 8, size);
      u32(p + 12, start);
      u32(p + 16, size);
      u32(p + 20, start);
      u32(p + 36, flags);
    };
    section(0x178, '.edata', EXPORTS, TEXT - EXPORTS, 0x40000040);
    section(0x1a0, '.text', TEXT, PE_IMAGE_SIZE - TEXT, 0x60000020);
    const entries = [...pending.values()];
    const named = entries
      .filter((e) => !/^ord_\d+$/.test(e.name))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const used = new Set(
      entries.filter((e) => /^ord_\d+$/.test(e.name)).map((e) => Number(e.name.slice(4))),
    );
    const ordinals = new Map<string, number>();
    let next = 1;
    for (const entry of entries) {
      if (/^ord_\d+$/.test(entry.name)) ordinals.set(entry.name, Number(entry.name.slice(4)));
      else {
        while (used.has(next)) next++;
        ordinals.set(entry.name, next);
        used.add(next++);
      }
    }
    const ordinalBase = used.has(0) ? 0 : 1;
    const functionCount = used.size ? Math.max(...used) - ordinalBase + 1 : 0;
    const eat = EXPORTS + 40;
    const names = eat + functionCount * 4;
    const ordinalTable = names + named.length * 4;
    let cursor = ordinalTable + named.length * 2;
    const required =
      cursor + this.name.length + 5 + named.reduce((n, e) => n + e.name.length + 1, 0);
    if (required > TEXT) throw new Error(`PE export directory exceeds capacity for ${this.name}`);
    u32(EXPORTS + 12, cursor);
    cursor = string(cursor, this.name + '.dll');
    u32(EXPORTS + 16, ordinalBase);
    u32(EXPORTS + 20, functionCount);
    u32(EXPORTS + 24, named.length);
    u32(EXPORTS + 28, eat);
    u32(EXPORTS + 32, names);
    u32(EXPORTS + 36, ordinalTable);
    for (const entry of entries) {
      u32(eat + (ordinals.get(entry.name)! - ordinalBase) * 4, entry.address - this.base);
      if (entry.address !== entry.target) {
        const rva = entry.address - this.base;
        bytes[rva] = 0xe9;
        u32(rva + 1, entry.target - entry.address - 5);
      }
    }
    named.forEach((entry, i) => {
      u32(names + i * 4, cursor);
      u16(ordinalTable + i * 2, ordinals.get(entry.name)! - ordinalBase);
      cursor = string(cursor, entry.name);
    });
    u32(opt + 100, cursor - EXPORTS);
    this.entries = pending;
    this.exports.clear();
    for (const [key, entry] of pending) this.exports.set(key, entry.address);
    return bytes;
  }
}
