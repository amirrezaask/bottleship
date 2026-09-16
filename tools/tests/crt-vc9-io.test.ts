import { beforeEach, describe, expect, test } from "bun:test";
import { Mem } from "../../src/worker/core/memory/mem-accessor";
import { System } from "../../src/worker/core/system";
import { registerVc9IoExports, type Vc9IoHost } from "../../src/worker/modules/crt-vc9-io";
import type { VfsEntry } from "../../src/worker/runtime/filesystem/vfs";
import type { ThunkImplementation } from "../../src/worker/core/thunking/thunk-dispatcher";

describe("crt-vc9-io", () => {
    let mem: Uint8Array;
    let exports: Record<string, ThunkImplementation>;
    let host: Vc9IoHost;

    beforeEach(() => {
        mem = new Uint8Array(0x4000);
        Mem.bind(() => mem);
        exports = {};
        host = {
            process: { v86: null },
            readCString: (ptr) => {
                let s = "";
                for (let i = ptr; i < mem.length && mem[i] !== 0; i++) s += String.fromCharCode(mem[i]!);
                return s;
            },
            setErrno: () => true,
            statImpl: () => 0,
            fseek: () => 0,
            ftell: () => 42,
            filelength: () => 100,
            fileStreams: new Map(),
            malloc: (n) => {
                const p = 0x2000;
                return p + n;
            },
            writeCString: (ptr, value) => {
                for (let i = 0; i < value.length; i++) mem[ptr + i] = value.charCodeAt(i) & 0xff;
                mem[ptr + value.length] = 0;
            },
            memset: (ptr, val, size) => {
                mem.fill(val & 0xff, ptr, ptr + size);
                return ptr;
            },
        };
        registerVc9IoExports(exports, host);
    });

    test("VC6 _fstat preserves the caller stack beyond its 36-byte structure", () => {
        const ptr = 0x100;
        mem.fill(0xa5, ptr - 4, ptr + 64);
        host.fileModifiedTime = () => 1007308800;
        expect(exports._fstat!(null as any, mem, [3, ptr])).toBe(0);
        const view = new DataView(mem.buffer);
        expect(view.getUint16(ptr + 6, true)).toBe(0x8100);
        expect(view.getUint16(ptr + 8, true)).toBe(1);
        expect(view.getUint32(ptr + 20, true)).toBe(100);
        expect(view.getUint32(ptr + 28, true)).toBe(1007308800);
        expect(Array.from(mem.slice(ptr + 36, ptr + 64))).toEqual(Array(28).fill(0xa5));
        expect(view.getUint32(ptr - 4, true)).toBe(0xa5a5a5a5);
    });

    test("asctime formats struct tm", () => {
        const tm = 0x100;
        Mem.writeUint32(tm + 0, 5);
        Mem.writeUint32(tm + 4, 30);
        Mem.writeUint32(tm + 8, 14);
        Mem.writeUint32(tm + 12, 12);
        Mem.writeUint32(tm + 16, 5);
        Mem.writeUint32(tm + 20, 126);
        const ptr = exports["asctime"]!(null as any, mem, [tm]);
        expect(ptr).toBeGreaterThan(0);
        const text = host.readCString(ptr);
        expect(text).toContain("Jun");
        expect(text).toContain("2026");
    });

    test("_time64 writes timer and returns low dword", () => {
        const timer = 0x200;
        const lo = exports["_time64"]!(null as any, mem, [timer]);
        expect(lo).toBeGreaterThan(0);
        expect(Mem.readUint32(timer)).toBe(lo);
    });

    test("_findfirst keeps an absolute drive-root search at the drive root", () => {
        const system = System.getInstance();
        const originalListDirectory = system.fileSystem.listDirectory;
        const entry: VfsEntry = {
            path: "C:\\1_00c.gro",
            name: "1_00c.gro",
            kind: "file",
            size: 0x1234,
            source: "rom",
        };
        let searchedDirectory = "";

        system.fileSystem.listDirectory = ((directory: string) => {
            searchedDirectory = directory;
            return [entry];
        }) as typeof system.fileSystem.listDirectory;
        try {
            const filespec = 0x100;
            const findData = 0x300;
            host.writeCString(filespec, "C:\\*.gro");

            const handle = exports["_findfirst"]!(null as any, mem, [filespec, findData]);

            expect(handle).toBeGreaterThan(0);
            expect(searchedDirectory).toBe("C:\\");
            expect(host.readCString(findData + 20)).toBe("1_00c.gro");
        } finally {
            system.fileSystem.listDirectory = originalListDirectory;
        }
    });

    test("_findfirst64i32 writes bounded finddata64i32 layout", () => {
        const system = System.getInstance();
        const originalListDirectory = system.fileSystem.listDirectory;
        const entry: VfsEntry = {
            path: "C:\\Games\\readme.txt",
            name: "readme.txt",
            kind: "file",
            size: 0x1234,
            source: "rom",
        };

        system.fileSystem.listDirectory = (() => [entry]) as typeof system.fileSystem.listDirectory;
        try {
            const filespec = 0x100;
            const findData = 0x300;
            const sentinel = findData + 296;
            host.writeCString(filespec, "C:\\Games\\*.txt");
            mem[sentinel] = 0xa5;

            const handle = exports["_findfirst64i32"]!(null as any, mem, [filespec, findData]);

            expect(handle).toBeGreaterThan(0);
            expect(Mem.readUint32(findData + 0)).toBe(0x8100);
            expect(Mem.readUint32(findData + 32)).toBe(0x1234);
            expect(host.readCString(findData + 36)).toBe("readme.txt");
            expect(mem[sentinel]).toBe(0xa5);
        } finally {
            system.fileSystem.listDirectory = originalListDirectory;
        }
    });
});
