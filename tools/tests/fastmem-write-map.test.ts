import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AddressSpace } from '../../src/worker/core/memory/address-space';
import { PageTableManager } from '../../src/worker/core/memory/page-table-manager';

const PAGE = 0x1000;
const PD = 0x100000;
const TARGET = 0x700000;

describe('fastmem write-map qualification', () => {
    let mem: Uint8Array;
    let map: Uint8Array;
    let maxPage: number;
    let wasm: any;

    beforeEach(() => {
        mem = new Uint8Array(8 * 1024 * 1024);
        map = new Uint8Array(1 << 20);
        maxPage = 0;
        wasm = {
            fastmem_write_map_reset() { map.fill(0); maxPage = 0; },
            fastmem_write_map_set_exclude() {},
            fastmem_write_map_set_base(start: number, count: number, writable: number) {
                for (let page = start; page < start + count; page++) {
                    if (writable) { map[page] |= 1; maxPage = Math.max(maxPage, page); }
                    else map[page] &= ~1;
                }
            },
            fastmem_write_map_get(page: number) { return map[page]; },
            fastmem_write_map_max_page() { return maxPage; },
            fastmem_bump_generation() {},
            full_clear_tlb() {},
        };
        (globalThis as any).preemption = { getWasmExports: () => wasm };
    });

    afterEach(() => { delete (globalThis as any).preemption; });

    test('protection, decommit and recommit synchronously change qualification', () => {
        const pages = new PageTableManager(() => mem, () => wasm, PD);
        pages.initialize(mem.length);
        pages.enablePaging({ cr: [0, 0, 0, 0] });
        pages.rebuildWriteMap([{ base: TARGET, size: 2 * PAGE }]);
        expect(map[TARGET >>> 12] & 1).toBe(1);
        expect(map[(TARGET >>> 12) + 1] & 1).toBe(1);

        pages.setProtection(TARGET, PAGE, 0x02);
        expect(map[TARGET >>> 12] & 1).toBe(0);
        pages.setProtection(TARGET, PAGE, 0x04);
        expect(map[TARGET >>> 12] & 1).toBe(1);

        pages.decommitPages(TARGET, PAGE);
        expect(map[TARGET >>> 12] & 1).toBe(0);
        pages.commitPages(TARGET, PAGE);
        expect(map[TARGET >>> 12] & 1).toBe(1);
        expect(pages.auditWriteMap()?.danger).toBe(0);
    });

    test('address-space release and remap cannot retain stale writability', () => {
        const addressSpace = new AddressSpace(() => mem);
        const id = addressSpace.mapRegion(TARGET, PAGE, 'rw', 'HEAP', 'test');
        expect(id).toBeGreaterThan(0);
        expect(map[TARGET >>> 12] & 1).toBe(1);
        expect(addressSpace.releaseRegion(TARGET)).toBe(true);
        expect(map[TARGET >>> 12] & 1).toBe(0);
        addressSpace.mapRegion(TARGET, PAGE, 'rx', 'HEAP', 'test-remap');
        expect(map[TARGET >>> 12] & 1).toBe(0);
    });
});
