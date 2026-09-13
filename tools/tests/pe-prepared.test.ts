import { describe, expect, test } from 'bun:test';
import { APIRegistry } from '../../src/worker/core/api-registry';
import { ModuleRegistry } from '../../src/worker/core/module-registry';
import { PELoader, type PeImageSource, type PreparedPeDescriptor } from '../../src/worker/core/pe-loader';
import { System } from '../../src/worker/core/system';
import { ThunkGenerator } from '../../src/worker/core/thunking/thunk-generator';

const BASE = 0x00400000;
const HEADER_SIZE = 0x400;
const SECTION_RVA = 0x1000;
const RAW_SIZE = 0x50000;
const IMAGE_SIZE = 0x51000;
const EXPORT_RVA = 0x1100;
const ENTRY_RVA = 0x1200;

function writeString(bytes: Uint8Array, offset: number, value: string): void {
    for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i);
    bytes[offset + value.length] = 0;
}

function makePe(): Uint8Array {
    const bytes = new Uint8Array(HEADER_SIZE + RAW_SIZE);
    const view = new DataView(bytes.buffer);
    const u16 = (offset: number, value: number) => view.setUint16(offset, value, true);
    const u32 = (offset: number, value: number) => view.setUint32(offset, value >>> 0, true);

    u16(0, 0x5a4d);
    u32(0x3c, 0x80);
    u32(0x80, 0x00004550);
    u16(0x84, 0x14c);
    u16(0x86, 1);
    u16(0x94, 0xe0);
    const opt = 0x98;
    u16(opt, 0x10b);
    u32(opt + 16, ENTRY_RVA);
    u32(opt + 20, SECTION_RVA);
    u32(opt + 28, BASE);
    u32(opt + 32, 0x1000);
    u32(opt + 36, 0x200);
    u32(opt + 56, IMAGE_SIZE);
    u32(opt + 60, HEADER_SIZE);
    u16(opt + 68, 3);
    u32(opt + 72, 0x100000);
    u32(opt + 76, 0x1000);
    u32(opt + 92, 16);
    // Export directory: RVA 0x1100, size 0x80.
    u32(opt + 96, EXPORT_RVA);
    u32(opt + 100, 0x80);

    const section = opt + 0xe0;
    writeString(bytes, section, '.text');
    u32(section + 8, RAW_SIZE);
    u32(section + 12, SECTION_RVA);
    u32(section + 16, RAW_SIZE);
    u32(section + 20, HEADER_SIZE);
    u32(section + 36, 0x60000020);

    const exportOffset = HEADER_SIZE + (EXPORT_RVA - SECTION_RVA);
    u32(exportOffset + 16, 1); // ordinal base
    u32(exportOffset + 20, 1); // number of functions
    u32(exportOffset + 24, 1); // number of names
    u32(exportOffset + 28, EXPORT_RVA + 0x40);
    u32(exportOffset + 32, EXPORT_RVA + 0x44);
    u32(exportOffset + 36, EXPORT_RVA + 0x48);
    u32(HEADER_SIZE + (EXPORT_RVA + 0x40 - SECTION_RVA), ENTRY_RVA);
    u32(HEADER_SIZE + (EXPORT_RVA + 0x44 - SECTION_RVA), EXPORT_RVA + 0x50);
    u16(HEADER_SIZE + (EXPORT_RVA + 0x48 - SECTION_RVA), 0);
    writeString(bytes, HEADER_SIZE + (EXPORT_RVA + 0x50 - SECTION_RVA), 'ExportedEntry');
    bytes[HEADER_SIZE + (ENTRY_RVA - SECTION_RVA)] = 0xc3; // ret
    return bytes;
}

