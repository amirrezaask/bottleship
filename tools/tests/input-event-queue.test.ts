import { describe, expect, test } from "bun:test";
import { INPUT_BUFFER_BYTES, INPUT_EVENT_CAPACITY, publishInputTransition } from "../../src/input-event-queue";
import { InputManager } from "../../src/worker/runtime/input/input-manager";

function fixture() {
    const buffer = new SharedArrayBuffer(INPUT_BUFFER_BYTES);
    const view = new Int32Array(buffer);
    const messages: number[][] = [];
    const win = { hwnd: 1, visible: true, rect: { x: 0, y: 0 } };
    const manager = new InputManager({
        getKeyboardTargetWindow: () => win, getMouseTargetWindow: () => win,
        getActiveHwnd: () => 1, postMessage: (...args: number[]) => messages.push(args),
    } as never);
    manager.setInputBuffer(buffer);
    function transition(change: () => void) {
        Atomics.add(view, 0, 1);
        change();
        publishInputTransition(view);
        Atomics.add(view, 0, 1);
    }
    return { view, manager, messages, transition };
}

describe("input transitions while guest execution is busy", () => {
    test("reset discards taps queued for the previous guest", () => {
        const f = fixture();
        f.transition(() => { f.view[16] = 1 << 13; });
        f.transition(() => { f.view[16] = 0; });
        f.manager.reset();
        f.manager.poll(true);
        expect(f.messages).toHaveLength(0);
    });
    test("keyboard input does not undo a guest cursor warp", () => {
        const f = fixture();
        f.transition(() => { f.view[1] = 100; f.view[2] = 80; });
        f.manager.poll(true);
        f.manager.setMousePosition(320, 240);
        f.transition(() => { f.view[16] = 1 << 13; });
        f.manager.poll(true);
        expect(f.manager.getMouseState()).toMatchObject({ x: 320, y: 240 });
        f.transition(() => { f.view[1] = 110; });
        f.manager.poll(true);
        expect(f.manager.getMouseState()).toMatchObject({ x: 110, y: 80 });
    });
    test("a complete key tap before a poll delivers down and up exactly once", () => {
        const f = fixture();
        f.transition(() => { f.view[16] = 1 << 13; });
        f.transition(() => { f.view[16] = 0; });
        f.manager.poll(true);
        f.manager.poll(true);
        expect(f.messages.map(m => m.slice(1, 3))).toEqual([[0x100, 13], [0x101, 13]]);
        expect(f.manager.keyStates[13]).toBe(0);
    });
    test("a fast click retains its press coordinates and its release", () => {
        const f = fixture();
        f.transition(() => { f.view[1] = 320; f.view[2] = 240; f.view[3] = 1; });
        f.transition(() => { f.view[3] = 0; });
        f.manager.poll(true);
        expect(f.messages.map(m => m[1])).toEqual([0x201, 0x202]);
        expect(f.messages[0]![3]).toBe((240 << 16) | 320);
        expect(f.manager.keyStates[1]).toBe(0);
    });
    test("queued input does not consume or duplicate the live wheel delta", () => {
        const f = fixture();
        f.transition(() => { f.view[16] = 1 << 13; f.view[12] = 100; });
        f.manager.poll(true);
        f.manager.poll(true);
        expect(f.messages.filter(m => m[1] === 0x20a)).toHaveLength(1);
        expect(f.view[12]).toBe(0);
    });
    test("overflow stays bounded and reconciles the latest released state", () => {
        const f = fixture();
        for (let i = 0; i < INPUT_EVENT_CAPACITY + 2; i++) {
            f.transition(() => { f.view[16] = i % 2 === 0 ? 1 << 13 : 0; });
        }
        expect(f.view[34]).toBe(2);
        f.manager.poll(true);
        expect(f.manager.keyStates[13]).toBe(0);
        expect(f.messages).toHaveLength(INPUT_EVENT_CAPACITY);
    });
});
