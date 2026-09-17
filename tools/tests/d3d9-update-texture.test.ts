import { afterEach, expect, test } from "bun:test";
import { createResourcesExports } from "../../src/worker/modules/d3d9/resources";
import { devices, resourceToDevice } from "../../src/worker/modules/d3d9/shared-state";
import { textureMeta } from "../../src/worker/modules/d3d9/resource-registry";

const D3DERR_INVALIDCALL = 0x8876086c;
const updateTexture = createResourcesExports().IDirect3DDevice9_UpdateTexture!;

function registerTexture(pointer: number, device: any, levels = 1): void {
  resourceToDevice.set(pointer, device);
  textureMeta.set(pointer, {
    width: 2,
    height: 2,
    levels,
    usage: 0,
    pool: 0,
    format: 21,
  });
}

afterEach(() => {
  devices.clear();
  resourceToDevice.clear();
  textureMeta.clear();
});

test("UpdateTexture copies every bounded mip row and releases lock staging", () => {
  const memory = new Uint8Array(128);
  memory.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], 16);
  const unlocks: Array<[number, number]> = [];
  const device = {
    lockTexture: (pointer: number, level: number) => ({
      ptr: pointer === 10 ? 16 : 64,
      pitch: level === 0 ? 8 : 4,
    }),
    unlockTexture: (pointer: number, level: number) => {
      unlocks.push([pointer, level]);
      return 0;
    },
  } as any;
  devices.set(1, device);
  registerTexture(10, device);
  registerTexture(20, device);

  expect(updateTexture({} as never, memory, [1, 10, 20])).toBe(0);
  expect(Array.from(memory.subarray(64, 80))).toEqual(Array.from(memory.subarray(16, 32)));
  expect(unlocks).toEqual([[10, 0], [20, 0]]);
});

test("UpdateTexture rejects mismatched and out-of-bounds resources", () => {
  const memory = new Uint8Array(64);
  const device = {
    lockTexture: (pointer: number) => ({ ptr: pointer === 10 ? 48 : 56, pitch: 8 }),
    unlockTexture: () => 0,
  } as any;
  devices.set(1, device);
  registerTexture(10, device);
  registerTexture(20, device);

  textureMeta.get(20)!.format = 22;
  expect(updateTexture({} as never, memory, [1, 10, 20])).toBe(D3DERR_INVALIDCALL);
  textureMeta.get(20)!.format = 21;
  expect(updateTexture({} as never, memory, [1, 10, 20])).toBe(D3DERR_INVALIDCALL);
});
