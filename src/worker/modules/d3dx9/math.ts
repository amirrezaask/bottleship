/** D3DX row-vector math; all scratch storage is private to a synchronous thunk map. */
import { Mem } from '../../core/memory/mem-accessor';
import type { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';

const floatBits = new DataView(new ArrayBuffer(4));
export function u32AsFloat(value: number): number {
    floatBits.setUint32(0, value >>> 0, true);
    return floatBits.getFloat32(0, true);
}

function readFloats(addr: number, out: Float32Array): boolean {
    if (!addr) return false;
    for (let i = 0; i < out.length; i++) {
        const value = Mem.readFloat32(addr + i * 4);
        if (value === null) return false;
        out[i] = value;
    }
    return true;
}

function writeFloats(addr: number, values: Float32Array, transpose = false): boolean {
    if (!addr) return false;
    for (let i = 0; i < values.length; i++) {
        const index = transpose ? (i % 4) * 4 + (i >> 2) : i;
        if (!Mem.writeFloat32(addr + i * 4, values[index])) return false;
    }
    return true;
}

function writeVec3(addr: number, x: number, y: number, z: number): boolean {
    return !!addr && Mem.writeFloat32(addr, x) &&
        Mem.writeFloat32(addr + 4, y) && Mem.writeFloat32(addr + 8, z);
}

function identity(out: Float32Array): void {
    out.fill(0);
    out[0] = out[5] = out[10] = out[15] = 1;
}

function multiply(out: Float32Array, a: Float32Array, b: Float32Array): void {
    for (let row = 0; row < 16; row += 4) {
        const x = a[row], y = a[row + 1], z = a[row + 2], w = a[row + 3];
        for (let col = 0; col < 4; col++) {
            out[row + col] = 0 + x * b[col] + y * b[col + 4] + z * b[col + 8] + w * b[col + 12];
        }
    }
}

export function createMathExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};
    // No callback, await, or borrowed guest view escapes these thunks. Reading all
    // inputs before any output also supports pOut == pM1/pM2 and overlapping views.
    const a = new Float32Array(16), b = new Float32Array(16), out = new Float32Array(16);
    const v = new Float32Array(3), at = new Float32Array(3), up = new Float32Array(3);
    const inverseRows = new Float64Array(32);

    exports['D3DXMatrixIdentity'] = (_ctx, _mem, args) => {
        identity(out);
        return writeFloats(args[0] >>> 0, out) ? args[0] >>> 0 : 0;
    };
    exports['D3DXMatrixMultiply'] = (_ctx, _mem, args) => {
        if (!readFloats(args[1] >>> 0, a) || !readFloats(args[2] >>> 0, b)) return 0;
        multiply(out, a, b);
        return writeFloats(args[0] >>> 0, out) ? args[0] >>> 0 : 0;
    };
    exports['D3DXMatrixMultiplyTranspose'] = (_ctx, _mem, args) => {
        if (!readFloats(args[1] >>> 0, a) || !readFloats(args[2] >>> 0, b)) return 0;
        multiply(out, a, b);
        return writeFloats(args[0] >>> 0, out, true) ? args[0] >>> 0 : 0;
    };
    exports['D3DXMatrixTranspose'] = (_ctx, _mem, args) => {
        if (!readFloats(args[1] >>> 0, a)) return 0;
        return writeFloats(args[0] >>> 0, a, true) ? args[0] >>> 0 : 0;
    };
    exports['D3DXMatrixTranslation'] = (_ctx, _mem, args) => {
        identity(out);
        out[12] = u32AsFloat(args[1]); out[13] = u32AsFloat(args[2]); out[14] = u32AsFloat(args[3]);
        return writeFloats(args[0] >>> 0, out) ? args[0] >>> 0 : 0;
    };
    exports['D3DXMatrixScaling'] = (_ctx, _mem, args) => {
        identity(out);
        out[0] = u32AsFloat(args[1]); out[5] = u32AsFloat(args[2]); out[10] = u32AsFloat(args[3]);
        return writeFloats(args[0] >>> 0, out) ? args[0] >>> 0 : 0;
    };
    exports['D3DXMatrixRotationX'] = (_ctx, _mem, args) => {
        identity(out);
        const angle = u32AsFloat(args[1]), c = Math.cos(angle), s = Math.sin(angle);
        out[5] = out[10] = c; out[6] = s; out[9] = -s;
        return writeFloats(args[0] >>> 0, out) ? args[0] >>> 0 : 0;
    };
    exports['D3DXMatrixRotationY'] = (_ctx, _mem, args) => {
        identity(out);
        const angle = u32AsFloat(args[1]), c = Math.cos(angle), s = Math.sin(angle);
        out[0] = out[10] = c; out[2] = -s; out[8] = s;
        return writeFloats(args[0] >>> 0, out) ? args[0] >>> 0 : 0;
    };
    exports['D3DXMatrixRotationZ'] = (_ctx, _mem, args) => {
        identity(out);
        const angle = u32AsFloat(args[1]), c = Math.cos(angle), s = Math.sin(angle);
        out[0] = out[5] = c; out[1] = s; out[4] = -s;
        return writeFloats(args[0] >>> 0, out) ? args[0] >>> 0 : 0;
    };

    const perspective = (args: number[], left: boolean): number => {
        const fov = u32AsFloat(args[1]), aspect = u32AsFloat(args[2]);
        const zn = u32AsFloat(args[3]), zf = u32AsFloat(args[4]);
        out.fill(0);
        const yScale = 1 / Math.tan(fov * 0.5);
        out[5] = yScale;
        out[0] = aspect !== 0 ? yScale / aspect : yScale;
        out[10] = left ? zf / (zf - zn) : zf / (zn - zf);
        out[11] = left ? 1 : -1;
        out[14] = left ? -zn * zf / (zf - zn) : zn * zf / (zn - zf);
        return writeFloats(args[0] >>> 0, out) ? args[0] >>> 0 : 0;
    };
    exports['D3DXMatrixPerspectiveFovLH'] = (_ctx, _mem, args) => perspective(args, true);
    exports['D3DXMatrixPerspectiveFovRH'] = (_ctx, _mem, args) => perspective(args, false);

    const ortho = (args: number[], left: boolean): number => {
        const width = u32AsFloat(args[1]), height = u32AsFloat(args[2]);
        const zn = u32AsFloat(args[3]), zf = u32AsFloat(args[4]);
        identity(out);
        out[0] = 2 / width; out[5] = 2 / height;
        out[10] = left ? 1 / (zf - zn) : 1 / (zn - zf);
        out[14] = zn / (zn - zf);
        return writeFloats(args[0] >>> 0, out) ? args[0] >>> 0 : 0;
    };
    exports['D3DXMatrixOrthoLH'] = (_ctx, _mem, args) => ortho(args, true);
    exports['D3DXMatrixOrthoRH'] = (_ctx, _mem, args) => ortho(args, false);

    const lookAt = (args: number[], left: boolean): number => {
        if (!readFloats(args[1] >>> 0, v) || !readFloats(args[2] >>> 0, at) || !readFloats(args[3] >>> 0, up)) return 0;
        const direction = left ? 1 : -1;
        let zx = (at[0] - v[0]) * direction, zy = (at[1] - v[1]) * direction, zz = (at[2] - v[2]) * direction;
        let len = Math.hypot(zx, zy, zz);
        if (len === 0) return 0;
        zx /= len; zy /= len; zz /= len;
        let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
        len = Math.hypot(xx, xy, xz);
        if (len === 0) return 0;
        xx /= len; xy /= len; xz /= len;
        const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
        out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
        out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
        out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
        out[12] = -(xx * v[0] + xy * v[1] + xz * v[2]);
        out[13] = -(yx * v[0] + yy * v[1] + yz * v[2]);
        out[14] = -(zx * v[0] + zy * v[1] + zz * v[2]); out[15] = 1;
        return writeFloats(args[0] >>> 0, out) ? args[0] >>> 0 : 0;
    };
    exports['D3DXMatrixLookAtLH'] = (_ctx, _mem, args) => lookAt(args, true);
    exports['D3DXMatrixLookAtRH'] = (_ctx, _mem, args) => lookAt(args, false);

    exports['D3DXMatrixInverse'] = (_ctx, _mem, args) => {
        if (!args[0] || !readFloats(args[2] >>> 0, a)) return 0;
        for (let row = 0; row < 4; row++) {
            for (let col = 0; col < 8; col++) inverseRows[row * 8 + col] = col < 4 ? a[row * 4 + col] : +(col - 4 === row);
        }
        let determinant = 1;
        for (let col = 0; col < 4; col++) {
            let pivot = col;
            for (let row = col + 1; row < 4; row++) {
                if (Math.abs(inverseRows[row * 8 + col]) > Math.abs(inverseRows[pivot * 8 + col])) pivot = row;
            }
            const value = inverseRows[pivot * 8 + col];
            if (value === 0) {
                if (args[1]) Mem.writeFloat32(args[1] >>> 0, 0);
                return 0; // Singular matrices do not overwrite pOut.
            }
            if (pivot !== col) {
                for (let i = 0; i < 8; i++) {
                    const temp = inverseRows[col * 8 + i];
                    inverseRows[col * 8 + i] = inverseRows[pivot * 8 + i];
                    inverseRows[pivot * 8 + i] = temp;
                }
                determinant = -determinant;
            }
            determinant *= value;
            for (let i = 0; i < 8; i++) inverseRows[col * 8 + i] /= value;
            for (let row = 0; row < 4; row++) {
                if (row === col) continue;
                const factor = inverseRows[row * 8 + col];
                for (let i = 0; i < 8; i++) inverseRows[row * 8 + i] -= factor * inverseRows[col * 8 + i];
            }
        }
        for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) out[row * 4 + col] = inverseRows[row * 8 + col + 4];
        if (args[1] && !Mem.writeFloat32(args[1] >>> 0, determinant)) return 0;
        return writeFloats(args[0] >>> 0, out) ? args[0] >>> 0 : 0;
    };

    exports['D3DXVec3Normalize'] = (_ctx, _mem, args) => {
        if (!readFloats(args[1] >>> 0, v)) return 0;
        const len = Math.hypot(v[0], v[1], v[2]);
        if (len === 0) return 0;
        return writeVec3(args[0] >>> 0, v[0] / len, v[1] / len, v[2] / len) ? args[0] >>> 0 : 0;
    };
    exports['D3DXVec3TransformCoord'] = (_ctx, _mem, args) => {
        if (!readFloats(args[1] >>> 0, v) || !readFloats(args[2] >>> 0, a)) return 0;
        const x = v[0] * a[0] + v[1] * a[4] + v[2] * a[8] + a[12];
        const y = v[0] * a[1] + v[1] * a[5] + v[2] * a[9] + a[13];
        const z = v[0] * a[2] + v[1] * a[6] + v[2] * a[10] + a[14];
        const w = v[0] * a[3] + v[1] * a[7] + v[2] * a[11] + a[15];
        if (w === 0) return 0;
        return writeVec3(args[0] >>> 0, x / w, y / w, z / w) ? args[0] >>> 0 : 0;
    };
    exports['D3DXVec3TransformNormal'] = (_ctx, _mem, args) => {
        if (!readFloats(args[1] >>> 0, v) || !readFloats(args[2] >>> 0, a)) return 0;
        const x = v[0] * a[0] + v[1] * a[4] + v[2] * a[8];
        const y = v[0] * a[1] + v[1] * a[5] + v[2] * a[9];
        const z = v[0] * a[2] + v[1] * a[6] + v[2] * a[10];
        return writeVec3(args[0] >>> 0, x, y, z) ? args[0] >>> 0 : 0;
    };
    exports['D3DXVec3Transform'] = (_ctx, _mem, args) => {
        if (!args[0] || !readFloats(args[1] >>> 0, v) || !readFloats(args[2] >>> 0, a)) return 0;
        for (let i = 0; i < 4; i++) {
            if (!Mem.writeFloat32((args[0] >>> 0) + i * 4, v[0] * a[i] + v[1] * a[i + 4] + v[2] * a[i + 8] + a[i + 12])) return 0;
        }
        return args[0] >>> 0;
    };
    exports['D3DXPlaneIntersectLine'] = (_ctx, _mem, args) => {
        const pOut = args[0] >>> 0, pPlane = args[1] >>> 0;
        if (!pOut || !pPlane || !readFloats(args[2] >>> 0, v) || !readFloats(args[3] >>> 0, at)) return 0;
        const nx = Mem.readFloat32(pPlane), ny = Mem.readFloat32(pPlane + 4);
        const nz = Mem.readFloat32(pPlane + 8), d = Mem.readFloat32(pPlane + 12);
        if (nx === null || ny === null || nz === null || d === null) return 0;
        const dx = at[0] - v[0], dy = at[1] - v[1], dz = at[2] - v[2];
        const denom = nx * dx + ny * dy + nz * dz;
        if (denom === 0) return 0;
        const t = -(nx * v[0] + ny * v[1] + nz * v[2] + d) / denom;
        return writeVec3(pOut, v[0] + dx * t, v[1] + dy * t, v[2] + dz * t) ? pOut : 0;
    };
    return exports;
}
