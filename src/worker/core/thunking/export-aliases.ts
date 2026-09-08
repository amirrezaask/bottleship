/** Decoration carries the stdcall ABI; a same-base name is not sufficient. */
export function compatibleExportAliases<
  T extends { functionName: string; stackCleanupBytes?: number; argCount?: number },
>(name: string, candidates: T[]): T[] {
  const decoration = name.match(/@(\d+)$/)?.[1];
  if (decoration !== undefined) {
    return candidates.filter((candidate) => {
      const other = candidate.functionName.match(/@(\d+)$/)?.[1];
      return other !== undefined
        ? other === decoration
        : (candidate.stackCleanupBytes ?? (candidate.argCount ?? -1) * 4) === Number(decoration);
    });
  }
  const cleanups = new Set(
    candidates.map((candidate) => candidate.stackCleanupBytes ?? (candidate.argCount ?? -1) * 4),
  );
  return cleanups.size <= 1 ? candidates : [];
}
