// Cost circuit breaker — Lambda entry point. Wires breaker-core.mjs to the
// real AWS SDK (v3, bundled with the Lambda Node.js runtime).
//
// Environment:
//   DISTRIBUTION_ID   the CloudFront distribution to disable
//   ALERT_TOPIC_ARN   SNS topic for "tripped" / "failed" notifications
//   NAME              label for alert subjects (optional)
//
// Recovery, after investigating:
//   aws lambda invoke --function-name <fn> --payload '{"action":"enable"}' /dev/stdout
//
// Infrastructure note: whatever deploys the distribution should ignore
// changes to its `enabled` attribute, or the next deploy silently undoes a
// trip.
import {
  CloudFrontClient,
  GetDistributionConfigCommand,
  UpdateDistributionCommand,
} from "@aws-sdk/client-cloudfront";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { createBreaker } from "./breaker-core.mjs";

const cf = new CloudFrontClient({});
const sns = new SNSClient({});
const topic = process.env.ALERT_TOPIC_ARN;

export const handler = createBreaker({
  distributionId: process.env.DISTRIBUTION_ID,
  name: process.env.NAME || "ip-info",
  getConfig: (id) => cf.send(new GetDistributionConfigCommand({ Id: id })),
  updateConfig: (id, etag, config) =>
    cf.send(new UpdateDistributionCommand({ Id: id, IfMatch: etag, DistributionConfig: config })),
  notify: async (subject, message) => {
    if (!topic) return;
    try {
      await sns.send(new PublishCommand({ TopicArn: topic, Subject: subject.slice(0, 100), Message: message }));
    } catch (err) {
      console.error("failed to publish alert", err);
    }
  },
});
