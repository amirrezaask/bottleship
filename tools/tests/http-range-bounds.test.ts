import { afterEach, describe, expect, it } from "bun:test";
import { HttpRangeSource } from "../../packages/formats/src/zip";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const response = (body: Uint8Array | ReadableStream<Uint8Array>, range: string) =>
    new Response(body as BodyInit, { status: 206, headers: { "content-range": range } });

describe("WGB exact bounded ranges", () => {
    it("probes one byte and preserves offsets above 4 GiB", async () => {
        const seen: string[] = [];
        const total = 8 * 2 ** 30;
        globalThis.fetch = (async (_url, options) => {
            const range = (options?.headers as Record<string,string>).Range;
            seen.push(range);
            const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(range)!;
            return response(Uint8Array.from({length:Number(b)-Number(a)+1}, (_, i) => (Number(a)+i)%251), `bytes ${a}-${b}/${total}`);
        }) as typeof fetch;
        const source = await HttpRangeSource.create("https://example.test/game.wgb");
        const offset = 6 * 2 ** 30 + 17;
        expect([...await source.readRange(offset, offset+5)]).toEqual(Array.from({length:5}, (_, i) => (offset+i)%251));
        expect(seen).toEqual(["bytes=0-0", `bytes=${offset}-${offset+4}`]);
    });
    it("cancels an ignored range without consuming a whole response", async () => {
        let cancelled = false;
        globalThis.fetch = (async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), {status:200})) as typeof fetch;
        await expect(HttpRangeSource.create("https://example.test/game.wgb")).rejects.toThrow("exact requested");
        expect(cancelled).toBe(true);
    });
    it("rejects shifted ranges, changed total sizes and short/oversized bodies", async () => {
        for (const [header, length] of [["bytes 2-5/100", 4], ["bytes 1-4/101", 4], ["bytes 1-4/100", 3], ["bytes 1-4/100", 5]] as const) {
            let calls = 0;
            globalThis.fetch = (async () => ++calls === 1 ? response(new Uint8Array(1), "bytes 0-0/100") : response(new Uint8Array(length), header)) as typeof fetch;
            const source = await HttpRangeSource.create("https://example.test/game.wgb");
            await expect(source.readRange(1, 5)).rejects.toThrow();
        }
    });
    it("aborts pending reads and disallows reads after close", async () => {
        let calls = 0;
        globalThis.fetch = (async (_url, options) => {
            if (++calls === 1) return response(new Uint8Array(1), "bytes 0-0/100");
            return await new Promise<Response>((_resolve, reject) => options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason)));
        }) as typeof fetch;
        const source = await HttpRangeSource.create("https://example.test/game.wgb");
        const read = source.readRange(1, 5);
        source.close();
        await expect(read).rejects.toThrow();
        await expect(source.readRange(1, 5)).rejects.toThrow();
    });
});
