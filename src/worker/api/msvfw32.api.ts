/**
 * Video for Windows (msvfw32.dll) API Descriptor
 *
 * Provides DrawDib functions used by games to render AVI frames to screen.
 */

import { ModuleDescriptor, FunctionDescriptor, ParameterDescriptor } from "./types";

const buildParams = (count: number): ParameterDescriptor[] => {
    const params: ParameterDescriptor[] = [];
    for (let i = 0; i < count; i++) {
        params.push({ name: `arg${i}`, type: "u32" });
    }
    return params;
};

const makeFunc = (name: string, argCount: number, overrides: Partial<FunctionDescriptor> = {}): FunctionDescriptor => ({
    name,
    params: overrides.params ?? buildParams(argCount),
    returnType: overrides.returnType ?? "u32",
    callingConvention: overrides.callingConvention ?? "stdcall",
});

export const msvfw32Module: ModuleDescriptor = {
    name: "msvfw32",
    functions: [
        // Video Compression Manager imports must have stdcall stack metadata,
        // even when no compatible codec is installed.
        makeFunc("ICLocate", 5),
        makeFunc("ICSendMessage", 4),
        makeFunc("ICClose", 1),
        makeFunc("ICDecompress", 6),
        // VideoForWindowsVersion is exported by ordinal 2 on Windows.
        makeFunc("ord_2", 0, { ordinal: 2 }),

        // DrawDib API
        makeFunc("DrawDibOpen", 0),              // → HDRAWDIB
        makeFunc("DrawDibClose", 1),             // hdd
        makeFunc("DrawDibDraw", 13),             // hdd, hdc, xDst, yDst, dxDst, dyDst, lpbi, lpBits, xSrc, ySrc, dxSrc, dySrc, wFlags
    ]
};
