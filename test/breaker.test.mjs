import { test } from "node:test";
import assert from "node:assert/strict";
import { createBreaker, describeTrigger } from "../src/breaker-core.mjs";

// A fake CloudFront that records what the breaker did.
const fake = (enabled = true, { failUpdate = false } = {}) => {
  const state = { enabled, updates: [], alerts: [] };
  const breaker = createBreaker({
    distributionId: "EXAMPLE123",
    name: "test",
    getConfig: async () => ({ ETag: "etag-1", DistributionConfig: { Enabled: state.enabled } }),
    updateConfig: async (id, etag, cfg) => {
      if (failUpdate) throw Object.assign(new Error("throttled"), { name: "Throttling" });
      state.updates.push({ id, etag, enabled: cfg.Enabled });
      state.enabled = cfg.Enabled;
    },
    notify: async (subject, message) => state.alerts.push({ subject, message }),
  });
  return { state, breaker };
};

const alarm = { Records: [{ Sns: { Message: JSON.stringify({ AlarmName: "requests-per-hour", NewStateReason: "Threshold crossed" }) } }] };

test("an alarm disables the distribution and says so", async () => {
  const { state, breaker } = fake(true);
  const res = await breaker(alarm);
  assert.deepEqual(res, { ok: true, enabled: false, changed: true });
  assert.deepEqual(state.updates, [{ id: "EXAMPLE123", etag: "etag-1", enabled: false }]);
  assert.match(state.alerts[0].subject, /BREAKER TRIPPED/);
  assert.match(state.alerts[0].message, /requests-per-hour/);
});

test("firing again while already disabled changes nothing", async () => {
  const { state, breaker } = fake(false);
  const res = await breaker(alarm);
  assert.equal(res.changed, false);
  assert.equal(state.updates.length, 0);
  assert.match(state.alerts[0].subject, /re-fired/);
});

test("only an explicit {action: 'enable'} turns it back on", async () => {
  const { state, breaker } = fake(false);
  const res = await breaker({ action: "enable" });
  assert.deepEqual(res, { ok: true, enabled: true, changed: true });
  assert.equal(state.enabled, true);
});

test("a failed disable alerts loudly and rethrows", async () => {
  const { state, breaker } = fake(true, { failUpdate: true });
  await assert.rejects(breaker(alarm), /throttled/);
  assert.match(state.alerts[0].subject, /BREAKER FAILED/);
  assert.match(state.alerts[0].message, /update-distribution/);
});

test("describeTrigger reads alarms, budgets and plain text", () => {
  assert.equal(describeTrigger({}), "direct invoke");
  assert.match(describeTrigger(alarm), /alarm requests-per-hour: Threshold crossed/);
  assert.equal(
    describeTrigger({ Records: [{ Sns: { Message: JSON.stringify({ budgetName: "monthly" }) } }] }),
    "budget monthly breached",
  );
  assert.equal(describeTrigger({ Records: [{ Sns: { Subject: "AWS Budgets", Message: "over" } }] }), "AWS Budgets — over");
});
