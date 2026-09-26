/** Room-only UDP transport. The host owns authentication and relay membership. */
export interface RoomUdpPacket {
    sourceSeat: number;
    sourcePort: number;
    destinationPort: number;
    payload: Uint8Array;
}

export const ROOM_UDP_CHANNEL = 1;
export const ROOM_UDP_MAX_PAYLOAD = 65507; // IPv4 UDP's maximum legal application payload
export const ROOM_UDP_MAX_QUEUE_BYTES = 64 * 1024;
const ROOM_ADDRESS_PREFIX = 0x00004d0a; // 10.77.0.x in Win32 little-endian in_addr

export function roomAddress(seat: number): number {
    return (ROOM_ADDRESS_PREFIX | ((seat + 1) << 24)) >>> 0;
}

export function roomSeat(address: number): number | null {
    if ((address & 0x00ffffff) !== ROOM_ADDRESS_PREFIX) return null;
    const seat = (address >>> 24) - 1;
    return seat >= 0 && seat < 12 ? seat : null;
}

export class RoomUdpTransport {
    private seat: number | null = null;
    private epoch = '';
    private sendPacket: ((destinationSeat: number, channel: number, payload: Uint8Array) => void) | null = null;
    private listeners = new Set<(packet: RoomUdpPacket) => void>();
    private disconnectListeners = new Set<() => void>();

    get connected(): boolean { return this.seat !== null && this.sendPacket !== null; }
    get localAddress(): number { return this.seat === null ? 0x0100007f : roomAddress(this.seat); }
    get localSeat(): number | null { return this.seat; }

    open(epoch: string, seat: number, send: (destinationSeat: number, channel: number, payload: Uint8Array) => void): boolean {
        this.close();
        if (!epoch || epoch.length > 128 || !Number.isInteger(seat) || seat < 0 || seat >= 12) return false;
        this.epoch = epoch;
        this.seat = seat;
        this.sendPacket = send;
        return true;
    }

    close(epoch?: string): void {
        if (epoch !== undefined && epoch !== this.epoch) return;
        const wasConnected = this.connected;
        this.seat = null;
        this.sendPacket = null;
        this.epoch = '';
        if (wasConnected) for (const listener of this.disconnectListeners) listener();
    }

    onPacket(listener: (packet: RoomUdpPacket) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    onDisconnect(listener: () => void): () => void {
        this.disconnectListeners.add(listener);
        return () => this.disconnectListeners.delete(listener);
    }

    receive(epoch: string, sourceSeat: number, channel: number, bytes: Uint8Array): void {
        if (!this.connected || epoch !== this.epoch || channel !== ROOM_UDP_CHANNEL ||
            !Number.isInteger(sourceSeat) || sourceSeat < 0 || sourceSeat >= 12 ||
            bytes.length < 5 || bytes.length > ROOM_UDP_MAX_PAYLOAD + 4) return;
        const sourcePort = (bytes[0]! << 8) | bytes[1]!;
        const destinationPort = (bytes[2]! << 8) | bytes[3]!;
        const payload = bytes.slice(4);
        const packet = { sourceSeat, sourcePort, destinationPort, payload };
        for (const listener of this.listeners) listener(packet);
    }

    send(address: number, sourcePort: number, destinationPort: number, payload: Uint8Array): boolean {
        if (!this.connected || payload.length < 1 || payload.length > ROOM_UDP_MAX_PAYLOAD) return false;
        const destinationSeat = address === 0xffffffff || address === 0x00000000 || address === 0xff004d0a
            ? 255 : roomSeat(address);
        if (destinationSeat === null) return false;
        const bytes = new Uint8Array(payload.length + 4);
        bytes[0] = sourcePort >>> 8; bytes[1] = sourcePort & 0xff;
        bytes[2] = destinationPort >>> 8; bytes[3] = destinationPort & 0xff;
        bytes.set(payload, 4);
        try { this.sendPacket!(destinationSeat, ROOM_UDP_CHANNEL, bytes); return true; }
        catch { this.close(); return false; }
    }
}

export const roomUdpTransport = new RoomUdpTransport();
