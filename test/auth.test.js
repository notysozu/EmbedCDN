const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const { startTestServer, stopTestServer, createIsolatedStore, snapshotUploadsDir, cleanupUploads } = require("./helpers/test-utils.js");

const { storePath, cleanupStore } = createIsolatedStore();

process.env.NODE_ENV = "test";
process.env.API_TOKEN = "test-auth-token-secret-999";
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

describe("🔑 Authentication & Authorization Test Matrix", () => {
  test("Missing token: rejects POST /api/shorten with 401 Unauthorized", async () => {
    const res = await fetch(`${baseUrl}/api/shorten`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetUrl: "https://example.com/demo" }),
    });

    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, "Unauthorized");
  });

  test("Missing token: rejects POST /api/upload with 401 Unauthorized", async () => {
    const formData = new FormData();
    const fileBlob = new Blob(["sample content"], { type: "image/png" });
    formData.append("myFile", fileBlob, "auth-test.png");

    const res = await fetch(`${baseUrl}/api/upload`, {
      method: "POST",
      body: formData,
    });

    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, "Unauthorized");
  });

  test("Invalid token: rejects request with wrong token value", async () => {
    const res = await fetch(`${baseUrl}/api/shorten`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-token": "wrong-secret-token-value",
      },
      body: JSON.stringify({ targetUrl: "https://example.com/demo" }),
    });

    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, "Unauthorized");
  });

  test("Invalid token: rejects request with token of different length", async () => {
    const res = await fetch(`${baseUrl}/api/shorten`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-token": "short",
      },
      body: JSON.stringify({ targetUrl: "https://example.com/demo" }),
    });

    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, "Unauthorized");
  });

  test("Valid token: accepts POST /api/shorten with 200 OK", async () => {
    const res = await fetch(`${baseUrl}/api/shorten`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-token": "test-auth-token-secret-999",
      },
      body: JSON.stringify({ targetUrl: "https://example.com/demo-auth-pass" }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.data);
    assert.ok(body.data.shortCode);
    assert.ok(body.data.shortLink);
  });

  test("Valid token: accepts POST /api/upload with 200 OK", async () => {
    const formData = new FormData();
    const fileBlob = new Blob(["auth valid image payload"], { type: "image/png" });
    formData.append("myFile", fileBlob, "auth-valid.png");

    const res = await fetch(`${baseUrl}/api/upload`, {
      method: "POST",
      headers: {
        "x-api-token": "test-auth-token-secret-999",
      },
      body: formData,
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.data);
    assert.ok(body.data.fileName);
    assert.ok(body.data.fileLink);
  });

  test("Unconfigured token: returns 503 Service Unavailable when API token is not configured", () => {
    // Run an isolated child process where API_TOKEN is explicitly empty
    const code = `
      process.env.NODE_ENV = 'test';
      process.env.API_TOKEN = '';
      process.env.APP_PORT = '0';
      const app = require('./server.js');
      const http = require('http');
      const server = http.createServer(app);
      server.listen(0, '127.0.0.1', async () => {
        const port = server.address().port;
        try {
          const res = await fetch('http://127.0.0.1:' + port + '/api/shorten', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-token': 'any-token' },
            body: JSON.stringify({ targetUrl: 'https://example.com' })
          });
          const body = await res.json();
          if (res.status === 503 && body.error === 'API token is not configured') {
            process.exit(0);
          } else {
            console.error('Unexpected status:', res.status, body);
            process.exit(1);
          }
        } catch (err) {
          console.error(err);
          process.exit(1);
        }
      });
    `;

    const result = spawnSync("node", ["-e", code], {
      cwd: path.resolve(__dirname, ".."),
      env: { ...process.env, API_TOKEN: "" },
      encoding: "utf8",
    });

    assert.equal(
      result.status,
      0,
      `Child process exited with non-zero: ${result.stderr || result.stdout}`
    );
  });

  test("Public endpoints: /api/health does not require authentication", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });

  test("Public endpoints: /api-docs and / do not require authentication", async () => {
    const resHome = await fetch(`${baseUrl}/`);
    assert.equal(resHome.status, 200);

    const resDocs = await fetch(`${baseUrl}/api-docs`);
    assert.equal(resDocs.status, 200);
  });
});
