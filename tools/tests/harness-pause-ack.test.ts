/** Regression coverage for the harness pause RPC's asynchronous v86 stop ack. */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HarnessService } from "../../src/worker/harness/service";
import { registerBreakpointCommands } from "../../src/worker/harness/cmds/breakpoints";
import { HARNESS_REPLY } from "../../src/worker/harness/rpc";
import { System } from "../../src/worker/core/system";

const posted: any[] = [];
const originalPostMessage = (globalThis as any).postMessage;
const originalProcess = System.getInstance().process;
const originalPause = (globalThis as any).__harnessPause;
const originalPauseAndWait = (globalThis as any).__harnessPauseAndWait;

beforeEach(() => {
    posted.length = 0;
    (globalThis as any).postMessage = (message: unknown) => posted.push(message);
    System.getInstance().process = { v86: {} } as any;
});

afterEach(() => {
    (globalThis as any).postMessage = originalPostMessage;
    System.getInstance().process = originalProcess;
    (globalThis as any).__harnessPause = originalPause;
    (globalThis as any).__harnessPauseAndWait = originalPauseAndWait;
});

describe("harness pause acknowledgement", () => {
    test("does not resolve the pause RPC until v86 stop acknowledges", async () => {
        let acknowledge!: () => void;
        let ackCalled = false;
        let legacyCalled = false;
        const stopAcknowledged = new Promise<void>((resolve) => {
            acknowledge = resolve;
        });

        (globalThis as any).__harnessPause = () => {
            legacyCalled = true;
        };
        (globalThis as any).__harnessPauseAndWait = () => {
            ackCalled = true;
            return stopAcknowledged;
        };

        const svc = new HarnessService();
        registerBreakpointCommands(svc);
        let dispatchSettled = false;
        const dispatch = svc
            .dispatch({ type: "harness_rpc", id: 17, cmd: "pause", args: [] })
            .then(() => {
                dispatchSettled = true;
            });

        expect(ackCalled).toBe(true);
        expect(legacyCalled).toBe(false);
        expect(posted).toHaveLength(0);
        await Promise.resolve();
        expect(dispatchSettled).toBe(false);
        expect(posted).toHaveLength(0);

        acknowledge();
        await dispatch;

        expect(posted).toHaveLength(1);
        expect(posted[0]).toMatchObject({
            type: HARNESS_REPLY,
            id: 17,
            ok: true,
            result: { paused: true },
        });
    });
});
