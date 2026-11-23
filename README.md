# ip-info

A `curl`-able "what's my IP" endpoint — your address, rough location and network
as JSON.

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
  checking it's digits.
- **Nobody can skip CloudFront.** The Function URL requires SigV4 and only the
  distribution (via Origin Access Control) may sign for it, so finding the
  `*.on.aws` hostname gets you a 403.
- **It reflects nothing you send** except your user agent.

## Run it locally

Node 20+:

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
reaches the resolver), and the breaker's behaviour.

## Licence

MIT
