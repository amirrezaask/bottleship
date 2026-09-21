import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { installComVtable } from "../core/com/install-com-vtable";

const MIDTOWN_MADNESS_2_SOURCE_SHA256 =
    "992c53c9250cf822b44bf4a4013bd5805229bbbeb7b478a4c2556531bc5340f3";
const CLSID_DIRECT_MUSIC = "636b9f10-0c7d-11d1-95b2-0020afdc7421";
const CLSID_DIRECT_MUSIC_PERFORMANCE = "d2ac2881-b39b-11d1-8704-00600893b1bd";
const IID_IUNKNOWN = "00000000-0000-0000-c000-000000000046";
const IID_DIRECT_MUSIC = "6536115a-7b2d-11d2-ba18-0000f875ac12";
const IID_DIRECT_MUSIC_PERFORMANCE = "07d43d03-6523-11d2-871d-00600893b1bd";
const IID_DIRECT_MUSIC_PERFORMANCE2 = "6fc2cae0-bc78-11d2-afa6-00aa0024d8b6";
const IID_DIRECT_MUSIC_PERFORMANCE8 = "679c4137-c62e-4147-b2b4-9d569acb254c";

function isMidtownMadness2Process(process: Process): boolean {
    const executable = process.moduleRegistry?.getExecutableModule();
    if (
        executable?.sourceHash?.toLowerCase() === MIDTOWN_MADNESS_2_SOURCE_SHA256
        || executable?.isExecutable && executable.name.toLowerCase() === "midtown2"
    )
        return true;

    // Keep the HLE-module scan for callers/tests that provide a lightweight
    // Process double without a PE module registry.
    for (const module of process.modules?.values?.() ?? []) {
        if (
            module?.isExecutable
            && (
                module.sourceHash?.toLowerCase() === MIDTOWN_MADNESS_2_SOURCE_SHA256
                || module.name.toLowerCase() === "midtown2"
            )
        )
            return true;
    }
    return false;
}

// DirectMusic core with no MIDI ports. Legacy DX7 checks instantiate this class
// even when the game uses DirectSound for all audio. No synthesizer is advertised.
const musicIids = new Set([
    IID_IUNKNOWN,
    IID_DIRECT_MUSIC,
]);
const musicStates = new WeakMap<Process, { vtable: number; refs: Map<number, number> }>();
export function createDirectMusic(process: Process, iid: string, ppv: number): number {
    const view = () => {
        const mem = process.getCurrentMemory();
        return new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    };
    const valid = (p: number, size = 4) => p > 0 && p + size <= view().byteLength;
    if (!valid(ppv)) return 0x80004003;
    view().setUint32(ppv, 0, true);
    if (!musicIids.has(iid)) return 0x80004002;
    let state = musicStates.get(process);
    if (!state) {
        const refs = new Map<number, number>();
        const nullOutput = (slot: number): ThunkImplementation => (_ctx, _mem, args) => {
            if (!valid(args[slot])) return 0x80004003;
            view().setUint32(args[slot], 0, true);
            return 0x80004001; // E_NOTIMPL: no MIDI backend
        };
        const handlers: Record<string, ThunkImplementation> = {
            QueryInterface: (_ctx, mem, args) => {
                const [self, riid, out] = args;
                if (!valid(out)) return 0x80004003;
                view().setUint32(out, 0, true);
                if (!valid(riid, 16)) return 0x80004003;
                const v = view();
                const hex = (n: number, width: number) => n.toString(16).padStart(width, "0");
                const tail = Array.from(mem.subarray(riid + 8, riid + 16), b => hex(b, 2)).join("");
                const id = `${hex(v.getUint32(riid, true), 8)}-${hex(v.getUint16(riid + 4, true), 4)}-${hex(v.getUint16(riid + 6, true), 4)}-${tail.slice(0, 4)}-${tail.slice(4)}`;
                if (!refs.has(self) || !musicIids.has(id)) return 0x80004002;
                refs.set(self, refs.get(self)! + 1);
                v.setUint32(out, self, true);
                return 0;
            },
            AddRef: (_ctx, _mem, args) => {
                const count = refs.get(args[0]);
                if (!count) return 0;
                refs.set(args[0], count + 1);
                return count + 1;
            },
            Release: (_ctx, _mem, args) => {
                const count = refs.get(args[0]);
                if (!count) return 0;
                if (count === 1) { refs.delete(args[0]); process.memory.free(args[0]); }
                else refs.set(args[0], count - 1);
                return count - 1;
            },
            EnumPort: () => 1, // S_FALSE: enumeration exhausted
            CreateMusicBuffer: nullOutput(2),
            CreatePort: nullOutput(3),
            EnumMasterClock: () => 1,
            GetMasterClock: nullOutput(2),
            SetMasterClock: () => 0x80004001,
            Activate: () => 0,
            GetDefaultPort: () => 0x80004001,
            SetDirectSound: () => 0,
        };
        const arities = [3, 1, 1, 3, 4, 5, 3, 3, 2, 2, 2, 3];
        const installed = installComVtable(process, {
            moduleName: "gamebox_directmusic",
            methods: Object.keys(handlers).map((name, i) => ({ name, argCount: arities[i], stackCleanupBytes: arities[i] * 4 })),
            handlers,
        });
        if (!installed) return 0x80004005;
        state = { vtable: installed.vtableAddr, refs };
        musicStates.set(process, state);
    }
    const object = process.memory.alloc(4, "THUNK_DATA", "rw");
    view().setUint32(object, state.vtable, true);
    view().setUint32(ppv, object, true);
    state.refs.set(object, 1);
    return 0;
}

