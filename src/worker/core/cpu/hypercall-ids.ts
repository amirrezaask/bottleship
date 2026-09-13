/** Stable WASM hypercall ids shared by the data-page writer and static HLE
 * descriptors. This module intentionally has no runtime imports: descriptor
 * registration happens while the hypercall manager is initializing. */
export const HANDLER_EAGL_SHADER_CONVERT = 128;
export const HANDLER_EAGL_APPLY_REG_INT = 129;
export const HANDLER_EAGL_APPLY_REG_FLOAT = 130;
export const HANDLER_EAGL_APPLY_PACKED = 131;
export const HANDLER_EAGL_TOKEN_DISPATCH = 132;
export const HANDLER_EAGL_COMMIT_CLUSTER = 133;
export const HANDLER_EAGL_PASS_DRIVER = 134;
