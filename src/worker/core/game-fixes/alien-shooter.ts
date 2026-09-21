import type { LoadedPEModule } from '../module-registry';

export const ALIEN_SHOOTER_SOURCE_SHA256 =
    '9bc0b10edd1740d57aff0f9252c83541a6f3ebd1294e103f7eee6831df14391d';

// This executable updates its cursor in WM_NCHITTEST (Input::message at
// 0x425dc7), before its ordinary client mouse message. Older prepared loaders
// omit sourceHash; independent PE and complete instruction signatures retain
// an exact code guard for those installed bundles too.
const SIGNATURES: ReadonlyArray<readonly [number, readonly number[]]> = [
    [0x404c30, [0x8b, 0x0d, 0x38, 0x07, 0x49, 0x00, 0x8b, 0x01, 0x83, 0xec, 0x08, 0x53]],
    [0x425d80, [0x8b, 0x44, 0x24, 0x08, 0x83, 0xec, 0x10, 0x3d, 0x01, 0x02, 0x00, 0x00, 0x56, 0x8b, 0xf1]],
    [0x425dc7, [0x8b, 0x4c, 0x24, 0x18, 0x8d, 0x44, 0x24, 0x04, 0x50, 0x51, 0xff, 0x15, 0x90, 0xa1, 0x47, 0x00]],
];

export interface MouseMessagePrelude {
    message: number;
    wParam: number;
    lParam: number;
}

export function alienShooterMousePrelude(
    module: LoadedPEModule | undefined,
    memory: Uint8Array,
    window: { title: string; wndProc: number; parent?: number; x: number; y: number },
    message: number,
    lParam: number,
): MouseMessagePrelude | undefined {
    if (message < 0x0200 || message > 0x0209 || window.parent ||
        window.title !== 'AlienShooter' || window.wndProc !== 0x404c30 ||
        !module?.isExecutable || module.name.toLowerCase() !== 'alienshooter' ||
        module.baseAddress !== 0x400000 || module.size !== 0x1f9000 ||
        (module.sourceHash !== undefined && module.sourceHash !== ALIEN_SHOOTER_SOURCE_SHA256) ||
        memory.length < 0x425dd7) return undefined;

    // getCurrentMemory can be a virtual-address proxy; reading its backing
    // ArrayBuffer directly would bypass the PE header's mapping.
    const u32 = (address: number): number => (memory[address] |
        (memory[address + 1] << 8) | (memory[address + 2] << 16) |
        (memory[address + 3] << 24)) >>> 0;
    if (u32(0x40003c) !== 0x118 || u32(0x400118) !== 0x00004550 ||
        u32(0x400120) !== 0x40c94276) return undefined;
    for (const [address, signature] of SIGNATURES) {
        for (let i = 0; i < signature.length; i++) {
            if (memory[address + i] !== signature[i]) return undefined;
        }
    }

    // Mouse client coordinates are signed 16-bit values. NCHITTEST instead
    // receives screen coordinates; this guard admits only the top-level window.
    const x = (lParam << 16 >> 16) + window.x;
    const y = (lParam >> 16) + window.y;
    return { message: 0x0084, wParam: 0, lParam: ((y & 0xffff) << 16) | (x & 0xffff) };
}
