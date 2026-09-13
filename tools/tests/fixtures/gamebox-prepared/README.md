# Prepared AOT test fixtures

These files are small, original synthetic phase fixtures. They contain one
offline translation unit, one profile-selected optimized unit, and the JSON
indexes needed to exercise the prepared runtime transport. They do not contain
a v86 runtime, a game bundle, or retail game data.

The static pair is produced and checked by the phase 4 offline translation
workflow (`scripts/bottleship/verify-offline-translation.mjs`). The optimized
pair and profile are produced and checked by the phase 5/6 profile workflows
(`scripts/bottleship/verify-cpu-profile.mjs` and the phase 6 region replay
verification). Refreshing these fixtures requires rerunning those repository
owned synthetic checks, then copying only the bounded index, profile, and AOT
unit outputs here. Their scope remains original synthetic input only.
