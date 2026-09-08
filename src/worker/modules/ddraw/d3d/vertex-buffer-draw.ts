interface VertexBuffer {
  getDataPtr(): number;
  getVertexSize(): number;
  getFVF(): number;
}
interface DrawHandler {
  handleDrawPrimitive(
    device: number,
    primitive: number,
    fvf: number,
    address: number,
    count: number,
    memory: Uint8Array,
    indexed?: boolean,
    indices?: number,
    indexCount?: number,
  ): void;
}

/** D3D7 VB draws use the same synchronous renderer as the existing DrawPrimitive fast path. */
export function drawVertexBuffer(
  stack: DataView,
  esp: number,
  memory: Uint8Array,
  indexed: boolean,
  lookup: (address: number) => VertexBuffer | null,
  handler: DrawHandler | null,
): number | null {
  if (!handler) return 0;
  const object = lookup(stack.getUint32(esp + 12, true));
  if (!object) return null; // Let the ordinary thunk report the invalid COM object.
  const address = object.getDataPtr() + stack.getUint32(esp + 16, true) * object.getVertexSize();
  handler.handleDrawPrimitive(
    stack.getUint32(esp + 4, true),
    stack.getUint32(esp + 8, true),
    object.getFVF(),
    address,
    stack.getUint32(esp + 20, true),
    memory,
    indexed,
    indexed ? stack.getUint32(esp + 24, true) : undefined,
    indexed ? stack.getUint32(esp + 28, true) : undefined,
  );
  return 0;
}