const performanceIids = new Set([
    IID_IUNKNOWN,
    IID_DIRECT_MUSIC_PERFORMANCE,
    IID_DIRECT_MUSIC_PERFORMANCE2,
    IID_DIRECT_MUSIC_PERFORMANCE8,
]);

type DirectMusicPerformanceState = {
    vtable: number;
    refs: Map<number, number>;
};

const performanceStates = new WeakMap<Process, DirectMusicPerformanceState>();

function writeZero(view: DataView, pointer: number, size = 4): boolean {
    if (!pointer || pointer + size > view.byteLength) return false;
    for (let offset = 0; offset < size; offset += 4)
        view.setUint32(pointer + offset, 0, true);
    return true;
}

function performanceMethod(name: string, argCount: number): { name: string; argCount: number; stackCleanupBytes: number } {
    return { name, argCount, stackCleanupBytes: argCount * 4 };
}

/**
 * MM2 asks for IDirectMusicPerformance2 during audio setup. The browser has
 * no MIDI port or DirectMusic synthesizer, but the title still requires a
 * valid COM identity: it stores the object globally and polls IsPlaying on
 * every loaded segment. Keep the object ABI-compatible and inert while the
 * actual effects/music samples continue through DirectSound.
 */
export function createMidtownMadness2DirectMusic(
    process: Process,
    clsid: string,
    iid: string,
    ppv: number,
): number | null {
    if (!isMidtownMadness2Process(process)) return null;
    if (clsid !== CLSID_DIRECT_MUSIC_PERFORMANCE) return null;
    if (!performanceIids.has(iid)) return 0x80004002;

    const view = () => {
        const mem = process.getCurrentMemory();
        return new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    };
    const valid = (pointer: number, size = 4): boolean => {
        const value = pointer >>> 0;
        return value > 0 && value + size <= view().byteLength;
    };
    const writeGuid = (pointer: number): string | null => {
        if (!valid(pointer, 16)) return null;
        const mem = process.getCurrentMemory();
        const v = view();
        const hex = (value: number, width: number) => value.toString(16).padStart(width, "0");
        const tail = Array.from(mem.subarray(pointer + 8, pointer + 16), (byte) => hex(byte, 2)).join("");
        return `${hex(v.getUint32(pointer, true), 8)}-${hex(v.getUint16(pointer + 4, true), 4)}-${hex(v.getUint16(pointer + 6, true), 4)}-${tail.slice(0, 4)}-${tail.slice(4)}`;
    };
    let state = performanceStates.get(process);
    if (!state) {
        const refs = new Map<number, number>();
        const output = (slot: number, size = 4): ThunkImplementation => (_ctx, _mem, args) => {
            const pointer = args[slot] >>> 0;
            if (!valid(pointer, size)) return 0x80004003;
            writeZero(view(), pointer, size);
            return 0;
        };
        const handlers: Record<string, ThunkImplementation> = {
            QueryInterface: (_ctx, _mem, args) => {
                const self = args[0] >>> 0;
                const out = args[2] >>> 0;
                if (!valid(out)) return 0x80004003;
                writeZero(view(), out);
                const id = writeGuid(args[1] >>> 0);
                if (!refs.has(self) || !id || !performanceIids.has(id)) return 0x80004002;
                refs.set(self, refs.get(self)! + 1);
                view().setUint32(out, self, true);
                return 0;
            },
            AddRef: (_ctx, _mem, args) => {
                const count = refs.get(args[0] >>> 0);
                if (!count) return 0;
                refs.set(args[0] >>> 0, count + 1);
                return count + 1;
            },
            Release: (_ctx, _mem, args) => {
                const object = args[0] >>> 0;
                const count = refs.get(object);
                if (!count) return 0;
                if (count === 1) {
                    refs.delete(object);
                    process.memory.free(object);
                } else {
                    refs.set(object, count - 1);
                }
                return count - 1;
            },
            Init: () => 0,
            PlaySegment: output(5),
            Stop: () => 0,
            GetSegmentState: output(1),
            SetPrepareTime: () => 0,
            GetPrepareTime: output(1),
            SetBumperLength: () => 0,
            GetBumperLength: output(1),
            SendPMsg: () => 0,
            MusicToReferenceTime: output(2, 8),
            ReferenceToMusicTime: output(2),
            // S_FALSE is the documented result for an inert/non-playing segment.
            IsPlaying: () => 1,
            GetTime: (_ctx, _mem, args) => {
                if (args[1] && !valid(args[1] >>> 0, 8)) return 0x80004003;
                if (args[2] && !valid(args[2] >>> 0)) return 0x80004003;
                if (args[1]) writeZero(view(), args[1] >>> 0, 8);
                if (args[2]) writeZero(view(), args[2] >>> 0);
                return 0;
            },
            AllocPMsg: output(2),
            FreePMsg: () => 0,
            GetGraph: output(1),
            SetGraph: () => 0,
            SetNotificationHandle: () => 0,
            GetNotificationPMsg: output(1),
            AddNotificationType: () => 0,
            RemoveNotificationType: () => 0,
            AddPort: () => 0,
            RemovePort: () => 0,
            AssignPChannelBlock: () => 0,
            AssignPChannel: () => 0,
            PChannelInfo: (_ctx, _mem, args) => {
                if (args[2] && !valid(args[2] >>> 0)) return 0x80004003;
                if (args[3] && !valid(args[3] >>> 0)) return 0x80004003;
                if (args[4] && !valid(args[4] >>> 0)) return 0x80004003;
                if (args[2]) writeZero(view(), args[2] >>> 0);
                if (args[3]) writeZero(view(), args[3] >>> 0);
                if (args[4]) writeZero(view(), args[4] >>> 0);
                return 0;
            },
            DownloadInstrument: (_ctx, _mem, args) => {
                if (args[3] && !valid(args[3] >>> 0)) return 0x80004003;
                if (args[6] && !valid(args[6] >>> 0)) return 0x80004003;
                if (args[7] && !valid(args[7] >>> 0)) return 0x80004003;
                if (args[8] && !valid(args[8] >>> 0)) return 0x80004003;
                if (args[3]) writeZero(view(), args[3] >>> 0);
                if (args[6]) writeZero(view(), args[6] >>> 0);
                if (args[7]) writeZero(view(), args[7] >>> 0);
                if (args[8]) writeZero(view(), args[8] >>> 0);
                return 0;
            },
            Invalidate: () => 0,
            GetParam: output(5),
            SetParam: () => 0,
            GetGlobalParam: () => 0,
            SetGlobalParam: () => 0,
            GetLatencyTime: output(1, 8),
            GetQueueTime: output(1, 8),
            AdjustTime: () => 0,
            CloseDown: () => 0,
            GetResolvedTime: output(2, 8),
            MIDIToMusic: output(5),
            MusicToMIDI: output(5),
            TimeToRhythm: () => 0,
            RhythmToTime: output(6),
            InitAudio: (_ctx, _mem, args) => {
                if (args[1] && !valid(args[1] >>> 0)) return 0x80004003;
                if (args[2] && !valid(args[2] >>> 0)) return 0x80004003;
                if (args[1]) writeZero(view(), args[1] >>> 0);
                if (args[2]) writeZero(view(), args[2] >>> 0);
                return 0;
            },
            PlaySegmentEx: output(7),
            StopEx: () => 0,
            ClonePMsg: output(2),
            CreateAudioPath: output(3),
            CreateStandardAudioPath: output(4),
            SetDefaultAudioPath: () => 0,
            GetDefaultAudioPath: output(1),
            GetParamEx: output(6),
        };
        const specs = [
            ["QueryInterface", 3], ["AddRef", 1], ["Release", 1],
            ["Init", 4], ["PlaySegment", 6], ["Stop", 5], ["GetSegmentState", 3],
            ["SetPrepareTime", 2], ["GetPrepareTime", 2], ["SetBumperLength", 2], ["GetBumperLength", 2],
            ["SendPMsg", 2], ["MusicToReferenceTime", 4], ["ReferenceToMusicTime", 4], ["IsPlaying", 3],
            ["GetTime", 3], ["AllocPMsg", 3], ["FreePMsg", 2], ["GetGraph", 2], ["SetGraph", 2],
            ["SetNotificationHandle", 4], ["GetNotificationPMsg", 2], ["AddNotificationType", 2], ["RemoveNotificationType", 2],
            ["AddPort", 2], ["RemovePort", 2], ["AssignPChannelBlock", 4], ["AssignPChannel", 5],
            ["PChannelInfo", 5], ["DownloadInstrument", 9], ["Invalidate", 3], ["GetParam", 7], ["SetParam", 6],
            ["GetGlobalParam", 4], ["SetGlobalParam", 4], ["GetLatencyTime", 3], ["GetQueueTime", 3],
            ["AdjustTime", 3], ["CloseDown", 1], ["GetResolvedTime", 5], ["MIDIToMusic", 6], ["MusicToMIDI", 6],
            ["TimeToRhythm", 7], ["RhythmToTime", 7], ["InitAudio", 8], ["PlaySegmentEx", 10], ["StopEx", 5],
            ["ClonePMsg", 3], ["CreateAudioPath", 4], ["CreateStandardAudioPath", 5], ["SetDefaultAudioPath", 2],
            ["GetDefaultAudioPath", 2], ["GetParamEx", 8],
        ] as const;
        const installed = installComVtable(process, {
            moduleName: "gamebox_directmusic_performance",
            methods: specs.map(([name, argCount]) => performanceMethod(name, argCount)),
            handlers,
        });
        if (!installed) return 0x80004005;
        state = { vtable: installed.vtableAddr, refs };
        performanceStates.set(process, state);
    }
    const object = process.memory.alloc(4, "THUNK_DATA", "rw");
    view().setUint32(object, state.vtable, true);
    if (!valid(ppv)) {
        process.memory.free(object);
        return 0x80004003;
    }
    view().setUint32(ppv, object, true);
    state.refs.set(object, 1);
    return 0;
}
