const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");

const {
  startTestServer,
  stopTestServer,
  createIsolatedStore,
  snapshotUploadsDir,
  cleanupUploads,
} = require("./helpers/test-utils.js");

const { storePath, cleanupStore } = createIsolatedStore();

process.env.NODE_ENV = "test";
process.env.API_TOKEN = "test-sec-headers-token-333";
process.env.APP_PORT = "0";
process.env.RATE_LIMIT_MAX_UPLOADS = "1000";
process.env.RATE_LIMIT_MAX_SUBSCRIBE = "1000";
process.env.RATE_LIMIT_MAX_API = "1000";
process.env.RATE_LIMIT_MAX_PUBLIC = "1000";
process.env.TRUST_PROXY = "1";

const app = require("../server.js");

let server;
let baseUrl;
let existingUploads;

before(async () => {
  existingUploads = snapshotUploadsDir();
  const res = await startTestServer(app);
  server = res.server;
  baseUrl = res.baseUrl;
});

after(async () => {
  await stopTestServer(server);
  cleanupStore();
  cleanupUploads(existingUploads);
});

describe("🛡️ Security Headers, CORS & SSRF Defense Test Matrix", () => {
  test("Security Headers: verifies all required hardening headers are present and configured", async () => {
    const res = await fetch(`${baseUrl}/`);

    // X-Content-Type-Options
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");

    // X-Frame-Options
    assert.equal(res.headers.get("x-frame-options"), "SAMEORIGIN");

    // X-Powered-By must be disabled / stripped
    assert.equal(res.headers.get("x-powered-by"), null);

    // Cross-Origin-Resource-Policy
    assert.equal(res.headers.get("cross-origin-resource-policy"), "cross-origin");

    // Referrer-Policy
    assert.equal(res.headers.get("referrer-policy"), "strict-origin-when-cross-origin");

    // Content-Security-Policy
    const csp = res.headers.get("content-security-policy");
    assert.ok(csp, "CSP header must be present");
    assert.ok(csp.includes("default-src 'self'"));
    assert.ok(csp.includes("cdn.jsdelivr.net"));
    assert.ok(csp.includes("object-src 'none'"));
    assert.ok(csp.includes("frame-ancestors 'self'"));
  });

  test("CORS Preflight: responds to OPTIONS /api/upload and /api/shorten with proper CORS headers", async () => {
    const endpoints = ["/api/upload", "/api/shorten"];

    for (const ep of endpoints) {
      const res = await fetch(`${baseUrl}${ep}`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://discord.com",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "x-api-token, Content-Type",
        },
      });

      assert.ok([200, 204].includes(res.status));
      assert.ok(res.headers.get("access-control-allow-origin"));
      const allowMethods = res.headers.get("access-control-allow-methods");
      assert.ok(allowMethods && allowMethods.includes("POST"));
      const allowHeaders = res.headers.get("access-control-allow-headers");
      assert.ok(allowHeaders && allowHeaders.toLowerCase().includes("x-api-token"));
      assert.equal(res.headers.get("access-control-allow-credentials"), "true");
    }
  });

  test("SSRF Defense: blocks dangerous and non-http URI schemes", async () => {
    const dangerousSchemes = [
      "javascript:alert(document.cookie)",
      "file:///etc/passwd",
      "data:text/html,<script>alert(1)</script>",
      "ftp://anonymous@ftp.example.com",
      "blob:https://example.com/uuid-blob",
    ];

    for (const targetUrl of dangerousSchemes) {
      const res = await fetch(`${baseUrl}/api/shorten`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-token": "test-sec-headers-token-333",
        },
        body: JSON.stringify({ targetUrl }),
      });

      assert.equal(res.status, 400, `Expected rejection for targetUrl: ${targetUrl}`);
      const body = await res.json();
      assert.equal(body.code, "TARGET_INVALID");
    }
  });

  test("SSRF Defense: blocks open redirect protocol-relative URLs (//attacker.com, /\\attacker.com)", async () => {
    const protocolRelativeTargets = [
      "//attacker.com/malicious",
      "/\\attacker.com/malicious",
      "//127.0.0.1/evil",
    ];

    for (const targetUrl of protocolRelativeTargets) {
      const res = await fetch(`${baseUrl}/api/shorten`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-token": "test-sec-headers-token-333",
        },
        body: JSON.stringify({ targetUrl }),
      });

      assert.equal(res.status, 400, `Expected rejection for target: ${targetUrl}`);
      const body = await res.json();
      assert.equal(body.code, "TARGET_INVALID");
    }
  });

  test("SSRF Defense: blocks private, loopback, and cloud metadata targets", async () => {
    const privateHosts = [
      "http://localhost",
      "http://localhost:8080/admin",
      "http://sub.localhost",
      "http://127.0.0.1",
      "http://127.0.0.1:3000/internal",
      "http://0.0.0.0:80",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.1:8080",
      "http://10.254.254.254",
      "http://192.168.1.1",
      "http://192.168.0.100",
      "http://172.16.0.1",
      "http://172.31.255.255",
      "http://server.local",
      "http://api.internal",
      "http://secret.onion",
    ];

    for (const host of privateHosts) {
      const res = await fetch(`${baseUrl}/api/shorten`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-token": "test-sec-headers-token-333",
        },
        body: JSON.stringify({ targetUrl: host }),
      });

      assert.equal(res.status, 400, `Expected 400 rejection for private target: ${host}`);
      const body = await res.json();
      assert.equal(body.code, "TARGET_INVALID");
    }
  });

  test("SSRF Defense: allows valid public HTTPS/HTTP URLs and relative local paths", async () => {
    const validTargets = [
      "https://github.com/notysozu/EmbedCDN",
      "https://google.com/search?q=test",
      "http://example.com/demo.html",
      "/files/sample-file.png",
      "/assets/logo.ico",
    ];

    for (const targetUrl of validTargets) {
      const res = await fetch(`${baseUrl}/api/shorten`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-token": "test-sec-headers-token-333",
        },
        body: JSON.stringify({ targetUrl }),
      });

      assert.equal(res.status, 200, `Expected 200 for valid target: ${targetUrl}`);
      const body = await res.json();
      assert.ok(body.data.shortCode);
    }
  });
});
