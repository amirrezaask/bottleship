import { describe, expect, it } from "bun:test";
import { CachedSource } from "../../src/worker/runtime/filesystem/cached-source";

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function fixture(size = 4096, maxBytes = 256) {
    const sync: number[] = [];
    const async: Array<[number, number]> = [];
    const bytes = (start: number, end: number) => Uint8Array.from({ length: end - start }, (_, i) => (start + i) % 251);
    const cache = new CachedSource({
        size,
        readRangeSync(start, end) { sync.push(start); return bytes(start, end); },
        async readRange(start, end) { async.push([start, end]); return bytes(start, end); },
    }, { blockSize: 16, maxBytes, syncReadaheadBlocks: 1, prefetchAheadBlocks: 4, prefetchDepthRuns: 4 });
    return { cache, sync, async, bytes };
}

describe("CachedSource seek-aware prefetch", () => {
    it("restarts read-ahead after an EOF directory read followed by a backward seek", async () => {
        const f = fixture();
        f.cache.readRangeSync(4080, 4096);
        f.cache.readRangeSync(0, 16);
        await settle();
        expect(f.async.length).toBeGreaterThan(0);
        const faults = f.sync.length;
        expect(f.cache.readRangeSync(16, 32)).toEqual(f.bytes(16, 32));
        expect(f.sync.length).toBe(faults);
        f.cache.close();
    });

    it("does not prefetch more than the resident working set or evict the read cursor", async () => {
        const f = fixture(4096, 64);
        f.cache.readRangeSync(0, 16);
        await settle();
        expect(f.async.reduce((sum, [start, end]) => sum + end - start, 0)).toBeLessThanOrEqual(48);
        const faults = f.sync.length;
        expect(f.cache.readRangeSync(0, 16)).toEqual(f.bytes(0, 16));
        expect(f.sync.length).toBe(faults);
        expect(f.cache.stats().residentBytes).toBeLessThanOrEqual(64);
        f.cache.close();
    });

    it("evicts consumed history rather than the next unread prefetched block", async () => {
        const f = fixture(4096, 64);
        for (let offset = 0; offset < 1024; offset += 16) {
            expect(f.cache.readRangeSync(offset, offset + 16)).toEqual(f.bytes(offset, offset + 16));
            await settle();
        }
        expect(f.sync).toEqual([0]);
        expect(f.cache.stats().residentBytes).toBeLessThanOrEqual(64);
        f.cache.close();
    });

    it("does not issue duplicate speculative reads when seeking within pending runs", async () => {
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const ranges: Array<[number, number]> = [];
        const cache = new CachedSource({
            size: 4096,
            readRangeSync(s, e) { return new Uint8Array(e - s); },
            async readRange(s, e) { ranges.push([s, e]); await gate; return new Uint8Array(e - s); },
        }, { blockSize: 16, maxBytes: 256, prefetchAheadBlocks: 4, prefetchDepthRuns: 4 });
        cache.readRangeSync(0, 16);
        cache.readRangeSync(64, 80);
        cache.readRangeSync(0, 16);
        release();
        await settle();
        const requested = ranges.flatMap(([s, e]) =>
            Array.from({ length: (e - s) / 16 }, (_, index) => s + index * 16));
        expect(new Set(requested).size).toBe(requested.length);
        cache.close();
    });

    it("discards a completed speculative run after the guest seeks out of its window", async () => {
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const cache = new CachedSource({
            size: 4096,
            readRangeSync(s, e) { return new Uint8Array(e - s); },
            async readRange(s, e) { await gate; return new Uint8Array(e - s); },
        }, { blockSize: 16, maxBytes: 64, prefetchAheadBlocks: 4 });
        cache.readRangeSync(0, 16);
        cache.readRangeSync(4080, 4096);
        release();
        await settle();
        expect(cache.stats().residentBytes).toBe(32);
        expect(cache.stats().prefetchRuns).toBe(1);
        cache.close();
    });

    it("does not fetch anything ahead with a one-block budget", async () => {
        const f = fixture(4096, 16);
        f.cache.readRangeSync(0, 16);
        await settle();
        expect(f.async).toEqual([]);
        f.cache.close();
    });
});