function descriptor(bytes: Uint8Array): PreparedPeDescriptor {
    return {
        sourceHash: '0'.repeat(64),
        sourceBytes: bytes.length,
        preferredBase: BASE,
        entrypointRva: ENTRY_RVA,
        imageSize: IMAGE_SIZE,
        headerSize: HEADER_SIZE,
        sections: [{
            name: '.text',
            virtualAddress: SECTION_RVA,
            virtualSize: RAW_SIZE,
            rawOffset: HEADER_SIZE,
            rawSize: RAW_SIZE,
            characteristics: 0x60000020,
        }],
        dataDirectories: Array.from({ length: 16 }, (_, index) => ({
            virtualAddress: index === 0 ? EXPORT_RVA : 0,
            size: index === 0 ? 0x80 : 0,
        })),
    };
}

const DLL_BASE = 0x01000000;
const DLL_HEADER_SIZE = 0x400;
const DLL_SECTION_RVA = 0x1000;
const DLL_RAW_SIZE = 0x3000;
const DLL_IMAGE_SIZE = 0x4000;
const DLL_ENTRY_RVA = 0x1000;

function makeDll(): Uint8Array {
    const bytes = new Uint8Array(DLL_HEADER_SIZE + DLL_RAW_SIZE);
    const view = new DataView(bytes.buffer);
    const u16 = (offset: number, value: number) => view.setUint16(offset, value, true);
    const u32 = (offset: number, value: number) => view.setUint32(offset, value >>> 0, true);
    const file = (rva: number) => DLL_HEADER_SIZE + (rva - DLL_SECTION_RVA);

    u16(0, 0x5a4d);
    u32(0x3c, 0x80);
    u32(0x80, 0x00004550);
    u16(0x84, 0x14c);
    u16(0x86, 1);
    u16(0x94, 0xe0);
    const opt = 0x98;
    u16(opt, 0x10b);
    u32(opt + 16, DLL_ENTRY_RVA);
    u32(opt + 20, DLL_SECTION_RVA);
    u32(opt + 28, DLL_BASE);
    u32(opt + 32, 0x1000);
    u32(opt + 36, 0x200);
    u32(opt + 56, DLL_IMAGE_SIZE);
    u32(opt + 60, DLL_HEADER_SIZE);
    u16(opt + 68, 3);
    u32(opt + 72, 0x100000);
    u32(opt + 76, 0x1000);
    u32(opt + 92, 16);
    // Export, import, base-relocation, and TLS directories.
    u32(opt + 96, 0x1100); u32(opt + 100, 0x80);
    u32(opt + 104, 0x1700); u32(opt + 108, 0x28);
    u32(opt + 136, 0x1600); u32(opt + 140, 0x10);
    u32(opt + 168, 0x1300); u32(opt + 172, 0x18);

    const section = opt + 0xe0;
    writeString(bytes, section, '.text');
    u32(section + 8, DLL_RAW_SIZE);
    u32(section + 12, DLL_SECTION_RVA);
    u32(section + 16, DLL_RAW_SIZE);
    u32(section + 20, DLL_HEADER_SIZE);
    u32(section + 36, 0x60000020);

    const exp = file(0x1100);
    u32(exp + 16, 1); u32(exp + 20, 1); u32(exp + 24, 1);
    u32(exp + 28, 0x1140); u32(exp + 32, 0x1144); u32(exp + 36, 0x1148);
    u32(file(0x1140), DLL_ENTRY_RVA);
    u32(file(0x1144), 0x1150); u16(file(0x1148), 0);
    writeString(bytes, file(0x1150), 'DllExport');

    // TLS directory points at one dword of template data and an index slot.
    u32(file(0x1300), DLL_BASE + 0x1400);
    u32(file(0x1304), DLL_BASE + 0x1404);
    u32(file(0x1308), DLL_BASE + 0x1500);
    u32(file(0x130c), 0); u32(file(0x1310), 4);
    u32(file(0x1400), 0xfeedbeef);

    // One import from a deliberately missing DLL; the loader must patch its IAT with a stub.
    u32(file(0x1700), 0x1740); u32(file(0x1700 + 12), 0x1780); u32(file(0x1700 + 16), 0x1750);
    u32(file(0x1740), 0x1790); u32(file(0x1750), 0x1790);
    writeString(bytes, file(0x1780), 'missing.dll');
    u16(file(0x1790), 0); writeString(bytes, file(0x1792), 'Imported');

    // HIGHLOW relocations for the three TLS absolute pointers.
    u32(file(0x1600), 0x1000); u32(file(0x1604), 0x10);
    u16(file(0x1608), 0x3300); u16(file(0x160a), 0x3304);
    u16(file(0x160c), 0x3308); u16(file(0x160e), 0x330c);
    bytes[file(DLL_ENTRY_RVA)] = 0xc3;
    return bytes;
}

