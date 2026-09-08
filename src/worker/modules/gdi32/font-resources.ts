import { System } from '../../core/system';
import { Marshaler } from '../../core/memory/marshaler';
import type { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { readFontInfo } from './sfnt-font';

type FontInfo = ReturnType<typeof readFontInfo>;
export function registerFontResourceExports(exports: Record<string, ThunkImplementation>) {
  const fonts = (globalThis as unknown as { fonts: FontFaceSet }).fonts;
  let owner: unknown;
  let generation = -1;
  const resources = new Map<string, { info: FontInfo; face: FontFace; refs: number }>();
  const current = () => {
    const process = System.getInstance().process!;
    if (owner !== process || generation !== process.resetGeneration) {
      for (const r of resources.values()) fonts.delete(r.face);
      resources.clear();
      owner = process;
      generation = process.resetGeneration;
    }
    return process;
  };
  const readString = (mem: Uint8Array, p: number, wide: boolean) =>
    !p ? '' : wide ? Marshaler.readWideString(mem, p) : Marshaler.readString(mem, p);
  for (const wide of [false, true]) {
    const suffix = wide ? 'W' : 'A';
    exports['AddFontResource' + suffix] = async (_ctx, mem, args) => {
      current();
      const fs = System.getInstance().fileSystem;
      const path = fs.resolvePath(readString(mem, args[0], wide));
      const key = path.toLowerCase();
      const existing = resources.get(key);
      if (existing) {
        existing.refs++;
        return 1;
      }
      const handle = fs.openSync(path, 0x80000000, 3);
      if (!handle) return 0;
      try {
        const bytes = await fs.read(handle, fs.getFileSize(path));
        const info = readFontInfo(bytes);
        const face = new FontFace(info.family, bytes.slice().buffer, {
          weight: String(info.weight),
          style: info.italic ? 'italic' : 'normal',
        });
        await face.load();
        fonts.add(face);
        resources.set(key, { info, face, refs: 1 });
        return 1;
      } catch {
        return 0;
      }
    };
    exports['RemoveFontResource' + suffix] = (_ctx, mem, args) => {
      current();
      const key = System.getInstance()
        .fileSystem.resolvePath(readString(mem, args[0], wide))
        .toLowerCase();
      const resource = resources.get(key);
      if (!resource) return 0;
      if (--resource.refs === 0) {
        fonts.delete(resource.face);
        resources.delete(key);
      }
      return 1;
    };
    exports['EnumFontFamiliesEx' + suffix] = (ctx, mem, args) => {
      const process = current();
      const manager = process.dispatcher?.callbackManager;
      const [hdc, query, callback, lParam, flags] = args;
      if (!query || !callback || !manager || flags) return 0;
      const family = readString(mem, query + 28, wide).toLowerCase();
      const charset = mem[query + 23];
      // Built-in Windows aliases are mapped to the runtime's bundled Liberation fonts.
      const builtins = ['Arial', 'Times New Roman', 'Courier New', 'Tahoma', 'MS Sans Serif'].map(
        (family) => ({ family, fullName: family, style: 'Regular', weight: 400, italic: false }),
      );
      const candidates = [...resources.values()]
        .map((r) => r.info)
        .concat(builtins)
        .filter(
          (f) =>
            (!family || f.family.toLowerCase() === family || f.fullName.toLowerCase() === family) &&
            (charset === 0 || charset === 1),
        );
      if (!candidates.length) return 0;
      const size = wide ? 348 : 188;
      const buffer = process.memory.alloc(size + 100);
      const frameId = manager.saveSuspendedThunkContext(ctx, 20, 'EnumFontFamiliesEx' + suffix);
      let index = 0;
      const invoke = (): ReturnType<typeof manager.invokeCallback> => {
        const font = candidates[index++];
        const memory = process.getCurrentMemory();
        const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
        memory.fill(0, buffer, buffer + size + 100);
        const string = (offset: number, value: string, max: number) => {
          for (let i = 0; i < Math.min(value.length, max - 1); i++) {
            if (wide) view.setUint16(buffer + offset + i * 2, value.charCodeAt(i), true);
            else memory[buffer + offset + i] = value.charCodeAt(i) & 255;
          }
        };
        view.setInt32(buffer, 16, true);
        view.setInt32(buffer + 16, font.weight, true);
        memory[buffer + 20] = font.italic ? 1 : 0;
        memory[buffer + 27] = 0x22;
        string(28, font.family, 32);
        string(wide ? 92 : 60, font.fullName, 64);
        string(wide ? 220 : 124, font.style, 32);
        string(wide ? 284 : 156, 'Western', 32);
        const tm = buffer + size;
        for (const [offset, value] of [
          [0, 16],
          [4, 12],
          [8, 4],
          [20, 8],
          [24, 16],
          [28, font.weight],
          [36, 96],
          [40, 96],
        ])
          view.setInt32(tm + offset, value, true);
        const charSize = wide ? 2 : 1;
        [32, 255, 63, 32].forEach((value, i) => {
          if (wide) view.setUint16(tm + 44 + i * charSize, value, true);
          else memory[tm + 44 + i] = value;
        });
        memory[tm + 44 + 4 * charSize] = font.italic ? 1 : 0;
        memory[tm + 47 + 4 * charSize] = 0x26;
        const ntm = wide ? 60 : 56;
        view.setUint32(tm + ntm, font.weight >= 700 ? 0x20 : font.italic ? 1 : 0x40, true);
        view.setUint32(tm + ntm + 4, 2048, true);
        view.setUint32(tm + ntm + 8, 16, true);
        view.setUint32(tm + ntm + 12, 8, true);
        return manager.invokeCallback(
          callback,
          [buffer, tm, 4, lParam],
          0,
          (result: number) => {
            if (result !== 0 && index < candidates.length) {
              invoke();
              return null;
            }
            process.memory.free(buffer);
            return result;
          },
          false,
          'EnumFontFamiliesEx' + suffix,
          frameId,
        );
      };
      const { callbackId } = invoke();
      return { value: 0, suspendedForCallback: true, callbackId, stackCleanup: 20 };
    };
  }
}
