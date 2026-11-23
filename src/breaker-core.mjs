// Cost circuit breaker — the logic, with no AWS SDK dependency.
//
// AWS has no hard billing cap. For a public endpoint behind CloudFront, the
// realistic way to run up a bill is request volume, so the hard stop is to
// disable the CloudFront distribution. A CloudWatch alarm (requests/hour,
// bytes/hour) or a 100%-of-budget AWS Budgets notification publishes to an
// SNS topic, which invokes this function.
//
// The CloudFront and SNS calls are injected (see breaker.mjs for the real
// wiring), so the behaviour can be tested without AWS.

// Pull whatever human-readable cause we can out of the SNS payload.
export const describeTrigger = (event) => {
  const records = event?.Records || [];
  if (records.length === 0) return "direct invoke";

  return records
    .map((r) => {
      const raw = r.Sns?.Message || "";
      try {
        const m = JSON.parse(raw);
        if (m.AlarmName) return `alarm ${m.AlarmName}: ${m.NewStateReason || m.NewStateValue}`;
        if (m.budgetName) return `budget ${m.budgetName} breached`;
      } catch {
        /* not JSON — Budgets sends plain text */
      }
      return (r.Sns?.Subject ? r.Sns.Subject + " — " : "") + raw.slice(0, 500);
    })
    .join("\n");
};

/**
 * @param {object} deps
 * @param {(id: string) => Promise<{ETag: string, DistributionConfig: object}>} deps.getConfig
 * @param {(id: string, etag: string, config: object) => Promise<void>} deps.updateConfig
 * @param {(subject: string, message: string) => Promise<void>} deps.notify
 * @param {string} deps.distributionId
 * @param {string} [deps.name] label used in alert subjects
 */
export const createBreaker = ({ getConfig, updateConfig, notify, distributionId, name = "endpoint" }) => {
  const setEnabled = async (enabled) => {
    const { ETag, DistributionConfig } = await getConfig(distributionId);
    if (DistributionConfig.Enabled === enabled) return false;
    DistributionConfig.Enabled = enabled;
    await updateConfig(distributionId, ETag, DistributionConfig);
    return true;
  };

  return async (event) => {
    // Re-enabling is deliberate: only a direct invoke with
    // {"action":"enable"} does it, never an alarm.
    const wantEnabled = event?.action === "enable";
    const trigger = describeTrigger(event);
    console.log(JSON.stringify({ msg: "breaker invoked", wantEnabled, trigger }));

    try {
      const changed = await setEnabled(wantEnabled);

      if (wantEnabled) {
        await notify(
          `[${name}] re-enabled`,
          changed
            ? `CloudFront distribution ${distributionId} re-enabled. ${name} is serving again.`
            : `CloudFront distribution ${distributionId} was already enabled. No change.`,
        );
        return { ok: true, enabled: true, changed };
      }

      await notify(
        changed ? `[${name}] BREAKER TRIPPED — disabled` : `[${name}] breaker re-fired`,
        changed
          ? `Cost circuit breaker tripped.\n\nCloudFront distribution ${distributionId} has been DISABLED; ` +
              `${name} is offline and accruing no further request charges.\n\nTrigger:\n${trigger}\n\n` +
              `Investigate the traffic source, then invoke this function with {"action":"enable"}.`
          : `Breaker fired but distribution ${distributionId} was already disabled.\n\nTrigger:\n${trigger}`,
      );
      return { ok: true, enabled: false, changed };
    } catch (err) {
      console.error("breaker failed", err);
      // The breaker failing is the one case a human must hear about at once.
      await notify(
        `[${name}] BREAKER FAILED — MANUAL ACTION REQUIRED`,
        `Could not disable distribution ${distributionId}.\n\nError: ${err?.name}: ${err?.message}\n\n` +
          `Trigger:\n${trigger}\n\nDisable it by hand now:\n` +
          `  aws cloudfront get-distribution-config --id ${distributionId}\n` +
          `  (set Enabled=false, then update-distribution --if-match <ETag>)`,
      );
      throw err;
    }
  };
};
