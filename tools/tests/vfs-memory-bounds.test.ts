import { describe, expect, it } from "bun:test";
import { VirtualFileSystem, type VfsFileHandle } from "../../src/worker/runtime/filesystem/vfs";
import type { ZipArchive, ZipEntry } from "@bottleship/formats/zip";
const entry = (size: number): ZipEntry => ({ name:"asset.dat", uncompressedSize:size, compressedSize:size, compression:0, localHeaderOffset:0, isDirectory:false });
const handle = (): VfsFileHandle => ({kind:"file",path:"C:\\asset.dat",position:0,access:0x80000000,source:"rom"});

describe("VFS asset ownership", () => {
    it("reads a large entry by range and does not retain a full-tail read on its handle", async () => {
        const size = 5 * 1024 * 1024;
        let wholeReads = 0;
        const archive = { readEntryRangeSync() { return null; }, async readEntryRange(_e:ZipEntry, _off:number, length:number) { return new Uint8Array(length); }, async readEntry() { wholeReads++; throw new Error("whole file read"); } } as unknown as ZipArchive;
        const vfs = new VirtualFileSystem();
        vfs.mountRom(archive,"", new Map([["asset.dat",entry(size)]]));
        const file = handle();
        expect((await vfs.read(file,size)).byteLength).toBe(size);
        expect(wholeReads).toBe(0);
        expect(file.buffer).toBeUndefined();
    });
    it("does not populate a new game's ROM cache with a late old-game read", async () => {
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        let closed = 0;
        const archive = { readEntryRangeSync() { return null; }, async readEntry() { await gate; return new Uint8Array(100); }, close() { closed++; } } as unknown as ZipArchive;
        const vfs = new VirtualFileSystem();
        vfs.mountRom(archive,"",new Map([["asset.dat",entry(100)]]));
        const read = vfs.read(handle(),100);
        vfs.reset();
        release();
        await expect(read).rejects.toThrow("cancelled");
        expect(closed).toBe(1);
        expect(vfs.isRomCached("asset.dat")).toBe(false);
    });
    it("does not pin a cached file separately on every open handle", async () => {
        const archive = { readEntryRangeSync() { return null; }, async readEntry() { return new Uint8Array(1000); } } as unknown as ZipArchive;
        const vfs = new VirtualFileSystem();
        vfs.mountRom(archive,"",new Map([["asset.dat",entry(1000)]]));
        await vfs.read(handle(),1000);
        const file = handle();
        expect(vfs.readSync(file,8)?.byteLength).toBe(8);
        expect(file.buffer).toBeUndefined();
    });
});
