import { expect, test } from 'bun:test';
import { VirtualFileSystem } from '../../src/worker/runtime/filesystem/vfs';

test('overlapping CRT flushes persist save backpatches in guest write order', async () => {
  const vfs = new VirtualFileSystem();
  // Initialization constructs the production overlay even without browser OPFS.
  await vfs.initOverlay('save-backpatch-test').catch(() => {});
  const overlay = (vfs as any).overlay;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const disk = new Uint8Array(64);
  let cursor = 0;
  let opens = 0;
  const writer = {
    async seek(offset: number) { cursor = offset; },
    async write(buffer: ArrayBuffer) { disk.set(new Uint8Array(buffer), cursor); },
    async close() {},
  };
  overlay.getFileHandle = async () => ({
    async createWritable() { opens++; await gate; return writer; },
  });
  overlay.scheduleWriterCleanup = () => {};
  const path = 'C:\\SaveGame\\test.sav';
  overlay.prepareCreateSync(path);
  overlay.writeFileSync(path, 0, new TextEncoder().encode('GAME0000'));
  overlay.writeFileSync(path, 32, new TextEncoder().encode('DICT'));
  overlay.writeFileSync(path, 4, new Uint8Array([32, 0, 0, 0]));
  overlay.writeFileSync(path, 48, new TextEncoder().encode('DEND'));
  release();
  await overlay.flushFile(path);
  expect(opens).toBe(1);
  expect(new TextDecoder().decode(disk.subarray(0, 4))).toBe('GAME');
  expect(new DataView(disk.buffer).getUint32(4, true)).toBe(32);
  expect(new TextDecoder().decode(disk.subarray(32, 36))).toBe('DICT');
  expect(new TextDecoder().decode(disk.subarray(48, 52))).toBe('DEND');
});
