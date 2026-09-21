/**
 * winmm device-caps / stub handlers (waveIn*, midiIn*, mixer*, aux*). No real
 * capture/mixer/aux device is emulated — faithful "one emulated device" caps
 * reporters and success stubs. Aux master volume lives in the registration
 * closure (one WinMM registration per process).
 */
import { ThunkImplementation } from '../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../core/logger';

const MMSYSERR_NOERROR = 0;
const MMSYSERR_BADDEVICEID = 2;
const MMSYSERR_INVALPARAM = 11;
const AUX_MAPPER = 0xFFFFFFFF;
const AUXCAPS_VOLUME = 0x0001;
const AUXCAPS_LRVOLUME = 0x0002;
const WHDR_PREPARED = 0x00000002;

function isValidAuxDeviceId(uDeviceID: number): boolean {
    return uDeviceID === 0 || uDeviceID === AUX_MAPPER;
}

function isValidMidiInDeviceId(uDeviceID: number): boolean {
    return uDeviceID === 0;
}

function writeMidiInCaps(mem: Uint8Array, pmic: number, isWide: boolean): void {
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    view.setUint16(pmic + 0, 0xFFFF, true); // wMid
    view.setUint16(pmic + 2, 0x0001, true); // wPid
    view.setUint32(pmic + 4, 0x0100, true); // vDriverVersion

    const name = "BottleShip MIDI In";
    if (isWide) {
        for (let i = 0; i < 32; i++) {
            const code = i < name.length ? name.charCodeAt(i) : 0;
            view.setUint16(pmic + 8 + i * 2, code, true);
        }
        view.setUint32(pmic + 72, 0, true); // dwSupport (reserved)
    } else {
        for (let i = 0; i < 32; i++) {
            mem[pmic + 8 + i] = i < name.length ? name.charCodeAt(i) : 0;
        }
        view.setUint32(pmic + 40, 0, true); // dwSupport (reserved)
    }
}

function writeAuxCaps(mem: Uint8Array, pac: number, isWide: boolean): void {
    const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
    view.setUint16(pac + 0, 0xFFFF, true); // wMid
    view.setUint16(pac + 2, 0x0001, true); // wPid
    view.setUint32(pac + 4, 0x0100, true); // vDriverVersion

    const name = "Emulated Aux Audio";
    if (isWide) {
        // szPname[32] WCHAR
        for (let i = 0; i < 32; i++) {
            const code = i < name.length ? name.charCodeAt(i) : 0;
            view.setUint16(pac + 8 + i * 2, code, true);
        }
        view.setUint16(pac + 72, 1, true); // wTechnology
        view.setUint16(pac + 74, 0, true); // wReserved1
        view.setUint32(pac + 76, AUXCAPS_VOLUME | AUXCAPS_LRVOLUME, true); // dwSupport
    } else {
        // szPname[32] CHAR
        for (let i = 0; i < 32; i++) {
            mem[pac + 8 + i] = i < name.length ? name.charCodeAt(i) : 0;
        }
        view.setUint16(pac + 40, 1, true); // wTechnology
        view.setUint16(pac + 42, 0, true); // wReserved1
        view.setUint32(pac + 44, AUXCAPS_VOLUME | AUXCAPS_LRVOLUME, true); // dwSupport
    }
}

