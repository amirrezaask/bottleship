import assert from "node:assert/strict";
import test from "node:test";
import { resolvePreparedRuntimeMapping } from "../../vite.config";

test("prepared runtime mapping defaults to the generic identity contract", () => {
  assert.equal(resolvePreparedRuntimeMapping(undefined), "identity");
  assert.equal(resolvePreparedRuntimeMapping("identity"), "identity");
});

test("prepared runtime mapping accepts the explicit profile contract", () => {
  assert.equal(resolvePreparedRuntimeMapping("profile"), "profile");
});

test("prepared runtime mapping rejects unvalidated build modes", () => {
  for (const value of ["", "PROFILE", "virtual", "identity "]) {
    assert.throws(
      () => resolvePreparedRuntimeMapping(value),
      /GAMEBOX_PREPARED_RUNTIME_MAPPING must be "identity" or "profile"/,
    );
  }
});
