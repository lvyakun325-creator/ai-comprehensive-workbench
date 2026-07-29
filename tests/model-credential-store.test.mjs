import assert from "node:assert/strict";
import test from "node:test";
import {
  maskCredential,
  parseStoredCredentials,
  updateCredential,
} from "../app/lib/model-credential-store.mjs";

test("rejects malformed, overlong, and control-character credentials", () => {
  assert.deepEqual(parseStoredCredentials(null), {});
  assert.deepEqual(parseStoredCredentials("not json"), {});
  assert.deepEqual(parseStoredCredentials("[]"), {});
  assert.deepEqual(parseStoredCredentials('{"model-a":"sk-safe\\u0000value"}'), {});
  assert.deepEqual(
    parseStoredCredentials(JSON.stringify({ "model-a": "x".repeat(4_097) })),
    {},
  );
});

test("retains, replaces, clears, and masks credentials without exposing the full key", () => {
  const initial = { "model-a": "sk-secret-value-1234" };
  assert.deepEqual(updateCredential(initial, "model-a", "", false), initial);
  assert.deepEqual(updateCredential(initial, "model-a", "", true), {});
  assert.equal(
    updateCredential(initial, "model-a", "  sk-new-value-5678  ", false)["model-a"],
    "sk-new-value-5678",
  );
  const masked = maskCredential(initial["model-a"]);
  assert.match(masked, /^sk-/);
  assert.doesNotMatch(masked, /secret-value/);
});

test("fully masks 1 through 7 character credentials at the safe boundary", () => {
  for (const credential of [
    "a",
    "ab",
    "abc",
    "abcd",
    "abcde",
    "abcdef",
    "abcdefg",
  ]) {
    const masked = maskCredential(credential);
    assert.equal(masked, "••••");
    assert.notEqual(masked, credential);
    assert.doesNotMatch(masked, new RegExp(credential));
  }

  assert.equal(maskCredential("abcdefgh"), "abc…efgh");
});
