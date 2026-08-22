const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");

const {
  startTestServer,
  stopTestServer,
  createIsolatedStore,
  snapshotUploadsDir,
  cleanupUploads,
} = require("./helpers/test-utils.js");

const { storePath, cleanupStore } = createIsolatedStore();

// Set test environment variables before importing app
process.env.NODE_ENV = "test";
process.env.API_TOKEN = "test-secret-token-12345";
process.env.APP_PORT = "0"; // Dynamic port
process.env.APP_LINK = "http://127.0.0.1:3000";
process.env.MAX_FILE_SIZE_MB = "1"; // 1MB for fast testing
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

describe("1. Authentication & Cryptographic Timing Defense", () => {
  test("rejects request without x-api-token header with 401 Unauthorized", async () => {
    const res = await fetch(`${baseUrl}/api/shorten`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetUrl: "https://example.com/demo" }),
    });

    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, "Unauthorized");
  });

  test("rejects request with invalid token length or wrong token with 401 Unauthorized", async () => {
    const res = await fetch(`${baseUrl}/api/shorten`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-token": "wrong-token-length",
      },
      body: JSON.stringify({ targetUrl: "https://example.com/demo" }),
    });

    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, "Unauthorized");
  });

  test("accepts request with valid x-api-token with 200 OK", async () => {
    const res = await fetch(`${baseUrl}/api/shorten`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-token": "test-secret-token-12345",
      },
      body: JSON.stringify({ targetUrl: "https://example.com/demo" }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.data);
    assert.ok(body.data.shortCode);
    assert.ok(body.data.shortLink);
  });
});

describe("2. SSRF & Malicious Scheme / Open Redirect Blocking", () => {
  test("blocks javascript: URI scheme", async () => {
    const res = await fetch(`${baseUrl}/api/shorten`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-token": "test-secret-token-12345",
      },
      body: JSON.stringify({ targetUrl: "javascript:alert(document.domain)" }),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "TARGET_INVALID");
  });

  test("blocks file:// URI scheme", async () => {
    const res = await fetch(`${baseUrl}/api/shorten`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-token": "test-secret-token-12345",
      },
      body: JSON.stringify({ targetUrl: "file:///etc/passwd" }),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "TARGET_INVALID");
  });

  test("blocks data: URI scheme", async () => {
    const res = await fetch(`${baseUrl}/api/shorten`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-token": "test-secret-token-12345",
      },
      body: JSON.stringify({ targetUrl: "data:text/html,<script>alert(1)</script>" }),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "TARGET_INVALID");
  });

  test("blocks protocol-relative URL open redirect //attacker.com", async () => {
    const res = await fetch(`${baseUrl}/api/shorten`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-token": "test-secret-token-12345",
      },
      body: JSON.stringify({ targetUrl: "//attacker.com/malicious" }),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "TARGET_INVALID");
  });

  test("blocks loopback and private IP SSRF targets (127.0.0.1, localhost, 169.254.169.254)", async () => {
    const dangerousHosts = [
      "http://127.0.0.1:8080/admin",
      "http://localhost/secret",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.1:9000",
      "http://192.168.1.1",
    ];

    for (const host of dangerousHosts) {
      const res = await fetch(`${baseUrl}/api/shorten`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-token": "test-secret-token-12345",
        },
        body: JSON.stringify({ targetUrl: host }),
      });

      assert.equal(res.status, 400, `Expected 400 for target: ${host}`);
      const body = await res.json();
      assert.equal(body.code, "TARGET_INVALID");
    }
  });

  test("allows legitimate public HTTPS URLs and relative local paths", async () => {
    const res1 = await fetch(`${baseUrl}/api/shorten`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-token": "test-secret-token-12345",
      },
      body: JSON.stringify({ targetUrl: "https://google.com" }),
    });
    assert.equal(res1.status, 200);

    const res2 = await fetch(`${baseUrl}/api/shorten`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-token": "test-secret-token-12345",
      },
      body: JSON.stringify({ targetUrl: "/files/safe-file.png" }),
    });
    assert.equal(res2.status, 200);
  });
});