export function registerWinmmCapsExports(exports: Record<string, ThunkImplementation>): void {
    // PlaySound-style master volume for the emulated aux device (per registration).
    let auxVolume = 0xFFFFFFFF;
    let mixerVolume = 0xFFFF;

    const writeAnsiField = (mem: Uint8Array, offset: number, size: number, value: string): void => {
        for (let i = 0; i < size; i++) mem[offset + i] = i < value.length ? value.charCodeAt(i) : 0;
    };

    // ==================== Wave Input Functions (Stubs) ====================

    exports["waveInGetNumDevs"] = () => 1;

    exports["waveInGetDevCapsA"] = (ctx, mem, args) => {
        const pwic = args[1];
        const cbwic = args[2];
        if (pwic && cbwic >= 48) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint16(pwic + 0, 0xFFFF, true);
            view.setUint16(pwic + 2, 0x0001, true);
            view.setUint32(pwic + 4, 0x0100, true);
            const name = "BottleShip Audio In\0";
            for (let i = 0; i < 32; i++) {
                mem[pwic + 8 + i] = i < name.length ? name.charCodeAt(i) : 0;
            }
            view.setUint32(pwic + 40, 0x00FF00FF, true);
            view.setUint16(pwic + 44, 2, true);
            view.setUint16(pwic + 46, 0, true);
        }
        return MMSYSERR_NOERROR;
    };

    exports["waveInGetDevCapsW"] = (ctx, mem, args) => {
        const pwic = args[1];
        const cbwic = args[2];
        if (pwic && cbwic >= 80) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint16(pwic + 0, 0xFFFF, true);
            view.setUint16(pwic + 2, 0x0001, true);
            view.setUint32(pwic + 4, 0x0100, true);
            const name = "BottleShip Audio In";
            for (let i = 0; i < 32; i++) {
                const ch = i < name.length ? name.charCodeAt(i) : 0;
                view.setUint16(pwic + 8 + i * 2, ch, true);
            }
            view.setUint32(pwic + 72, 0x00FF00FF, true);
            view.setUint16(pwic + 76, 2, true);
            view.setUint16(pwic + 78, 0, true);
        }
        return MMSYSERR_NOERROR;
    };

    exports["waveInGetErrorTextA"] = (_ctx, mem, args) => {
        const mmrError = args[0] >>> 0;
        const pszText = args[1] >>> 0;
        const cchText = args[2] >>> 0;
        if (!pszText || cchText === 0) return MMSYSERR_INVALPARAM;
        const text = mmrError === MMSYSERR_NOERROR
            ? "No error"
            : mmrError === MMSYSERR_BADDEVICEID
                ? "The specified device identifier is out of range."
                : mmrError === MMSYSERR_INVALPARAM
                    ? "The specified parameter is invalid."
                    : `Wave input error ${mmrError}`;
        const bytes = new TextEncoder().encode(text);
        const copyLen = Math.min(bytes.length, cchText - 1);
        if (copyLen > 0) mem.set(bytes.subarray(0, copyLen), pszText);
        mem[pszText + copyLen] = 0;
        return MMSYSERR_NOERROR;
    };

    exports["waveInOpen"] = (ctx, mem, args) => {
        const phwi = args[0];
        if (phwi) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(phwi, 0x30000001, true);
        }
        return MMSYSERR_NOERROR;
    };
    exports["waveInClose"] = () => MMSYSERR_NOERROR;
    exports["waveInPrepareHeader"] = (ctx, mem, args) => {
        const pwh = args[1];
        if (pwh) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const flags = view.getUint32(pwh + 16, true);
            view.setUint32(pwh + 16, flags | WHDR_PREPARED, true);
        }
        return MMSYSERR_NOERROR;
    };
    exports["waveInUnprepareHeader"] = () => MMSYSERR_NOERROR;
    exports["waveInAddBuffer"] = () => MMSYSERR_NOERROR;
    exports["waveInStart"] = () => MMSYSERR_NOERROR;
    exports["waveInStop"] = () => MMSYSERR_NOERROR;
    exports["waveInReset"] = () => MMSYSERR_NOERROR;

    // ==================== MIDI Input Functions ====================

    exports["midiInGetNumDevs"] = () => 1;

    exports["midiInGetDevCapsA"] = (ctx, mem, args) => {
        const uDeviceID = args[0] >>> 0;
        const pmic = args[1] >>> 0;
        const cbmic = args[2] >>> 0;

        if (!isValidMidiInDeviceId(uDeviceID)) {
            return MMSYSERR_BADDEVICEID;
        }
        if (!pmic || cbmic < 44 || pmic + 44 > mem.length) {
            return MMSYSERR_INVALPARAM;
        }
        writeMidiInCaps(mem, pmic, false);
        return MMSYSERR_NOERROR;
    };

    // ==================== Mixer Functions (Stubs) ====================
    exports["mixerGetNumDevs"] = () => 1;
    exports["mixerGetDevCapsA"] = (ctx, mem, args) => {
        const pmc = args[1];
        const cbmc = args[2] >>> 0;
        if (pmc && cbmc >= 48 && pmc + 48 <= mem.length) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint16(pmc + 0, 0xFFFF, true);
            view.setUint16(pmc + 2, 0x0001, true);
            view.setUint32(pmc + 4, 0x0100, true);
            writeAnsiField(mem, pmc + 8, 32, "BottleShip Mixer");
            view.setUint32(pmc + 40, 0, true);
            view.setUint32(pmc + 44, 1, true);
            return MMSYSERR_NOERROR;
        }
        return MMSYSERR_INVALPARAM;
    };
    exports["mixerOpen"] = (ctx, mem, args) => {
        const phmx = args[0];
        if (phmx) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(phmx, 0x40000001, true);
        }
        return MMSYSERR_NOERROR;
    };
    exports["mixerClose"] = () => MMSYSERR_NOERROR;
    exports["mixerGetLineInfoA"] = (ctx, mem, args) => {
        const pmxl = args[1] >>> 0;
        Logger.log(LogCategory.SYSTEM, `mixerGetLineInfoA: hmx=0x${args[0].toString(16)}, pmxl=0x${pmxl.toString(16)}, flags=0x${args[2].toString(16)}`);
        if (!pmxl || pmxl + 168 > mem.length) return MMSYSERR_INVALPARAM;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        if (view.getUint32(pmxl, true) < 168) return MMSYSERR_INVALPARAM;
        view.setUint32(pmxl + 12, 1, true); // dwLineID
        view.setUint32(pmxl + 16, 0x00000001, true); // MIXERLINE_LINEF_ACTIVE
        view.setUint32(pmxl + 20, 0, true);
        view.setUint32(pmxl + 24, 4, true); // MIXERLINE_COMPONENTTYPE_DST_SPEAKERS
        view.setUint32(pmxl + 28, 2, true); // stereo
        view.setUint32(pmxl + 32, 0, true);
        view.setUint32(pmxl + 36, 1, true); // one volume control
        writeAnsiField(mem, pmxl + 40, 16, "Speakers");
        writeAnsiField(mem, pmxl + 56, 64, "BottleShip Speakers");
        return MMSYSERR_NOERROR;
    };
    exports["mixerGetControlDetailsA"] = (ctx, mem, args) => {
        const details = args[1] >>> 0;
        Logger.log(LogCategory.SYSTEM, `mixerGetControlDetailsA: hmx=0x${args[0].toString(16)}, pmxcd=0x${details.toString(16)}, flags=0x${args[2].toString(16)}`);
        if (!details || details + 24 > mem.length) return MMSYSERR_INVALPARAM;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const cbDetails = view.getUint32(details + 16, true);
        const values = view.getUint32(details + 20, true);
        if (cbDetails < 4 || !values || values + 4 > mem.length) return MMSYSERR_INVALPARAM;
        view.setUint32(values, mixerVolume, true);
        return MMSYSERR_NOERROR;
    };
    exports["mixerSetControlDetails"] = (ctx, mem, args) => {
        const details = args[1] >>> 0;
        Logger.log(LogCategory.SYSTEM, `mixerSetControlDetails: hmx=0x${args[0].toString(16)}, pmxcd=0x${details.toString(16)}, flags=0x${args[2].toString(16)}`);
        if (!details || details + 24 > mem.length) return MMSYSERR_INVALPARAM;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const cbDetails = view.getUint32(details + 16, true);
        const values = view.getUint32(details + 20, true);
        if (cbDetails < 4 || !values || values + 4 > mem.length) return MMSYSERR_INVALPARAM;
        mixerVolume = Math.min(0xFFFF, view.getUint32(values, true));
        return MMSYSERR_NOERROR;
    };
    exports["mixerGetID"] = (ctx, mem, args) => {
        const puMxId = args[1];
        if (puMxId) {
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(puMxId, 0, true); // device ID 0
        }
        return MMSYSERR_NOERROR;
    };
    exports["mixerGetLineControlsA"] = (ctx, mem, args) => {
        const pmxlc = args[1] >>> 0;
        Logger.log(LogCategory.SYSTEM, `mixerGetLineControlsA: hmx=0x${args[0].toString(16)}, pmxlc=0x${pmxlc.toString(16)}, flags=0x${args[2].toString(16)}`);
        if (!pmxlc || pmxlc + 24 > mem.length) return MMSYSERR_INVALPARAM;
        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        if (view.getUint32(pmxlc, true) < 24) return MMSYSERR_INVALPARAM;
        const count = view.getUint32(pmxlc + 12, true);
        const controlSize = view.getUint32(pmxlc + 16, true);
        const control = view.getUint32(pmxlc + 20, true);
        if (count < 1 || controlSize < 148 || !control || control + 148 > mem.length) {
            return MMSYSERR_INVALPARAM;
        }
        view.setUint32(control + 0, 148, true);
        view.setUint32(control + 4, 1, true);
        view.setUint32(control + 8, 0x50030001, true); // MIXERCONTROL_CONTROLTYPE_VOLUME
        view.setUint32(control + 12, 0, true);
        view.setUint32(control + 16, 0, true);
        writeAnsiField(mem, control + 20, 16, "Volume");
        writeAnsiField(mem, control + 36, 64, "Master Volume");
        view.setUint32(control + 100, 0, true);
        view.setUint32(control + 104, 0xFFFF, true);
        view.setUint32(control + 124, 0x10000, true);
        return MMSYSERR_NOERROR;
    };

    // ==================== Auxiliary Audio Functions ====================

    exports["auxGetNumDevs"] = () => {
        Logger.verbose(LogCategory.SYSTEM, "auxGetNumDevs");
        return 1; // Report one emulated aux device
    };

    exports["auxGetDevCapsA"] = (ctx, mem, args) => {
        const uDeviceID = args[0] >>> 0;
        const pac = args[1] >>> 0;
        const cbac = args[2] >>> 0;

        Logger.verbose(LogCategory.SYSTEM, `auxGetDevCapsA: deviceId=${uDeviceID}, caps=0x${pac.toString(16)}, cb=${cbac}`);

        if (!isValidAuxDeviceId(uDeviceID)) {
            return MMSYSERR_BADDEVICEID;
        }
        if (!pac || cbac < 48 || pac + 48 > mem.length) {
            return MMSYSERR_INVALPARAM;
        }
        writeAuxCaps(mem, pac, false);
        return MMSYSERR_NOERROR;
    };

    exports["auxGetDevCapsW"] = (ctx, mem, args) => {
        const uDeviceID = args[0] >>> 0;
        const pac = args[1] >>> 0;
        const cbac = args[2] >>> 0;

        Logger.verbose(LogCategory.SYSTEM, `auxGetDevCapsW: deviceId=${uDeviceID}, caps=0x${pac.toString(16)}, cb=${cbac}`);

        if (!isValidAuxDeviceId(uDeviceID)) {
            return MMSYSERR_BADDEVICEID;
        }
        if (!pac || cbac < 80 || pac + 80 > mem.length) {
            return MMSYSERR_INVALPARAM;
        }
        writeAuxCaps(mem, pac, true);
        return MMSYSERR_NOERROR;
    };

    exports["auxGetVolume"] = (ctx, mem, args) => {
        const uDeviceID = args[0] >>> 0;
        const pdwVolume = args[1] >>> 0;

        Logger.verbose(LogCategory.SYSTEM, `auxGetVolume: deviceId=${uDeviceID}, out=0x${pdwVolume.toString(16)}`);

        if (!isValidAuxDeviceId(uDeviceID)) {
            return MMSYSERR_BADDEVICEID;
        }
        if (!pdwVolume || pdwVolume + 4 > mem.length) {
            return MMSYSERR_INVALPARAM;
        }

        const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        view.setUint32(pdwVolume, auxVolume >>> 0, true);
        return MMSYSERR_NOERROR;
    };

    exports["auxSetVolume"] = (ctx, mem, args) => {
        const uDeviceID = args[0] >>> 0;
        const dwVolume = args[1] >>> 0;
        Logger.verbose(
            LogCategory.SYSTEM,
            `auxSetVolume: deviceId=${uDeviceID}, volume=0x${dwVolume.toString(16)}`
        );
        if (!isValidAuxDeviceId(uDeviceID)) {
            return MMSYSERR_BADDEVICEID;
        }
        auxVolume = dwVolume;
        return MMSYSERR_NOERROR;
    };
}
