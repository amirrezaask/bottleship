import { expect, test } from 'bun:test';
import { createOpenGLContext, type GLClearCommand } from '../../src/worker/modules/opengl32/context';
import { createStateExports } from '../../src/worker/modules/opengl32/state';
import { clearDrawCommand, clearMask, clearNeedsDraw } from '../../src/worker/backends/webgpu/opengl/clear-command';
import { GL_COLOR_BUFFER_BIT, GL_DEPTH_BUFFER_BIT, GL_STENCIL_BUFFER_BIT, GL_SCISSOR_TEST } from '../../src/worker/modules/opengl32/constants';

test('a clipped panel clear preserves depth, stencil and masked color channels outside its writes', () => {
  const ctx = createOpenGLContext({} as any);
  const gl = createStateExports(ctx);
  const call = (name: string, ...args: number[]) => gl[name]!({} as any, new Uint8Array(), args as any);
  ctx.enableFlags.add(GL_SCISSOR_TEST);
  call('glScissor', 20, 30, 100, 50);
  call('glColorMask', 0, 1, 0, 0);
  call('glDepthMask', 0);
  ctx.clearG = 1;
  ctx.stencilWriteMask = 0x0f;
  ctx.clearStencil = 0xaa;
  call('glClear', GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT | GL_STENCIL_BUFFER_BIT);
  // Later GL state changes cannot affect the already-issued clear.
  call('glScissor', 0, 0, 640, 480);
  call('glColorMask', 1, 1, 1, 1);
  const clear = ctx.commands[0] as GLClearCommand;
  expect(clearNeedsDraw(clear, 640, 480)).toBe(true);
  expect(clearMask(clear)).toBe(GL_COLOR_BUFFER_BIT | GL_STENCIL_BUFFER_BIT);
  const draw = clearDrawCommand(clear, 640, 480);
  expect([draw.scissorX, draw.scissorY, draw.scissorW, draw.scissorH]).toEqual([20, 30, 100, 50]);
  expect([draw.colorMaskR, draw.colorMaskG, draw.colorMaskB, draw.colorMaskA]).toEqual([false, true, false, false]);
  expect(draw.depthMask).toBe(false);
  expect(draw.stencilWriteMask).toBe(0x0f);
  expect(draw.stencilRef).toBe(0xaa);
  expect(draw.blendEnabled).toBe(false);
  expect(draw.textureId0).toBe(0);
  expect(draw.vpW).toBe(640);
  // Full-area clears retain the render-pass loadOp fast path.
  expect(clearNeedsDraw({ ...clear, mask: GL_COLOR_BUFFER_BIT,
    scissorX: 0, scissorY: 0, scissorW: 640, scissorH: 480,
    colorMaskR: true, colorMaskG: true, colorMaskB: true, colorMaskA: true }, 640, 480)).toBe(false);
});
