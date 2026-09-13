//! Unaligned REP page chunks. Cross-page elements use the CPU's scalar accessors.
use std::ptr::addr_of;
use crate::cpu::{cpu, memory, rep_memory};
use crate::paging::OrPageFault;
use crate::{jit, page::Page};

static mut ENABLED: bool = true;
// CMPSW/D, SCASW/D, STOSW/D, scalar bridge elements, rejected chunks.
static mut STATS: [u32; 8] = [0; 8];
#[no_mangle]
pub extern "C" fn get_unaligned_rep_abi() -> u32 { 1 }
#[no_mangle]
pub unsafe extern "C" fn set_unaligned_rep_enabled(on: u32) { ENABLED = on != 0; }
#[no_mangle]
pub unsafe extern "C" fn get_unaligned_rep_stats_ptr() -> u32 { addr_of!(STATS) as u32 }
#[inline]
unsafe fn record(i: usize) { STATS[i] = STATS[i].wrapping_add(1); }

#[inline]
fn chunk<const SIZE: u32>(address: u32, backwards: bool) -> u32 {
    let offset = address & 4095;
    // Even backward operations read/write SIZE bytes starting at each address.
    if offset > 4096 - SIZE { 0 }
    else if backwards { offset / SIZE + 1 }
    else { (4096 - offset) / SIZE }
}

#[inline]
unsafe fn read<const SIZE: u32>(address: i32) -> OrPageFault<i32> {
    if SIZE == 2 { cpu::safe_read16(address) } else { cpu::safe_read32s(address) }
}

/// KIND: 0=CMPS, 1=SCAS, 2=STOS. Return progress and final subtraction operands.
/// The caller updates architectural state only after this function succeeds.
#[inline(never)]
pub unsafe fn run<const SIZE: u32, const KIND: u32>(
    src: i32, dst: i32, count: u32, backwards: bool, while_equal: bool, value: i32,
) -> OrPageFault<Option<(u32, i32, i32)>> {
    if !ENABLED || !rep_memory::is_enabled() || count < 64 / SIZE { return Ok(None); }
    if KIND == 2 && cpu::DBG_WRITE_WATCH != 0 { record(7); return Ok(None); }
    let n = count.min(chunk::<SIZE>(dst as u32, backwards));
    let n = if KIND == 0 { n.min(chunk::<SIZE>(src as u32, backwards)) } else { n };
    if n < if KIND == 2 { 64 / SIZE } else { 16 / SIZE } {
        // One precise element bridges the page edge, retaining source-before-destination
        // fault ordering and the scalar writer's two-page preflight and JIT invalidation.
        let left = if KIND == 0 { read::<SIZE>(src)? }
            else if SIZE == 2 { value & 0xffff } else { value };
        let right = if KIND == 2 {
            if SIZE == 2 { cpu::safe_write16(dst, value)?; }
            else { cpu::safe_write32(dst, value)?; }
            0
        } else { read::<SIZE>(dst)? };
        record(6);
        return Ok(Some((1, left, right)));
    }

    // Match the original unaligned scalar path's source-before-destination ordering.
    let phys_src = if KIND == 0 {
        let p = cpu::translate_address_read(src)?;
        if memory::in_mapped_range(p) { record(7); return Ok(None); }
        p
    } else { 0 };
    let (phys_dst, skip_dirty) = if KIND == 2 {
        cpu::translate_address_write_and_can_skip_dirty(dst)?
    } else { (cpu::translate_address_read(dst)?, true) };
    if memory::in_mapped_range(phys_dst) { record(7); return Ok(None); }
    let result = if KIND == 2 {
        if !skip_dirty { jit::jit_dirty_page(Page::page_of(phys_dst)); }
        if rep_memory::fill::<SIZE>(phys_dst, n, backwards, value) { Some((n, 0, 0)) }
        else { None }
    } else if KIND == 0 {
        rep_memory::compare::<SIZE, false>(phys_src, phys_dst, n, backwards, while_equal, value)
    } else {
        rep_memory::compare::<SIZE, true>(0, phys_dst, n, backwards, while_equal, value)
    };
    record(if result.is_some() { KIND as usize * 2 + usize::from(SIZE == 4) } else { 7 });
    Ok(result)
}
