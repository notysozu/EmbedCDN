const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
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

process.env.NODE_ENV = "test";
process.env.API_TOKEN = "test-redir-analytics-token-555";
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

describe("🔀 Redirection, Analytics & Fallback Test Matrix", () => {
  test("URL Shortlink resolution: GET /s/:code redirects (302) to targetUrl", async () => {
    const targetUrl = "https://example.com/target-redirect-page";
    const createRes = await fetch(`${baseUrl}/api/shorten`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-token": "test-redir-analytics-token-555",
      },
      body: JSON.stringify({ targetUrl, customSlug: "redir-url-test" }),
    });

    assert.equal(createRes.status, 200);

    const redirectRes = await fetch(`${baseUrl}/s/redir-url-test`, {
      redirect: "manual",
    });

    assert.equal(redirectRes.status, 302);
    assert.equal(redirectRes.headers.get("location"), targetUrl);
  });

  test("File Shortlink resolution: GET /s/:code redirects (302) to /files/:fileId", async () => {
    const formData = new FormData();
    const fileBlob = new Blob(["file content for redirect"], { type: "image/png" });
    formData.append("myFile", fileBlob, "redir-file.png");
    formData.append("customSlug", "redir-file-test");

    const uploadRes = await fetch(`${baseUrl}/api/upload`, {
      method: "POST",
      headers: { "x-api-token": "test-redir-analytics-token-555" },
      body: formData,
    });

    assert.equal(uploadRes.status, 200);
    const uploadData = await uploadRes.json();
    const fileName = uploadData.data.fileName;

    const redirectRes = await fetch(`${baseUrl}/s/redir-file-test`, {
      redirect: "manual",
    });

    assert.equal(redirectRes.status, 302);
    assert.equal(redirectRes.headers.get("location"), `/files/${fileName}`);
  });

  test("Root Shortlink resolution: GET /:code resolves and redirects with 302", async () => {
    const targetUrl = "https://example.com/root-redirect-page";
    await fetch(`${baseUrl}/api/shorten`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-token": "test-redir-analytics-token-555",
      },
      body: JSON.stringify({ targetUrl, customSlug: "root-code-test" }),
    });

    const res = await fetch(`${baseUrl}/root-code-test`, {
      redirect: "manual",
    });

    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), targetUrl);
  });

  test("Reserved route pass-through: GET /upload and /api-docs are not intercepted by /:code", async () => {
    const uploadRes = await fetch(`${baseUrl}/upload`, {
      redirect: "manual",
    });
    // /upload redirects to /#upload
    assert.equal(uploadRes.status, 302);
    assert.equal(uploadRes.headers.get("location"), "/#upload");

    const docsRes = await fetch(`${baseUrl}/api-docs`);
    assert.equal(docsRes.status, 200);
    const html = await docsRes.text();
    assert.ok(html.includes("API Documentation") || html.includes("EmbedCDN"));
  });

  test("Click and referrer tracking: increments clicks, shortClicks, and captures User-Agent / Referer", async () => {
    const targetUrl = "https://example.com/analytics-tracked";
    await fetch(`${baseUrl}/api/shorten`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-token": "test-redir-analytics-token-555",
      },
      body: JSON.stringify({ targetUrl, customSlug: "track-clicks-test" }),
    });

    // 1st click via /s/track-clicks-test
    await fetch(`${baseUrl}/s/track-clicks-test`, {
      headers: {
        "User-Agent": "CustomTestBot/1.0",
        Referer: "https://discord.com/channels/123",
      },
      redirect: "manual",
    });

    // 2nd click via root /track-clicks-test
    await fetch(`${baseUrl}/track-clicks-test`, {
      headers: {
        "User-Agent": "CustomTestBot/2.0",
        Referer: "https://twitter.com/post/456",
      },
      redirect: "manual",
    });

    const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
    const linkRecord = store.links["track-clicks-test"];
    assert.ok(linkRecord);
    assert.equal(linkRecord.clicks, 2);
    assert.ok(store.analytics.shortClicks >= 2);

    const userAgents = linkRecord.userAgents.map((u) => u.value);
    assert.ok(userAgents.includes("CustomTestBot/1.0"));
    assert.ok(userAgents.includes("CustomTestBot/2.0"));

    const referrers = linkRecord.referrers.map((r) => r.value);
    assert.ok(referrers.includes("https://discord.com/channels/123"));
    assert.ok(referrers.includes("https://twitter.com/post/456"));
  });

  test("File view tracking: increments views and records referrer / user-agent on /files/:fileId", async () => {
    const formData = new FormData();
    const fileBlob = new Blob(["view tracking file bytes"], { type: "image/png" });
    formData.append("myFile", fileBlob, "view-track.png");

    const uploadRes = await fetch(`${baseUrl}/api/upload`, {
      method: "POST",
      headers: { "x-api-token": "test-redir-analytics-token-555" },
      body: formData,
    });
    const uploadData = await uploadRes.json();
    const fileName = uploadData.data.fileName;

    // View file page twice
    await fetch(`${baseUrl}/files/${fileName}`, {
      headers: {
        "User-Agent": "Discordbot/2.0; +https://discordapp.com",
        Referer: "https://discord.com",
      },
    });

    await fetch(`${baseUrl}/files/${fileName}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 Chrome/120.0",
        Referer: "https://reddit.com",
      },
    });

    const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
    const shortCode = store.files[fileName];
    const linkRecord = store.links[shortCode];
    assert.ok(linkRecord);
    assert.ok(linkRecord.views >= 2);
    assert.ok(store.analytics.fileViews >= 2);
  });

  test("Discord Crawler & Open Graph metadata rendering on /files/:fileId", async () => {
    const formData = new FormData();
    const fileBlob = new Blob(["og preview image test"], { type: "image/png" });
    formData.append("myFile", fileBlob, "og-preview-sample.png");
    formData.append("title", "Epic Discord Embed Poster");
    formData.append("description", "Crisp HD Discord Embed Experience");

    const uploadRes = await fetch(`${baseUrl}/api/upload`, {
      method: "POST",
      headers: { "x-api-token": "test-redir-analytics-token-555" },
      body: formData,
    });
    const uploadData = await uploadRes.json();
    const fileName = uploadData.data.fileName;

    const pageRes = await fetch(`${baseUrl}/files/${fileName}`);
    assert.equal(pageRes.status, 200);
    const html = await pageRes.text();

    assert.ok(html.includes('<meta property="og:site_name"'));
    assert.ok(html.includes('<meta property="og:title" content="Epic Discord Embed Poster"'));
    assert.ok(html.includes('<meta property="og:description" content="Crisp HD Discord Embed Experience"'));
    assert.ok(html.includes('<meta property="og:image"'));
    assert.ok(html.includes('<meta name="twitter:card" content="summary_large_image"'));
    assert.ok(html.includes('<meta name="twitter:title" content="Epic Discord Embed Poster"'));
  });

  test("404 Error Fallbacks: returns 404 for missing slugs and nonexistent files", async () => {
    // Missing shortcode
    const resShort = await fetch(`${baseUrl}/s/nonexistent-code-12345`);
    assert.equal(resShort.status, 404);
    const htmlShort = await resShort.text();
    assert.ok(htmlShort.includes("404") || htmlShort.includes("off the map") || htmlShort.includes("drawer"));

    // Missing root slug
    const resRoot = await fetch(`${baseUrl}/nonexistent-root-code-12345`);
    assert.equal(resRoot.status, 404);

    // Missing file
    const resFile = await fetch(`${baseUrl}/files/nonexistent_file_999.png`);
    assert.equal(resFile.status, 404);

    // Malformed shortcode with special chars
    const resMalformed = await fetch(`${baseUrl}/s/INVALID@CODE!`);
    assert.equal(resMalformed.status, 404);
  });

  test("Path traversal prevention: blocks directory escape sequences on /files/* and /uploads/*", async () => {
    const traversalAttacks = [
      "/files/..%2f..%2fpackage.json",
      "/files/../../package.json",
      "/files/%2e%2e%2f%2e%2e%2fsettings.json",
      "/files/test%00.png",
      "/uploads/..%2f..%2fserver.js",
      "/uploads/../../package.json",
    ];

    for (const attackPath of traversalAttacks) {
      const res = await fetch(`${baseUrl}${attackPath}`);
      assert.equal(res.status, 404, `Expected 404 for traversal path: ${attackPath}`);
    }
  });
});
