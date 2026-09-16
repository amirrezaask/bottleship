import { expect, test } from 'bun:test';
import { createOpenGLContext } from '../../src/worker/modules/opengl32/context';
import { createArrayExports } from '../../src/worker/modules/opengl32/arrays';
import { GL_POINTS, GL_FLOAT, GL_UNSIGNED_BYTE } from '../../src/worker/modules/opengl32/constants';

test('indexed arrays use guest-relative byte indices', () => {
  const backing = new ArrayBuffer(2048);
  const memory = new Uint8Array(backing, 512, 1024);
  const view = new DataView(backing, memory.byteOffset, memory.byteLength);
  const ctx = createOpenGLContext({ getCurrentMemory() { return memory; } } as any);
  const gl = createArrayExports(ctx);
  const call = (name: string, ...args: number[]) => gl[name]!({} as any, memory, args as any);
  // Strided XYZ with a padding word, indexed in reverse order.
  for (let i = 0; i < 2; i++) {
    view.setFloat32(64 + i * 16, i + 0.25, true);
    view.setFloat32(68 + i * 16, i + 0.5, true);
    view.setFloat32(72 + i * 16, i + 0.75, true);
  }
  memory.set([1, 0], 32);
  memory.set([255, 128, 0, 64, 0, 255, 128, 255], 128);
  ctx.vertexArray.enabled = true;
  ctx.colorArray.enabled = true;
  call('glVertexPointer', 3, GL_FLOAT, 16, 64);
  call('glColorPointer', 4, GL_UNSIGNED_BYTE, 0, 128);
  call('glDrawElements', GL_POINTS, 2, GL_UNSIGNED_BYTE, 32);
  const cmd = ctx.commands.at(-1) as any;
  expect(cmd.vertCount).toBe(2);
  expect(Array.from(cmd.vertData.slice(0, 4))).toEqual([1.25, 1.5, 1.75, 1]);
  expect(Array.from(cmd.vertData.slice(15, 19))).toEqual([0.25, 0.5, 0.75, 1]);
  expect(cmd.vertData[4]).toBe(0);
  expect(cmd.vertData[5]).toBe(1);
  expect(cmd.vertData[6]).toBeCloseTo(128 / 255);
  expect(cmd.vertData[22]).toBeCloseTo(64 / 255);
  // Submitted data owns its snapshot despite subsequent guest memory changes.
  memory.fill(0);
  expect(cmd.vertData[0]).toBe(1.25);
});
