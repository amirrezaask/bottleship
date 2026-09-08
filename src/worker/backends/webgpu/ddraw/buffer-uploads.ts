/** Snapshot adjacent CPU writes and upload once before command submission.
 * The caller flushes before submitting draws or reusing a ring allocation.
 * Gaps (including GPU-produced vertices) are never included in an upload.
 */
export class BufferUploads<T> {
  private staging = new Uint8Array(0);
  private target: T | undefined;
  private offset = 0;
  private length = 0;

  constructor(private readonly upload: (target: T, offset: number, bytes: Uint8Array) => void) {}

  append(target: T, offset: number, bytes: Uint8Array): void {
    if (!bytes.byteLength) return;
    const padded = Math.ceil(bytes.byteLength / 4) * 4;
    if (this.length && (target !== this.target || offset !== this.offset + this.length))
      this.flush();
    if (!this.length) {
      this.target = target;
      this.offset = offset;
    }
    const needed = this.length + padded;
    if (needed > this.staging.byteLength) {
      const next = new Uint8Array(Math.max(65536, needed, this.staging.byteLength * 2));
      next.set(this.staging.subarray(0, this.length));
      this.staging = next;
    }
    this.staging.set(bytes, this.length);
    this.staging.fill(0, this.length + bytes.byteLength, needed);
    this.length = needed;
  }

  flush(): void {
    if (!this.length) return;
    this.upload(this.target!, this.offset, this.staging.subarray(0, this.length));
    this.length = 0;
    this.target = undefined;
  }
}
