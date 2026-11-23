// Run the handler locally: a plain HTTP server that turns each request into
// the event CloudFront + a Lambda Function URL would deliver.
//
//   npm start
//   curl -s localhost:8080
//
// CloudFront's geolocation headers don't exist locally. Set any of them with
// environment variables to see the full response, e.g.
//
//   COUNTRY=GB CITY=London ASN=2856 npm start
//
// ASN lookups are skipped unless LOOKUP_ASN=1 (it makes a real DNS query).
import http from "node:http";
import { createHandler, resolveAsnOrg } from "../src/handler.mjs";

const PORT = Number(process.env.PORT || 8080);
const handler = createHandler({
  resolveAsn: process.env.LOOKUP_ASN === "1" ? resolveAsnOrg : async () => undefined,
});

const GEO = {
  "cloudfront-viewer-country": process.env.COUNTRY,
  "cloudfront-viewer-country-region-name": process.env.REGION,
  "cloudfront-viewer-city": process.env.CITY,
  "cloudfront-viewer-time-zone": process.env.TIME_ZONE,
  "cloudfront-viewer-asn": process.env.ASN,
};

http
  .createServer(async (req, res) => {
    const { remoteAddress, remotePort } = req.socket;
    const event = {
      rawPath: new URL(req.url, "http://localhost").pathname,
      headers: {
        ...Object.fromEntries(Object.entries(GEO).filter(([, v]) => v)),
        "user-agent": req.headers["user-agent"],
        "cloudfront-viewer-address": `${remoteAddress}:${remotePort}`,
      },
      requestContext: { requestId: "local", http: { method: req.method, sourceIp: remoteAddress } },
    };
    const out = await handler(event);
    res.writeHead(out.statusCode, out.headers);
    res.end(out.body);
  })
  .listen(PORT, () => console.error(`ip-info listening on http://localhost:${PORT}`));
