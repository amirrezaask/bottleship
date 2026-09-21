#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
out="${1:-../../../../evidence/windows-samples}"
mkdir -p "$out"
cc="${CC:-i686-w64-mingw32-gcc}"
"$cc" --version > "$out/compiler.txt"
flags=(-std=c11 -O2 -Wall -Wextra -Werror=implicit-function-declaration -ffreestanding -fno-builtin -fno-stack-protector -mno-stack-arg-probe -nostdlib -Wl,--entry,_start -Wl,--subsystem,windows -Wl,--no-insert-timestamp)
"$cc" "${flags[@]}" -DSAMPLE_D3D=8 arena.c -o "$out/d3d8-arena.exe" -ld3d8 -lwinmm -luser32 -lkernel32 -lgcc
"$cc" "${flags[@]}" -DSAMPLE_D3D=9 arena.c -o "$out/d3d9-arena.exe" -ld3d9 -lwinmm -luser32 -lkernel32 -lgcc
"$cc" "${flags[@]}" ddraw.c -o "$out/ddraw7-arena.exe" -lddraw -ldxguid -lwinmm -luser32 -lkernel32 -lgcc
for exe in "$out"/*.exe; do
  i686-w64-mingw32-objdump -p "$exe" > "$exe.imports.txt"
  file "$exe"
done
(cd "$out" && sha256sum *.exe > SHA256SUMS)
