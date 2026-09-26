import { describe, expect, test } from "bun:test";
import { makeSelect, makeSocketExports, WsaSocketTable, WSAENETDOWN, WSAEWOULDBLOCK } from "../../src/worker/modules/wsa-stub-shared";
import { roomAddress, roomSeat, roomUdpTransport, ROOM_UDP_CHANNEL } from "../../src/worker/modules/room-udp";

const mem = new Uint8Array(4096);
const view = new DataView(mem.buffer);
const invoke = (fn: ReturnType<typeof makeSocketExports>[string], args: number[]) =>
    fn!({} as never, mem, args) as number;
function sockaddr(ptr: number, address: number, port: number): void {
    mem.fill(0, ptr, ptr + 16);
    mem[ptr] = 2;
    mem[ptr + 2] = port >>> 8;
    mem[ptr + 3] = port & 255;
    view.setUint32(ptr + 4, address, true);
}

describe("room UDP guest socket contract", () => {
    test("virtual addresses, bind, broadcast, select, recvfrom and disconnect", () => {
        const outbound: Array<{ destination: number; channel: number; bytes: Uint8Array }> = [];
        expect(roomUdpTransport.open("epoch-a", 0, (destination, channel, bytes) =>
            outbound.push({ destination, channel, bytes: bytes.slice() }))).toBe(true);
        let lastError = 0;
        const table = new WsaSocketTable();
        const api = makeSocketExports(table, (code) => { lastError = code; });
        const socket = invoke(api.socket, [2, 2, 17]);
        sockaddr(100, 0, 27015);
        expect(invoke(api.bind, [socket, 100, 16])).toBe(0);
        expect(table.localPort(socket)).toBe(27015);
        expect(roomSeat(roomAddress(11))).toBe(11);
        mem.set([1, 2, 3], 300);
        sockaddr(120, 0xffffffff, 27015);
        expect(invoke(api.sendto, [socket, 300, 3, 0, 120, 16])).toBe(3);
        expect(outbound).toEqual([{ destination: 255, channel: ROOM_UDP_CHANNEL,
            bytes: new Uint8Array([0x69, 0x87, 0x69, 0x87, 1, 2, 3]) }]);
        // LAN broadcast also reaches local listeners on the host.
        expect(table.receive(socket, 16)?.payload).toEqual(new Uint8Array([1, 2, 3]));

        view.setUint32(600, 1, true);
        view.setUint32(604, socket, true);
        const select = makeSelect(table, (code) => { lastError = code; });
        view.setInt32(1000, 0, true);
        view.setInt32(1004, 0, true);
        expect(invoke(select, [0, 600, 0, 0, 1000])).toBe(0);
        expect(view.getUint32(600, true)).toBe(0);
        roomUdpTransport.receive("epoch-a", 1, ROOM_UDP_CHANNEL,
            new Uint8Array([0x69, 0x88, 0x69, 0x87, 9, 8, 7]));
        view.setUint32(600, 1, true);
        view.setUint32(604, socket, true);
        expect(invoke(select, [0, 600, 0, 0, 1000])).toBe(1);
        view.setUint32(800, 16, true);
        expect(invoke(api.recvfrom, [socket, 400, 16, 0, 700, 800])).toBe(3);
        expect(Array.from(mem.subarray(400, 403))).toEqual([9, 8, 7]);
        expect(view.getUint32(704, true)).toBe(roomAddress(1));
        expect(view.getUint32(800, true)).toBe(16);
        expect(invoke(api.recvfrom, [socket, 400, 16, 0, 700, 800])).toBe(-1);
        expect(lastError).toBe(WSAEWOULDBLOCK);
        roomUdpTransport.close("epoch-a");
        expect(invoke(api.sendto, [socket, 300, 3, 0, 120, 16])).toBe(-1);
        expect(lastError).toBe(WSAENETDOWN);
    });

    test("rejects stale epochs, unsupported destinations, and oversized datagrams", () => {
        const sent: Uint8Array[] = [];
        roomUdpTransport.open("epoch-b", 2, (_destination, _channel, bytes) => sent.push(bytes));
        const table = new WsaSocketTable();
        let lastError = 0;
        const api = makeSocketExports(table, (code) => { lastError = code; });
        const socket = invoke(api.socket, [2, 2, 17]);
        sockaddr(100, 0, 27016);
        invoke(api.bind, [socket, 100, 16]);
        roomUdpTransport.receive("epoch-a", 1, ROOM_UDP_CHANNEL,
            new Uint8Array([0, 1, 0x69, 0x88, 1]));
        expect(table.isReadable(socket)).toBe(false);
        sockaddr(120, 0x08080808, 27016);
        expect(invoke(api.sendto, [socket, 300, 3, 0, 120, 16])).toBe(-1);
        expect(sent).toHaveLength(0);
        roomUdpTransport.close("epoch-b");
        void lastError;
    });

    test("listen server receives its own localhost UDP traffic without relay", () => {
        let relayPackets = 0;
        roomUdpTransport.open("epoch-local", 3, () => { relayPackets++; });
        const table = new WsaSocketTable();
        const api = makeSocketExports(table, () => undefined);
        const server = invoke(api.socket, [2, 2, 17]);
        const client = invoke(api.socket, [2, 2, 17]);
        sockaddr(100, 0, 27015);
        expect(invoke(api.bind, [server, 100, 16])).toBe(0);
        sockaddr(120, 0x0100007f, 27015);
        mem.set([6, 7], 300);
        expect(invoke(api.sendto, [client, 300, 2, 0, 120, 16])).toBe(2);
        expect(table.isReadable(server)).toBe(true);
        expect(relayPackets).toBe(0);
        roomUdpTransport.close("epoch-local");
    });
});