function dllDescriptor(bytes: Uint8Array): PreparedPeDescriptor {
    return {
        sourceHash: '1'.repeat(64),
        sourceBytes: bytes.length,
        preferredBase: DLL_BASE,
        entrypointRva: DLL_ENTRY_RVA,
        imageSize: DLL_IMAGE_SIZE,
        headerSize: DLL_HEADER_SIZE,
        sections: [{ name: '.text', virtualAddress: DLL_SECTION_RVA, virtualSize: DLL_RAW_SIZE,
            rawOffset: DLL_HEADER_SIZE, rawSize: DLL_RAW_SIZE, characteristics: 0x60000020 }],
        dataDirectories: Array.from({ length: 16 }, (_, index) => ({
            virtualAddress: [0x1100, 0x1700, 0, 0, 0, 0x1600, 0, 0, 0, 0x1300][index] ?? 0,
            size: [0x80, 0x28, 0, 0, 0, 0x10, 0, 0, 0, 0x18][index] ?? 0,
        })),
    };
}

function fakeVfs(bytes: Uint8Array, reportedSize = bytes.length): any {
    const path = 'C:\\fixture.dll';
    return {
        currentDir: 'C:\\',
        resolvePath: (value: string) => value.toLowerCase() === path.toLowerCase() ? path : value,
        resolveStoredFile: (value: string) => value.toLowerCase() === path.toLowerCase() ? { path, source: 'rom' } : null,
        listDirectory: () => [],
        open: async () => ({ kind: 'file', path, position: 0, access: 0, source: 'rom' }),
        getFileSize: () => reportedSize,
        read: async (_handle: unknown, size: number) => bytes.slice(0, size),
    };
}

class BoundedSource implements PeImageSource {
    readonly size: number;
    readonly requests: number[] = [];

    constructor(private readonly bytes: Uint8Array) {
        this.size = bytes.length;
    }

    async readRange(offset: number, length: number): Promise<Uint8Array> {
        this.requests.push(length);
        if (length > 256 * 1024) throw new Error('test source received oversized range');
        return this.bytes.slice(offset, offset + length);
    }
}

class FailingSource extends BoundedSource {
    constructor(bytes: Uint8Array, private readonly failAt: number) {
        super(bytes);
    }

    override async readRange(offset: number, length: number): Promise<Uint8Array> {
        if (offset >= this.failAt) throw new Error('synthetic source failure');
        return super.readRange(offset, length);
    }
}

function makeLoader(memory: Uint8Array): { loader: PELoader; registry: ModuleRegistry } {
    const registry = new ModuleRegistry();
    const loader = new PELoader(() => memory, new ThunkGenerator(), APIRegistry.getInstance());
    loader.setModuleRegistry(registry);
    return { loader, registry };
}

function prepareSystem(): void {
    const system = System.getInstance();
    system.executableName = 'fixture.exe';
    system.executablePath = 'C:\\fixture.exe';
    system.process = null;
}

