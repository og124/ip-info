// ip-info — echo the caller's own connection metadata as JSON.
//
// Designed to run as an AWS Lambda behind CloudFront. Behind CloudFront,
// `event.requestContext.http.sourceIp` is the CloudFront *edge* address, not
// the caller's. The caller's real address arrives in the
// `CloudFront-Viewer-Address` header (added by the distribution's origin
// request policy), with `X-Forwarded-For` as a fallback and sourceIp only as
// a last resort.
//
// Reflects nothing but connection data: no query strings, no request body,
// no arbitrary user input.
import { Resolver } from "node:dns/promises";

const NO_STORE = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

const ASN_RESOLVE_TIMEOUT_MS = 1200;

// "1.2.3.4:52000" -> "1.2.3.4" ; "2600:1f18::abc:57678" -> "2600:1f18::abc"
export const stripPort = (v) => {
  if (!v) return undefined;
  const i = v.lastIndexOf(":");
  return i === -1 ? v : v.slice(0, i);
};

export const firstForwarded = (xff) =>
  xff ? xff.split(",")[0].trim() || undefined : undefined;

const num = (v) => {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

// AS number -> organisation name, via Team Cymru's DNS service. Bounded by a
// timeout and never throws: a slow or failing lookup just omits the field.
export const resolveAsnOrg = async (asn) => {
  const resolver = new Resolver();
  const timer = setTimeout(() => resolver.cancel(), ASN_RESOLVE_TIMEOUT_MS);
  try {
    const [txt] = await resolver.resolveTxt(`AS${asn}.asn.cymru.com`);
    return txt.join("").split("|").pop()?.trim() || undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
};

// The ASN lookup is injectable so tests (and the local server) can run
// without touching the network.
export const createHandler = ({ resolveAsn = resolveAsnOrg, log = console.log } = {}) =>
  async (event) => {
    const h = event.headers || {};
    const asn = h["cloudfront-viewer-asn"];

    // Digits only before it reaches the resolver. CloudFront sets this
    // header, but it is still the one input that becomes a DNS query name,
    // so it is validated rather than trusted.
    const asOrg = asn && /^\d{1,10}$/.test(asn) ? await resolveAsn(asn) : undefined;

    const ip =
      stripPort(h["cloudfront-viewer-address"]) ??
      firstForwarded(h["x-forwarded-for"]) ??
      event.requestContext?.http?.sourceIp;

    const body = {
      ip,
      ip_version: ip ? (ip.includes(":") ? "IPv6" : "IPv4") : undefined,
      country: h["cloudfront-viewer-country"],
      region: h["cloudfront-viewer-country-region-name"],
      city: h["cloudfront-viewer-city"],
      postal_code: h["cloudfront-viewer-postal-code"],
      latitude: num(h["cloudfront-viewer-latitude"]),
      longitude: num(h["cloudfront-viewer-longitude"]),
      time_zone: h["cloudfront-viewer-time-zone"],
      asn,
      as_org: asOrg,
      user_agent: h["user-agent"],
      timestamp: new Date().toISOString(),
    };

    // Drop keys CloudFront did not populate rather than emitting nulls.
    for (const k of Object.keys(body)) {
      if (body[k] === undefined) delete body[k];
    }

    // One structured access record per request. With the Lambda log format
    // set to JSON, the runtime nests this object under `message`, so
    // CloudWatch Logs Insights can filter on `message.ip` with no parsing:
    //
    //   fields @timestamp, message.ip, message.country, message.asn
    //   | filter message.event = "access"
    log({
      event: "access",
      // CloudFront adds x-amz-cf-id to every origin request; it matches
      // `x-edge-request-id` in CloudFront's own logs, joining the two.
      cf_request_id: h["x-amz-cf-id"],
      request_id: event.requestContext?.requestId,
      method: event.requestContext?.http?.method,
      path: event.rawPath,
      status: 200,
      ...body,
    });

    return {
      statusCode: 200,
      headers: NO_STORE,
      body: JSON.stringify(body, null, 2) + "\n",
    };
  };

export const handler = createHandler();
