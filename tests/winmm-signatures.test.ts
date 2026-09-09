import { describe, expect, test } from "bun:test";
import { winmmModule } from "../src/worker/api/winmm.api";

describe("WinMM stdcall metadata", () => {
    test("covers the MIDI stream imports used by Virtua Cop 2", () => {
        const expected = new Map([
            ["midiOutPrepareHeader", 3],
            ["midiOutUnprepareHeader", 3],
            ["midiStreamOpen", 6],
            ["midiStreamOut", 3],
            ["midiStreamProperty", 3],
        ]);

        for (const [name, argCount] of expected) {
            const descriptor = winmmModule.functions.find((func) => func.name === name);
            expect(descriptor, `${name} descriptor`).toBeDefined();
            expect(descriptor?.callingConvention).toBe("stdcall");
            expect(descriptor?.params).toHaveLength(argCount);
        }
    });
});