describe('bounded prepared PE loading', () => {
    test('raw bounded source and prepared metadata produce the same image and exports', async () => {
        prepareSystem();
        const pe = makePe();
        const rawMemory = new Uint8Array(16 * 1024 * 1024);
        const boundedRawMemory = new Uint8Array(rawMemory.length);
        const preparedMemory = new Uint8Array(rawMemory.length);
        const raw = makeLoader(rawMemory);
        const boundedRaw = makeLoader(boundedRawMemory);
        const prepared = makeLoader(preparedMemory);

        const rawResult = await raw.loader.loadExecutable(pe);
        const boundedRawSource = new BoundedSource(pe);
        const boundedRawResult = await boundedRaw.loader.loadSourceExecutable(boundedRawSource);
        const source = new BoundedSource(pe);
        const preparedResult = await prepared.loader.loadPreparedExecutable(source, descriptor(pe));

        expect(preparedResult).toEqual(rawResult);
        expect(boundedRawResult).toEqual(rawResult);
        expect(preparedMemory.slice(BASE, BASE + IMAGE_SIZE)).toEqual(rawMemory.slice(BASE, BASE + IMAGE_SIZE));
        expect(boundedRawMemory.slice(BASE, BASE + IMAGE_SIZE)).toEqual(rawMemory.slice(BASE, BASE + IMAGE_SIZE));
        expect(prepared.registry.getByName('fixture')?.exports.get('exportedentry')).toBe(BASE + ENTRY_RVA);
        expect(Math.max(...source.requests)).toBeLessThanOrEqual(256 * 1024);
        expect(source.requests).toContain(256 * 1024);
    });

    test('descriptor mismatches fail before mapping guest memory', async () => {
        prepareSystem();
        const pe = makePe();
        const memory = new Uint8Array(16 * 1024 * 1024);
        const { loader } = makeLoader(memory);
        const bad = descriptor(pe);
        bad.preferredBase += 0x1000;
        await expect(loader.loadPreparedExecutable(new BoundedSource(pe), bad)).rejects.toThrow('preferred base mismatch');
        expect(memory.slice(BASE, BASE + IMAGE_SIZE)).toEqual(new Uint8Array(IMAGE_SIZE));
    });

    test('directory metadata is checked before any guest mapping', async () => {
        prepareSystem();
        const pe = makePe();
        const memory = new Uint8Array(16 * 1024 * 1024);
        const { loader } = makeLoader(memory);
        const bad = descriptor(pe);
        bad.dataDirectories[0] = { virtualAddress: EXPORT_RVA + 4, size: 0x80 };
        await expect(loader.loadPreparedExecutable(new BoundedSource(pe), bad)).rejects.toThrow('data directory 0');
        expect(memory.slice(BASE, BASE + IMAGE_SIZE)).toEqual(new Uint8Array(IMAGE_SIZE));
    });

    test('source failure clears a partially mapped image', async () => {
        prepareSystem();
        const pe = makePe();
        const memory = new Uint8Array(16 * 1024 * 1024);
        const { loader } = makeLoader(memory);
        await expect(loader.loadSourceExecutable(new FailingSource(pe, HEADER_SIZE + 256 * 1024))).rejects.toThrow('synthetic source failure');
        expect(memory.slice(BASE, BASE + IMAGE_SIZE)).toEqual(new Uint8Array(IMAGE_SIZE));
    });

    test('bounded source rejects unsafe header and directory ranges before mapping', async () => {
        prepareSystem();
        const cases = [
            { offset: 0x98 + 60, value: IMAGE_SIZE + 1, reason: 'header size' },
            { offset: 0x98 + 56, value: 0x02000000, reason: 'image size' },
            { offset: 0x98 + 16, value: IMAGE_SIZE, reason: 'entrypoint RVA' },
            { offset: 0x98 + 96, value: IMAGE_SIZE - 4, reason: 'data directory 0' },
        ];
        for (const item of cases) {
            const pe = makePe();
            const view = new DataView(pe.buffer);
            view.setUint32(item.offset, item.value, true);
            if (item.reason === 'data directory 0') view.setUint32(0x98 + 100, 8, true);
            const memory = new Uint8Array(16 * 1024 * 1024);
            const { loader } = makeLoader(memory);
            await expect(loader.loadSourceExecutable(new BoundedSource(pe))).rejects.toThrow(item.reason);
            expect(memory.slice(BASE, BASE + IMAGE_SIZE)).toEqual(new Uint8Array(IMAGE_SIZE));
        }
    });

    test('prepared DLL preserves relocation, TLS, imports, exports, and DllMain queue', async () => {
        prepareSystem();
        APIRegistry.getInstance().registerModule({
            name: 'missing',
            functions: [{ name: 'Imported', params: [], returnType: 'u32', callingConvention: 'stdcall' }],
        });
        const dll = makeDll();
        const memory = new Uint8Array(0x13010000);
        const raw = makeLoader(memory);
        raw.loader.setVfs(fakeVfs(dll));
        const rawModule = await raw.loader.loadDll('fixture.dll');
        expect(rawModule).not.toBeNull();
        const rawBase = rawModule!.baseAddress;
        const rawView = new DataView(memory.buffer);
        const rawRelocatedTls = rawView.getUint32(rawBase + 0x1300, true);
        const rawTlsIndex = rawView.getUint32(rawBase + 0x1500, true);
        const rawIat = rawView.getUint32(rawBase + 0x1750, true);
        const rawPending = raw.loader.getPendingDllInits();
        expect(rawRelocatedTls).toBe(rawBase + 0x1400);
        expect(rawTlsIndex).toBeLessThan(64);
        expect(rawIat).not.toBe(0);
        expect(rawModule!.exports.get('dllexport')).toBe(rawBase + DLL_ENTRY_RVA);
        expect(rawPending).toHaveLength(1);

        memory.fill(0);
        const prepared = makeLoader(memory);
        prepared.loader.setVfs(fakeVfs(dll));
        const source = new BoundedSource(dll);
        prepared.loader.setPreparedSourceResolver(async path =>
            path.toLowerCase() === 'c:\\fixture.dll' ? { source, descriptor: dllDescriptor(dll) } : null);
        const preparedModule = await prepared.loader.loadDll('fixture.dll');
        expect(preparedModule).not.toBeNull();
        const preparedBase = preparedModule!.baseAddress;
        const preparedView = new DataView(memory.buffer);
        expect(preparedBase).toBe(rawBase);
        expect(preparedView.getUint32(preparedBase + 0x1300, true)).toBe(preparedBase + 0x1400);
        expect(preparedView.getUint32(preparedBase + 0x1500, true)).toBeLessThan(64);
        expect(preparedView.getUint32(preparedBase + 0x1750, true)).not.toBe(0);
        expect(preparedModule!.exports.get('dllexport')).toBe(preparedBase + DLL_ENTRY_RVA);
        expect(prepared.loader.getPendingDllInits()).toEqual([{
            baseAddress: preparedBase,
            entryPoint: preparedBase + DLL_ENTRY_RVA,
            name: 'fixture',
        }]);
    });

    test('resolver null keeps raw VFS bytes and oversized raw fallback is explicit', async () => {
        prepareSystem();
        const dll = makeDll();
        const memory = new Uint8Array(0x13010000);
        const loader = makeLoader(memory).loader;
        loader.setVfs(fakeVfs(dll));
        let resolverCalls = 0;
        loader.setPreparedSourceResolver(async () => { resolverCalls++; return null; });
        const module = await loader.loadDll('fixture.dll');
        expect(module).not.toBeNull();
        expect(resolverCalls).toBe(1);

        const tooLarge = makeLoader(new Uint8Array(0x13010000)).loader;
        tooLarge.setVfs(fakeVfs(dll, 64 * 1024 * 1024 + 1));
        await expect(tooLarge.loadDll('fixture.dll')).rejects.toThrow('bounded fallback limit');
    });
});
