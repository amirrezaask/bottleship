import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { installComVtable } from "../core/com/install-com-vtable";

// DirectMusic core with no MIDI ports. Legacy DX7 checks instantiate this class
// even when the game uses DirectSound for all audio. No synthesizer is advertised.
const musicIids = new Set([
    "00000000-0000-0000-c000-000000000046",
    "6536115a-7b2d-11d2-ba18-0000f875ac12",
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
