import { expect, test } from "bun:test";
import { ZipArchive } from "@bottleship/formats/zip";
import { VirtualFileSystem } from "../../src/worker/runtime/filesystem/vfs";

test("archive timestamps reach case-insensitive VFS metadata without reading payloads", async () => {
    const name = new TextEncoder().encode("Demos/demo.dem");
    const cd = new Uint8Array(46 + name.length);
    const view = new DataView(cd.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(12, (17 << 11) | (27 << 5) | 19, true);
    view.setUint16(14, (21 << 9) | (12 << 5) | 3, true);
    view.setUint16(28, name.length, true);
    cd.set(name, 46);
    const tail = new Uint8Array(22);
    const end = new DataView(tail.buffer);
    const size = 100_000;
    end.setUint32(0, 0x06054b50, true);
    end.setUint32(12, cd.length, true);
    end.setUint32(16, size - 22 - cd.length, true);
    let reads = 0;
    const archive = new ZipArchive({ size, async readRange(start, stop) {
        reads++;
        if (start === size - 22 - cd.length && stop === size - 22) return cd;
        const data = new Uint8Array(stop - start);
        data.set(tail, data.length - 22);
        return data;
    }});
    await archive.init();
    const vfs = new VirtualFileSystem();
    vfs.mountRom(archive, "", new Map(archive.listEntries().map(e => [e.name, e])));
    expect(vfs.getFileModifiedTime("C:\\DEMOS\\demo.dem")).toBe(Date.UTC(2001, 11, 3, 17, 27, 38) / 1000);
    expect(reads).toBe(2);
});
