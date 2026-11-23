import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandler, stripPort, firstForwarded } from "../src/handler.mjs";

const quiet = () => {};
const run = async (headers, { resolveAsn = async () => undefined, sourceIp } = {}) => {
  const out = await createHandler({ resolveAsn, log: quiet })({
    headers,
    rawPath: "/",
    requestContext: { http: { method: "GET", sourceIp } },
  });
  return { ...out, json: JSON.parse(out.body) };
};

test("stripPort handles IPv4 and IPv6 viewer addresses", () => {
  assert.equal(stripPort("203.0.113.7:52000"), "203.0.113.7");
  assert.equal(stripPort("2001:db8::1:57678"), "2001:db8::1");
  assert.equal(stripPort(undefined), undefined);
});

test("firstForwarded takes the client end of X-Forwarded-For", () => {
  assert.equal(firstForwarded("198.51.100.4, 10.0.0.1"), "198.51.100.4");
  assert.equal(firstForwarded(""), undefined);
});

test("CloudFront-Viewer-Address wins over X-Forwarded-For and sourceIp", async () => {
  const { json } = await run(
    { "cloudfront-viewer-address": "203.0.113.7:1234", "x-forwarded-for": "198.51.100.4" },
    { sourceIp: "192.0.2.1" },
  );
  assert.equal(json.ip, "203.0.113.7");
  assert.equal(json.ip_version, "IPv4");
});

test("falls back to X-Forwarded-For, then to the edge source IP", async () => {
  assert.equal((await run({ "x-forwarded-for": "198.51.100.4" }, { sourceIp: "192.0.2.1" })).json.ip, "198.51.100.4");
  assert.equal((await run({}, { sourceIp: "192.0.2.1" })).json.ip, "192.0.2.1");
});

test("IPv6 is labelled as such", async () => {
  const { json } = await run({ "cloudfront-viewer-address": "2001:db8::42:443" });
  assert.equal(json.ip, "2001:db8::42");
  assert.equal(json.ip_version, "IPv6");
});

test("geolocation headers map to fields; numbers are numbers; absent keys are dropped", async () => {
  const { json } = await run({
    "cloudfront-viewer-address": "203.0.113.7:1",
    "cloudfront-viewer-country": "GB",
    "cloudfront-viewer-latitude": "51.5074",
    "cloudfront-viewer-longitude": "not-a-number",
  });
  assert.equal(json.country, "GB");
  assert.equal(json.latitude, 51.5074);
  assert.ok(!("longitude" in json));
  assert.ok(!("city" in json));
});

test("a numeric ASN is resolved to its organisation", async () => {
  const { json } = await run({ "cloudfront-viewer-asn": "2856" }, { resolveAsn: async (a) => `org-for-${a}` });
  assert.equal(json.asn, "2856");
  assert.equal(json.as_org, "org-for-2856");
});

test("a non-numeric ASN never reaches the resolver", async () => {
  let called = false;
  await run({ "cloudfront-viewer-asn": "2856.evil.example" }, { resolveAsn: async () => { called = true; } });
  assert.equal(called, false);
});

test("responses are never cached", async () => {
  const out = await run({});
  assert.equal(out.statusCode, 200);
  assert.equal(out.headers["cache-control"], "no-store");
});
