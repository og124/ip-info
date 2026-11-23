# ip-info

A `curl`-able "what's my IP" endpoint — your address, rough location and network
as JSON. Live at **https://ip.ojrg.dev**.

```console
$ curl -s https://ip.ojrg.dev
{
  "ip": "203.0.113.45",
  "ip_version": "IPv4",
  "country": "GB",
  "region": "England",
  "city": "London",
  "time_zone": "Europe/London",
  "asn": "2856",
  "as_org": "BT-UK-AS BTnet UK Regional network, GB",
  "user_agent": "curl/8.7.1",
  "timestamp": "2026-11-23T12:00:00.000Z"
}
```

It's a ~100-line AWS Lambda. The interesting part is everything around it:
making a public endpoint on a pay-per-request cloud that **can't run up a bill**.

## How it works

```
viewer ──TLS──> CloudFront ──SigV4 (OAC)──> Lambda Function URL (AWS_IAM auth)
                    │
                    ├─ adds CloudFront-Viewer-* headers (address, country, city, ASN…)
                    ├─ geo-restriction
                    ├─ caching disabled (every response is caller-specific)
                    └─ metrics ──> CloudWatch alarms ─┐
                                                       ├─> SNS ─> breaker Lambda
                       AWS Budgets (100% of limit) ───┘          └─> distribution Enabled = false
```

- **The handler** ([`src/handler.mjs`](src/handler.mjs)) reads the caller's
  address from `CloudFront-Viewer-Address` — behind CloudFront, the Lambda's
  own `sourceIp` is the *edge's* address, a classic mistake. It falls back to
  `X-Forwarded-For`, then `sourceIp`. The ASN is resolved to an organisation
  name via Team Cymru's DNS service with a 1.2 s timeout, and only after
  checking it's digits: it's the one input that becomes a DNS query.
- **Nobody can skip CloudFront.** The Function URL requires SigV4 and only the
  distribution (via Origin Access Control) may sign for it, so finding the
  `*.on.aws` hostname gets you a 403.
- **It reflects nothing you send** except your user agent: no query string, no
  body, no paths.

## Spend safety

AWS has no hard billing cap. For an endpoint like this the realistic way to
lose money is request volume, so the controls stack up to a hard stop:

| Layer | Cost | What it bounds |
|---|---|---|
| Lambda reserved concurrency (10) | free | compute — excess requests throttle instead of running |
| CloudFront geo-restriction, PriceClass_100 | free | who can reach it, and the per-request rate |
| Short log retention (7 days) and log expiry | free | log storage under a flood |
| Requests/hour and bytes/hour alarms | free | **trip the breaker** |
| Budget at 100% of the monthly limit | free | **trips the breaker** (slow backstop) |
| Shield Standard | free | common L3/L4 DDoS |

**The breaker** ([`src/breaker-core.mjs`](src/breaker-core.mjs)) is a second
Lambda subscribed to the alarm topic. It disables the CloudFront distribution,
which stops all further request charges, and emails why. It never re-enables on
its own: that takes a deliberate `{"action":"enable"}` invoke after someone has
looked at the traffic. If disabling fails, it says so loudly with the manual
commands, because that's the one case a human must hear about at once.

In normal use the whole thing sits inside AWS's free tiers.

## Run it locally

Node 20+, no dependencies.

```console
$ npm start
ip-info listening on http://localhost:8080

$ curl -s localhost:8080
{
  "ip": "::1",
  "ip_version": "IPv6",
  "user_agent": "curl/8.7.1",
  ...
}
```

CloudFront's location headers don't exist locally; fake them with environment
variables, and set `LOOKUP_ASN=1` for a real ASN lookup:

```console
$ COUNTRY=GB CITY=London ASN=2856 LOOKUP_ASN=1 npm start
```

## Tests

```console
$ npm test
```

Covers address precedence (viewer address → X-Forwarded-For → source IP),
IPv4/IPv6 handling, header mapping, ASN validation (a non-numeric ASN never
reaches the resolver), and the breaker's behaviour: trip, re-fire, explicit
re-enable only, and the loud failure path — all against fakes, no AWS needed.

## Deploying

This repo is the application. The production deployment is managed separately
with Terraform; to run your own you need, in outline:

1. A Lambda for `src/handler.mjs` (Node.js 20+, a Function URL with `AWS_IAM`
   auth, reserved concurrency).
2. A CloudFront distribution with that URL as an OAC-signed origin, caching
   disabled, and an origin request policy that adds the `CloudFront-Viewer-*`
   headers.
3. A second Lambda for `src/breaker.mjs` (`DISTRIBUTION_ID`, `ALERT_TOPIC_ARN`
   env vars; CloudFront get/update and SNS publish permissions), subscribed to
   an SNS topic that your CloudWatch alarms and budget publish to.
4. Make your infrastructure tool ignore changes to the distribution's
   `enabled` flag, or the next deploy quietly undoes a trip.

## Licence

MIT
