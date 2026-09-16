/** Bounded single-producer (browser), single-consumer (worker) input history.
 * State polling alone loses a complete press/release while guest code is busy.
 * Keep discrete transitions; mouse motion and wheel deltas stay coalesced.
 */
const HEAD = 32;
const TAIL = 33;
const OVERFLOW = 34;
const START = 64;
export const INPUT_EVENT_CAPACITY = 128;
export const INPUT_SNAPSHOT_WORDS = 24;
export const INPUT_BUFFER_BYTES = (START + INPUT_EVENT_CAPACITY * INPUT_SNAPSHOT_WORDS) * 4;

/** Called inside the browser's input seqlock write, after updating state. */
export function publishInputTransition(view: Int32Array): void {
    if (view.byteLength < INPUT_BUFFER_BYTES) return;
    const head = Atomics.load(view, HEAD) >>> 0;
    const tail = Atomics.load(view, TAIL) >>> 0;
    if (((head - tail) >>> 0) >= INPUT_EVENT_CAPACITY) {
        Atomics.add(view, OVERFLOW, 1);
        return; // Latest state still reconciles on the next worker poll.
    }
    const offset = START + (head % INPUT_EVENT_CAPACITY) * INPUT_SNAPSHOT_WORDS;
    for (let i = 0; i < INPUT_SNAPSHOT_WORDS; i++) view[offset + i] = view[i]!;
    view[offset] = (view[0]! + 1) | 0; // sequence after endInputWrite
    view[offset + 12] = 0; // wheel/raw motion are consumed from the live state only
    view[offset + 14] = 0;
    view[offset + 15] = 0;
    Atomics.store(view, HEAD, (head + 1) | 0);
}

export function readInputTransition(view: Int32Array, snapshot: Int32Array): boolean {
    if (view.byteLength < INPUT_BUFFER_BYTES) return false;
    const tail = Atomics.load(view, TAIL) >>> 0;
    if (tail === (Atomics.load(view, HEAD) >>> 0)) return false;
    const offset = START + (tail % INPUT_EVENT_CAPACITY) * INPUT_SNAPSHOT_WORDS;
    snapshot.set(view.subarray(offset, offset + INPUT_SNAPSHOT_WORDS));
    Atomics.store(view, TAIL, (tail + 1) | 0);
    return true;
}

/** Discard transitions from the previous guest when resetting its input state. */
export function discardInputTransitions(view: Int32Array): void {
    if (view.byteLength < INPUT_BUFFER_BYTES) return;
    Atomics.store(view, TAIL, Atomics.load(view, HEAD));
}
