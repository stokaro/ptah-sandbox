import assert from "node:assert/strict";
import { test } from "node:test";
import { installPromptDelay, INSTALL_PROMPT_WEEK } from "./install-prompt.ts";

test("dismissal survives a reload and expires exactly seven days later", () => {
  const closedAt = 1_800_000_000_000;
  const saved = String(closedAt + INSTALL_PROMPT_WEEK);
  assert.equal(installPromptDelay(saved, closedAt), 604_800_000);
  assert.equal(installPromptDelay(saved, closedAt + 86_400_000), 518_400_000);
  assert.equal(installPromptDelay(saved, closedAt + INSTALL_PROMPT_WEEK - 1), 1);
  assert.equal(installPromptDelay(saved, closedAt + INSTALL_PROMPT_WEEK), 0);
  assert.equal(installPromptDelay(saved, closedAt + INSTALL_PROMPT_WEEK + 1), 0);
});

test("missing, corrupt, or implausibly distant expiry does not suppress the prompt", () => {
  const now = 1_800_000_000_000;
  for (const saved of [null, "", "garbage", "NaN", "Infinity", "-1", String(now + 0.5), String(now + INSTALL_PROMPT_WEEK + 1)]) {
    assert.equal(installPromptDelay(saved, now), 0, String(saved));
  }
});
