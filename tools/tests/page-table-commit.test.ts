import { describe, expect, test } from 'bun:test';
import { PageTableManager } from '../../src/worker/core/memory/page-table-manager';

const PAGE = 4096, PD = 0x100000, TARGET = 0x700000;

function fixture(nativeInvalidation = true) {
    const memory = new Uint8Array(8 * 1024 * 1024);
    const view = new DataView(memory.buffer);
    const events: unknown[][] = [];
    const exports = {
        fastmem_bump_generation: (source: number) => events.push(['generation', source]),
        full_clear_tlb: () => events.push(['tlb']),
        ...(nativeInvalidation ? { jit_dirty_cache: (start: number, end: number) => {
            events.push(['invalidate', start, end, memory[start]]);
        } } : {}),
    };
    const pages = new PageTableManager(() => memory, () => exports, PD);
    pages.initialize(memory.length);
    pages.enablePaging({ cr: [0, 0, 0, 0] });
    events.length = 0;
    const pte = (address: number) => PD + PAGE + (address >>> 12) * 4;
    return { memory, view, events, pages, pte };
}

describe('page commit invalidation', () => {
    test('existing identity RW mappings invalidate written code before zeroing without global deopt', () => {
        const { memory, view, events, pages, pte } = fixture();
        memory.fill(0xa5, TARGET, TARGET + PAGE);
        view.setUint32(pte(TARGET), TARGET | 0x67, true); // accessed and dirty
        pages.commitPages(TARGET, PAGE);
        expect(events).toEqual([['invalidate', TARGET, TARGET + PAGE, 0xa5]]);
        expect(view.getUint32(pte(TARGET), true)).toBe(TARGET | 0x67);
        expect(memory.subarray(TARGET, TARGET + PAGE).every(byte => byte === 0)).toBe(true);
        expect(pages.getCommitStats()).toEqual({ calls: 1, unchangedMappings: 1 });
    });

    for (const [name, old] of [['decommitted', TARGET | 6], ['readonly', TARGET | 5],
        ['remapped', (TARGET + PAGE) | 7], ['supervisor', TARGET | 3]] as const) {
        test(`${name} mappings retain generation invalidation and TLB flush`, () => {
            const { view, events, pages, pte } = fixture();
            view.setUint32(pte(TARGET), old, true);
            pages.commitPages(TARGET, 2 * PAGE);
            expect(events).toEqual([['invalidate', TARGET, TARGET + 2 * PAGE, 0], ['generation', 6], ['tlb']]);
            expect(view.getUint32(pte(TARGET), true)).toBe(TARGET | 7);
            expect(pages.getCommitStats()).toEqual({ calls: 1, unchangedMappings: 0 });
        });
    }

    test('older native runtimes keep conservative invalidation', () => {
        const { events, pages } = fixture(false);
        pages.commitPages(TARGET, PAGE);
        expect(events).toEqual([['generation', 6], ['tlb']]);
    });
});
