const BUNDLE_EXTENSIONS = ['.wgb', '.gaf'] as const;

/** True for BottleShip's authoring bundle and GameBox's sealed catalog archive. */
export function isGameBundlePath(value: string): boolean {
  const pathname = value.split(/[?#]/, 1)[0]!.toLowerCase();
  return BUNDLE_EXTENSIONS.some((extension) => pathname.endsWith(extension));
}
