import { afterEach, expect, test } from 'bun:test';
import { System } from '../../src/worker/core/system';
import { PageTableManager } from '../../src/worker/core/memory/page-table-manager';
import { ensureGuestPagesCommitted } from '../../src/worker/core/memory/guest-page-commit';
import { exports } from '../../src/worker/modules/kernel32/memory';

const system = System.getInstance();
const previousProcess = system.process;
afterEach(() => { system.process = previousProcess; });

test('released readonly stream pages become inaccessible, then writable and zeroed on heap reuse', () => {
    const memory = new Uint8Array(8 * 1024 * 1024);
    const view = new DataView(memory.buffer);
    const base = 0x600000, size = 0x2000, directory = 0x100000;
    const pages = new PageTableManager(() => memory, () => ({}), directory);
    pages.initialize(memory.length);
    pages.enablePaging({ cr: [0, 0, 0, 0] });
    let allocated = false;
    system.process = {
        pageTableManager: pages,
        memory: {
            alloc: () => { allocated = true; return base; },
            getSize: () => allocated ? size : undefined,
            free: () => { allocated = false; },
        },
    } as unknown as NonNullable<typeof system.process>;
    const call = (name: string, args: number[]) => exports[name]!({} as never, memory, args);
    const flags = (address: number) => view.getUint32(directory + 0x1000 + (address >>> 12) * 4, true) & 7;
    expect(call('VirtualAlloc', [0, size, 0x3000, 4])).toBe(base);
    memory.fill(0xa5, base, base + size + 0x1000);
    pages.setProtection(base, size, 2);
    expect(flags(base)).toBe(5);
    expect(call('VirtualFree', [base, 0, 0x8000])).toBe(1);
    expect(allocated).toBe(false);
    expect(flags(base) & 1).toBe(0);
    expect(flags(base + 0x1000) & 1).toBe(0);
    expect(flags(base + size)).toBe(7);

    // The same production hook used by MemoryManager.alloc for the next owner.
    ensureGuestPagesCommitted(base, 0x1000);
    expect(flags(base)).toBe(7);
    expect(flags(base + 0x1000) & 1).toBe(0);
    expect(memory.subarray(base, base + 0x1000).every(byte => byte === 0)).toBe(true);
    expect(memory[base + size]).toBe(0xa5);
});
