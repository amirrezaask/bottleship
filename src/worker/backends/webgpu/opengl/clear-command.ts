import { GLClearCommand, GLDrawCommand, GLDrawCommandType, VERT_FLOATS } from '../../../modules/opengl32/context';
import { GL_ALWAYS, GL_BACK, GL_CCW, GL_COLOR_BUFFER_BIT, GL_DEPTH_BUFFER_BIT,
    GL_FILL, GL_KEEP, GL_MODULATE, GL_ONE, GL_REPLACE, GL_SMOOTH,
    GL_STENCIL_BUFFER_BIT, GL_TRIANGLES, GL_ZERO } from '../../../modules/opengl32/constants';

export function clearMask(cmd: GLClearCommand): number {
    let mask = cmd.mask;
    if (!cmd.depthMask) mask &= ~GL_DEPTH_BUFFER_BIT;
    if (!(cmd.stencilWriteMask & 0xff)) mask &= ~GL_STENCIL_BUFFER_BIT;
    if (!cmd.colorMaskR && !cmd.colorMaskG && !cmd.colorMaskB && !cmd.colorMaskA) mask &= ~GL_COLOR_BUFFER_BIT;
    return mask;
}

export function clearNeedsDraw(cmd: GLClearCommand, width: number, height: number): boolean {
    const mask = clearMask(cmd);
    const partialRect = cmd.scissorEnabled && (cmd.scissorX > 0 || cmd.scissorY > 0 ||
        cmd.scissorX + cmd.scissorW < width || cmd.scissorY + cmd.scissorH < height);
    const partialColor = (mask & GL_COLOR_BUFFER_BIT) !== 0 &&
        !(cmd.colorMaskR && cmd.colorMaskG && cmd.colorMaskB && cmd.colorMaskA);
    const partialStencil = (mask & GL_STENCIL_BUFFER_BIT) !== 0 && (cmd.stencilWriteMask & 0xff) !== 0xff;
    return partialRect || partialColor || partialStencil;
}

/** A clear ignores textures, transforms, tests and blending, but obeys write masks and scissor. */
export function clearDrawCommand(cmd: GLClearCommand, width: number, height: number): GLDrawCommand {
    const mask = clearMask(cmd);
    const color = !!(mask & GL_COLOR_BUFFER_BIT);
    const depth = !!(mask & GL_DEPTH_BUFFER_BIT);
    const stencil = !!(mask & GL_STENCIL_BUFFER_BIT);
    const clamp = (n: number) => Math.max(0, Math.min(1, n));
    const data = new Float32Array(6 * VERT_FLOATS);
    const positions = [-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1];
    for (let i = 0; i < 6; i++) {
        data.set([positions[i * 2], positions[i * 2 + 1], clamp(cmd.depth) * 2 - 1, 1,
            clamp(cmd.r), clamp(cmd.g), clamp(cmd.b), clamp(cmd.a)], i * VERT_FLOATS);
    }
    return {
        type: GLDrawCommandType.DRAW, mode: GL_TRIANGLES, vertData: data, vertCount: 6,
        depthTest: depth, depthFunc: GL_ALWAYS, depthMask: depth,
        blendEnabled: false, blendSrc: GL_ONE, blendDst: GL_ZERO,
        alphaTest: false, alphaFunc: GL_ALWAYS, alphaRef: 0,
        cullEnabled: false, cullFace: GL_BACK, frontFace: GL_CCW,
        textureId0: 0, textureId1: 0, texEnvMode0: GL_MODULATE, texEnvMode1: GL_MODULATE,
        shadeModel: GL_SMOOTH, fogEnabled: false, fogMode: 0,
        fogR: 0, fogG: 0, fogB: 0, fogA: 0, fogDensity: 0, fogStart: 0, fogEnd: 1,
        polygonMode: GL_FILL, colorMaskR: color && cmd.colorMaskR, colorMaskG: color && cmd.colorMaskG,
        colorMaskB: color && cmd.colorMaskB, colorMaskA: color && cmd.colorMaskA,
        stencilTest: stencil, stencilFunc: GL_ALWAYS, stencilRef: cmd.stencil & 0xff,
        stencilMask: 0xff, stencilFail: GL_KEEP, stencilZFail: GL_KEEP, stencilZPass: GL_REPLACE,
        stencilWriteMask: stencil ? cmd.stencilWriteMask & 0xff : 0,
        scissorEnabled: cmd.scissorEnabled, scissorX: cmd.scissorX, scissorY: cmd.scissorY,
        scissorW: cmd.scissorW, scissorH: cmd.scissorH,
        vpX: 0, vpY: 0, vpW: width, vpH: height, depthRangeNear: 0, depthRangeFar: 1,
    };
}