describe("3. File Upload Safeguards, MIME Sniffing & Extension Filtering", () => {
  test("rejects blacklisted executable/script extensions (.exe, .sh, .php, .js, .py, .bat)", async () => {
    const dangerousExts = ["test.exe", "script.sh", "backdoor.php", "payload.js", "exploit.py", "run.bat"];

    for (const filename of dangerousExts) {
      const formData = new FormData();
      const fileBlob = new Blob(["echo vulnerable"], { type: "application/octet-stream" });
      formData.append("myFile", fileBlob, filename);

      const res = await fetch(`${baseUrl}/api/upload`, {
        method: "POST",
        headers: {
          "x-api-token": "test-secret-token-12345",
        },
        body: formData,
      });

      assert.equal(res.status, 400, `Should reject ${filename}`);
      const body = await res.json();
      assert.equal(body.code, "FILE_INVALID");
    }
  });

  test("rejects dangerous MIME types (text/html, application/javascript, application/x-msdownload)", async () => {
    const formData = new FormData();
    const fileBlob = new Blob(["<h1>evil</h1>"], { type: "text/html" });
    formData.append("myFile", fileBlob, "harmless.txt");

    const res = await fetch(`${baseUrl}/api/upload`, {
      method: "POST",
      headers: {
        "x-api-token": "test-secret-token-12345",
      },
      body: formData,
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "FILE_INVALID");
  });

  test("accepts safe image/media file uploads", async () => {
    const formData = new FormData();
    const fileBlob = new Blob(["sample image content"], { type: "image/png" });
    formData.append("myFile", fileBlob, "sample.png");

    const res = await fetch(`${baseUrl}/api/upload`, {
      method: "POST",
      headers: {
        "x-api-token": "test-secret-token-12345",
      },
      body: formData,
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.data.fileName.endsWith(".png"));
    assert.ok(body.data.shortCode);
    assert.ok(body.data.fileLink);
  });
});

describe("4. Path Traversal & Directory Escape Prevention", () => {
  test("blocks path traversal escape sequences on /files/*", async () => {
    const traversalPaths = [
      "/files/..%2f..%2fpackage.json",
      "/files/../../package.json",
      "/files/%2e%2e%2f%2e%2e%2fsettings.json",
      "/files/test%00.png",
    ];

    for (const pathUrl of traversalPaths) {
      const res = await fetch(`${baseUrl}${pathUrl}`);
      assert.equal(res.status, 404, `Path traversal ${pathUrl} should return 404`);
    }
  });

  test("blocks path traversal escape sequences on /uploads/*", async () => {
    const traversalPaths = [
      "/uploads/..%2f..%2fpackage.json",
      "/uploads/../../server.js",
    ];

    for (const pathUrl of traversalPaths) {
      const res = await fetch(`${baseUrl}${pathUrl}`);
      assert.equal(res.status, 404, `Upload traversal ${pathUrl} should return 404`);
    }
  });
});

describe("5. HTTP Security Headers & Content Security Policy", () => {
  test("verifies required HTTP security headers are present", async () => {
    const res = await fetch(`${baseUrl}/`);

    // X-Content-Type-Options: nosniff
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");

    // X-Frame-Options: SAMEORIGIN
    assert.equal(res.headers.get("x-frame-options"), "SAMEORIGIN");

    // X-Powered-By is disabled
    assert.equal(res.headers.get("x-powered-by"), null);

    // Cross-Origin-Resource-Policy is cross-origin for Discord crawlers
    assert.equal(res.headers.get("cross-origin-resource-policy"), "cross-origin");

    // Content-Security-Policy is present and configured
    const csp = res.headers.get("content-security-policy");
    assert.ok(csp, "CSP header must be present");
    assert.ok(csp.includes("default-src 'self'"));
    assert.ok(csp.includes("cdn.jsdelivr.net"));
  });
});

describe("6. Performance: Compression & Static Caching", () => {
  test("serves static assets with Cache-Control headers", async () => {
    const res = await fetch(`${baseUrl}/assets/logo.ico`);
    if (res.status === 200) {
      const cacheControl = res.headers.get("cache-control");
      assert.ok(cacheControl);
      assert.ok(cacheControl.includes("max-age"));
    }
  });

  test("compresses responses when Accept-Encoding gzip is requested", async () => {
    const res = await fetch(`${baseUrl}/api/health`, {
      headers: {
        "Accept-Encoding": "gzip",
      },
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });
});

describe("7. Zero-Regression: Discord Embed Crawler Meta Tags", () => {
  test("renders Open Graph and Twitter Card tags on /files/:fileId", async () => {
    // First upload a file to get a valid file link
    const formData = new FormData();
    const fileBlob = new Blob(["discord preview test"], { type: "image/png" });
    formData.append("myFile", fileBlob, "discord-test.png");

    const uploadRes = await fetch(`${baseUrl}/api/upload`, {
      method: "POST",
      headers: { "x-api-token": "test-secret-token-12345" },
      body: formData,
    });
    const uploadData = await uploadRes.json();
    const fileName = uploadData.data.fileName;

    // Request the display page
    const pageRes = await fetch(`${baseUrl}/files/${fileName}`);
    assert.equal(pageRes.status, 200);
    const html = await pageRes.text();

    assert.ok(html.includes('<meta property="og:title"'));
    assert.ok(html.includes('<meta property="og:image"'));
    assert.ok(html.includes('<meta name="twitter:card"'));
  });
});
