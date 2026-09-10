//! SIMD over one already-translated REP page chunk. The caller owns faults and CPU state.
use std::ptr::{addr_of, read_unaligned, write_unaligned, write_bytes};
use std::arch::wasm32::*;
use crate::cpu::{cpu, memory, global_pointers};

static mut ENABLED: bool = true;
// CMPS chunks, SCAS chunks, STOSW chunks, STOSD chunks, rejected eligible chunks.
static mut STATS: [u32; 5] = [0; 5];
#[no_mangle]
pub extern "C" fn get_rep_memory_abi() -> u32 { 1 }
#[no_mangle]
pub unsafe extern "C" fn set_rep_memory_enabled(on: u32) { ENABLED = on != 0; }
#[no_mangle]
pub unsafe extern "C" fn get_rep_memory_stats_ptr() -> u32 { addr_of!(STATS) as u32 }
#[inline]
unsafe fn record(i: usize) { STATS[i] = STATS[i].wrapping_add(1); }

/// Physical addresses have already passed ordinary CPU translation. Unlike HLE,
/// remapped RAM is valid here. Never extend a chunk or touch the following page.
#[inline]
unsafe fn span<const SIZE: u32>(start: u32, count: u32, backwards: bool) -> Option<u32> {
    let bytes = count.checked_mul(SIZE)?;
    let low = if backwards { start.checked_sub(bytes.checked_sub(SIZE)?)? } else { start };
    let end = low.checked_add(bytes.checked_sub(1)?)?;
    if low >> 12 != end >> 12 || end >= *global_pointers::memory_size
        || memory::in_mapped_range(low) || memory::in_mapped_range(end) { return None; }
    Some(low)
}
#[inline]
unsafe fn load<const SIZE: u32>(start: u32, index: u32, backwards: bool) -> i32 {
    let addr = if backwards { start - index * SIZE } else { start + index * SIZE };
    let p = memory::mem8.add(addr as usize);
    match SIZE { 1 => *p as i32, 2 => read_unaligned(p.cast::<u16>()) as i32, _ => read_unaligned(p.cast::<i32>()) }
}
#[inline]
fn splat<const SIZE: u32>(value: i32) -> v128 {
    match SIZE { 1 => i8x16_splat(value as i8), 2 => i16x8_splat(value as i16), _ => i32x4_splat(value) }
}
#[inline]
fn equal_mask<const SIZE: u32>(a: v128, b: v128) -> u32 {
    match SIZE { 1 => i8x16_bitmask(i8x16_eq(a, b)) as u32,
        2 => i16x8_bitmask(i16x8_eq(a, b)) as u32, _ => i32x4_bitmask(i32x4_eq(a, b)) as u32 }
}

/// Return completed elements and the final subtraction operands, never EFLAGS.
/// ZF termination and page-restart semantics stay in the original CPU instruction.
#[inline(never)]
pub unsafe fn compare<const SIZE: u32, const SCAN: bool>(
    src: u32, dst: u32, count: u32, backwards: bool, while_equal: bool, value: i32,
) -> Option<(u32, i32, i32)> {
    let lanes = 16 / SIZE;
    if !ENABLED || count < lanes { return None; }
    if span::<SIZE>(dst, count, backwards).is_none()
        || (!SCAN && span::<SIZE>(src, count, backwards).is_none()) { record(4); return None; }
    let mask = match SIZE { 1 => 0xff, 2 => 0xffff, _ => -1 };
    let constant = value & mask;
    let left = if SCAN { constant } else { load::<SIZE>(src, 0, backwards) };
    let right = load::<SIZE>(dst, 0, backwards);
    // Immediate results avoid a vector load and mask extraction.
    record(if SCAN { 1 } else { 0 });
    if (left == right) != while_equal { return Some((1, left, right)); }
    let mut i = 1;
    let all = (1u32 << lanes) - 1;
    while i + lanes <= count {
        let index = if backwards { i + lanes - 1 } else { i };
        let delta = index * SIZE;
        let b = memory::mem8.add(if backwards { dst - delta } else { dst + delta } as usize);
        let a = if SCAN { splat::<SIZE>(constant) } else {
            let p = memory::mem8.add(if backwards { src - delta } else { src + delta } as usize);
            v128_load(p.cast())
        };
        let eq = equal_mask::<SIZE>(a, v128_load(b.cast()));
        let stop = if while_equal { !eq & all } else { eq };
        if stop != 0 {
            let lane = if backwards { lanes - 1 - (31 - stop.leading_zeros()) } else { stop.trailing_zeros() };
            i += lane;
            let a = if SCAN { constant } else { load::<SIZE>(src, i, backwards) };
            return Some((i + 1, a, load::<SIZE>(dst, i, backwards)));
        }
        i += lanes;
    }
    while i < count {
        let a = if SCAN { constant } else { load::<SIZE>(src, i, backwards) };
        let b = load::<SIZE>(dst, i, backwards);
        i += 1;
        if (a == b) != while_equal { return Some((i, a, b)); }
    }
    Some((count, if SCAN { constant } else { load::<SIZE>(src, count - 1, backwards) },
        load::<SIZE>(dst, count - 1, backwards)))
}

/// The caller already invalidated translated code before this write. Watches
/// retain the scalar stores, including their per-element callbacks and ordering.
#[inline(never)]
pub unsafe fn fill<const SIZE: u32>(dst: u32, count: u32, backwards: bool, value: i32) -> bool {
    if !ENABLED || count < 64 / SIZE { return false; }
    if cpu::DBG_WRITE_WATCH != 0 { record(4); return false; }
    let Some(low) = span::<SIZE>(dst, count, backwards) else { record(4); return false; };
    let p = memory::mem8.add(low as usize);
    let bytes = count * SIZE;
    let repeated = (value as u8 as u32).wrapping_mul(0x01010101);
    if (SIZE == 2 && value as u16 == repeated as u16) || (SIZE == 4 && value as u32 == repeated) {
        write_bytes(p, value as u8, bytes as usize);
    } else {
        let v = splat::<SIZE>(value);
        let mut offset = 0;
        while offset + 16 <= bytes { v128_store(p.add(offset as usize).cast(), v); offset += 16; }
        while offset < bytes {
            if SIZE == 2 { write_unaligned(p.add(offset as usize).cast::<u16>(), value as u16); }
            else { write_unaligned(p.add(offset as usize).cast::<i32>(), value); }
            offset += SIZE;
        }
    }
    record(if SIZE == 2 { 2 } else { 3 });
    true
}
