//! Resident, identity-mapped guest RAM only. Guard misses leave the scalar/JS path in charge.
use std::ptr::{addr_of, copy, write_bytes};
use crate::cpu::{cpu, global_pointers, memory};
use cpu::{TLB_VALID, TLB_READONLY, TLB_NO_USER, TLB_IN_MAPPED_RANGE, TLB_HAS_CODE};
#[cfg(target_feature = "simd128")]
use std::arch::wasm32::*;

static mut ENABLED: bool = true;
// memcpy, memset, memcmp, memmove, memchr hits; rejected bulk attempts.
static mut STATS: [u32; 6] = [0; 6];

#[no_mangle]
pub extern "C" fn get_bulk_memory_abi() -> u32 { 1 }
#[no_mangle]
pub unsafe extern "C" fn set_bulk_memory_enabled(enabled: u32) { ENABLED = enabled != 0; }
#[no_mangle]
pub unsafe extern "C" fn get_bulk_memory_stats_ptr() -> u32 { addr_of!(STATS) as u32 }

#[inline]
unsafe fn count(index: usize) { STATS[index] = STATS[index].wrapping_add(1); }

/// Do not populate TLB entries here: a probe must neither fault nor set A/D bits.
/// Valid resident entries already carry those effects from normal CPU translation.
unsafe fn resident_span(start: u32, len: u32, write: bool) -> bool {
    if !ENABLED || len == 0 || start < 0x10_0000 { return false; }
    let Some(end) = start.checked_add(len - 1) else { return false; };
    if end >= *global_pointers::memory_size { return false; }
    if write && cpu::DBG_WRITE_WATCH != 0 { return false; }
    let reject = TLB_IN_MAPPED_RANGE | if *global_pointers::cpl == 3 { TLB_NO_USER } else { 0 }
        | if write { TLB_READONLY | TLB_HAS_CODE } else { 0 };
    for page in (start >> 12)..=(end >> 12) {
        let entry = cpu::tlb_data[page as usize];
        if entry & (TLB_VALID | reject) != TLB_VALID { return false; }
        let physical = ((entry & !0xfff) as u32 ^ (page << 12)).wrapping_sub(memory::mem8 as u32);
        if physical != page << 12 { return false; }
    }
    true
}

pub unsafe fn try_copy(dst: u32, src: u32, len: u32, overlapping: bool) -> bool {
    if !resident_span(src, len, false) || !resident_span(dst, len, true) {
        count(5); return false;
    }
    // memcpy's old forward-copy overlap behavior is not silently changed to memmove.
    if !overlapping && dst < src + len && src < dst + len { count(5); return false; }
    copy(memory::mem8.add(src as usize), memory::mem8.add(dst as usize), len as usize);
    count(if overlapping { 3 } else { 0 });
    true
}

pub unsafe fn try_fill(dst: u32, value: u8, len: u32) -> bool {
    if !resident_span(dst, len, true) { count(5); return false; }
    write_bytes(memory::mem8.add(dst as usize), value, len as usize);
    count(1);
    true
}

/// Validate reads one page at a time so an early mismatch never probes a later page.
pub unsafe fn try_compare(a: u32, b: u32, len: u32) -> Option<i32> {
    let mut offset = 0u32;
    while offset < len {
        let Some(left) = a.checked_add(offset) else { count(5); return None; };
        let Some(right) = b.checked_add(offset) else { count(5); return None; };
        let chunk = (len - offset).min(4096 - (left & 4095)).min(4096 - (right & 4095));
        if !resident_span(left, chunk, false) || !resident_span(right, chunk, false) { count(5); return None; }
        let p = memory::mem8.add(left as usize);
        let q = memory::mem8.add(right as usize);
        let mut i = 0usize;
        #[cfg(target_feature = "simd128")]
        while i + 16 <= chunk as usize {
            let mask = i8x16_bitmask(i8x16_ne(v128_load(p.add(i).cast()), v128_load(q.add(i).cast())));
            if mask != 0 {
                i += mask.trailing_zeros() as usize;
                count(2); return Some(*p.add(i) as i32 - *q.add(i) as i32);
            }
            i += 16;
        }
        while i < chunk as usize {
            let diff = *p.add(i) as i32 - *q.add(i) as i32;
            if diff != 0 { count(2); return Some(diff); }
            i += 1;
        }
        offset += chunk;
    }
    count(2);
    Some(0)
}

pub unsafe fn try_find(src: u32, byte: u8, len: u32) -> Option<u32> {
    if !ENABLED { return None; }
    let mut offset = 0u32;
    while offset < len {
        let Some(start) = src.checked_add(offset) else { count(5); return None; };
        let chunk = (len - offset).min(4096 - (start & 4095));
        if !resident_span(start, chunk, false) { count(5); return None; }
        let p = memory::mem8.add(start as usize);
        let mut i = 0usize;
        #[cfg(target_feature = "simd128")]
        while i + 16 <= chunk as usize {
            let mask = i8x16_bitmask(i8x16_eq(v128_load(p.add(i).cast()), u8x16_splat(byte)));
            if mask != 0 {
                count(4); return Some(start + i as u32 + mask.trailing_zeros());
            }
            i += 16;
        }
        while i < chunk as usize {
            if *p.add(i) == byte { count(4); return Some(start + i as u32); }
            i += 1;
        }
        offset += chunk;
    }
    count(4);
    Some(0)
}
