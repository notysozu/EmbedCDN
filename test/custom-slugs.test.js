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
process.env.API_TOKEN = "test-custom-slug-token-777";
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

describe("🏷️ Custom Slug & Collision Edge Cases Test Matrix", () => {
  test("Auto-generated slugs: generates 6-character clean slug when custom slug is omitted", async () => {
    const res = await fetch(`${baseUrl}/api/shorten`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-token": "test-custom-slug-token-777",
      },
      body: JSON.stringify({ targetUrl: "https://example.com/auto-slug-test" }),
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.data.shortCode);
    assert.equal(body.data.shortCode.length, 6);
    assert.match(body.data.shortCode, /^[23456789abcdefghjkmnpqrstuvwxyz]{6}$/);
  });

  test("Valid custom slugs: accepts 3-40 character alphanumeric with hyphens", async () => {
    const validSlugs = ["min", "valid-slug-123", "a-b-c-99", "a".repeat(40)];

    for (const slug of validSlugs) {
      const res = await fetch(`${baseUrl}/api/shorten`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-token": "test-custom-slug-token-777",
        },
        body: JSON.stringify({
          targetUrl: `https://example.com/slug-${slug}`,
          customSlug: slug,
        }),
      });

      assert.equal(res.status, 200, `Failed for valid slug: ${slug}`);
      const body = await res.json();
      assert.equal(body.data.shortCode, slug);
    }
  });

  test("Reserved slugs: rejects reserved route names on /api/shorten with 400 SLUG_INVALID", async () => {
    const reservedSlugs = [
      "api",
      "assets",
      "dashboard",
      "files",
      "health",
      "login",
      "logout",
      "new",
      "settings",
      "subscribe",
      "upload",
      "uploads",
    ];

    for (const slug of reservedSlugs) {
      const res = await fetch(`${baseUrl}/api/shorten`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-token": "test-custom-slug-token-777",
        },
        body: JSON.stringify({
          targetUrl: "https://example.com",
          customSlug: slug,
        }),
      });

      assert.equal(res.status, 400, `Expected 400 for reserved slug: ${slug}`);
      const body = await res.json();
      assert.equal(body.code, "SLUG_INVALID");
      assert.equal(body.ERROR, "That short link is reserved.");
    }
  });

  test("Reserved slugs: rejects reserved route names on /api/upload with 400 SLUG_INVALID", async () => {
    const formData = new FormData();
    const fileBlob = new Blob(["reserved test"], { type: "image/png" });
    formData.append("myFile", fileBlob, "reserved.png");
    formData.append("customSlug", "upload");

    const res = await fetch(`${baseUrl}/api/upload`, {
      method: "POST",
      headers: { "x-api-token": "test-custom-slug-token-777" },
      body: formData,
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "SLUG_INVALID");
    assert.equal(body.ERROR, "That short link is reserved.");
  });

  test("Reserved slugs: rejects reserved route names on /upload UI with 400 and uploadError", async () => {
    const formData = new FormData();
    const fileBlob = new Blob(["reserved test ui"], { type: "image/png" });
    formData.append("myFile", fileBlob, "reserved-ui.png");
    formData.append("customSlug", "dashboard");

    const res = await fetch(`${baseUrl}/upload`, {
      method: "POST",
      body: formData,
    });

    assert.equal(res.status, 400);
    const html = await res.text();
    assert.ok(html.includes("That short link is reserved."));
  });

  test("Malformed characters: rejects uppercase, spaces, and special characters with 400 SLUG_INVALID", async () => {
    const malformedSlugs = [
      "UpperCaseSlug",
      "slug with spaces",
      "slug_with_underscores",
      "slug$special",
      "slug!bang",
      "slug@at",
      "slug#hash",
      "slug/slash",
      "slug%20encoded",
    ];

    for (const slug of malformedSlugs) {
      const res = await fetch(`${baseUrl}/api/shorten`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-token": "test-custom-slug-token-777",
        },
        body: JSON.stringify({
          targetUrl: "https://example.com",
          customSlug: slug,
        }),
      });

      assert.equal(res.status, 400, `Expected rejection for malformed slug: ${slug}`);
      const body = await res.json();
      assert.equal(body.code, "SLUG_INVALID");
      assert.ok(body.ERROR.includes("lowercase letters, numbers, and hyphens"));
    }
  });

  test("Length violations: rejects slugs shorter than 3 or longer than 40 chars", async () => {
    const shortSlugs = ["a", "ab", "1", "12"];
    for (const slug of shortSlugs) {
      const res = await fetch(`${baseUrl}/api/shorten`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-token": "test-custom-slug-token-777",
        },
        body: JSON.stringify({ targetUrl: "https://example.com", customSlug: slug }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.code, "SLUG_INVALID");
      assert.ok(body.ERROR.includes("3-40 characters"));
    }

    // Slugs > 40 chars
    const longSlug = "a".repeat(41);
    const resLong = await fetch(`${baseUrl}/api/shorten`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-token": "test-custom-slug-token-777",
      },
      body: JSON.stringify({ targetUrl: "https://example.com", customSlug: longSlug }),
    });
    assert.equal(resLong.status, 400);
    const longBody = await resLong.json();
    assert.equal(longBody.code, "SLUG_INVALID");
  });

  test("Hyphen boundary rules: rejects slugs starting or ending with a hyphen", async () => {
    const invalidHyphens = ["-leading-hyphen", "trailing-hyphen-", "-both-"];

    for (const slug of invalidHyphens) {
      const res = await fetch(`${baseUrl}/api/shorten`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-token": "test-custom-slug-token-777",
        },
        body: JSON.stringify({ targetUrl: "https://example.com", customSlug: slug }),
      });

      assert.equal(res.status, 400, `Expected rejection for: ${slug}`);
      const body = await res.json();
      assert.equal(body.code, "SLUG_INVALID");
    }
  });

  test("Duplicate slug collisions (409 Conflict): rejects re-use of registered slug across APIs and UI", async () => {
    const slug = "unique-collision-target";

    // 1. Initial creation
    const res1 = await fetch(`${baseUrl}/api/shorten`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-token": "test-custom-slug-token-777",
      },
      body: JSON.stringify({ targetUrl: "https://example.com/pass", customSlug: slug }),
    });
    assert.equal(res1.status, 200);

    // 2. Duplicate on /api/shorten -> 409 Conflict
    const res2 = await fetch(`${baseUrl}/api/shorten`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-token": "test-custom-slug-token-777",
      },
      body: JSON.stringify({ targetUrl: "https://example.com/pass2", customSlug: slug }),
    });
    assert.equal(res2.status, 409);
    const body2 = await res2.json();
    assert.equal(body2.code, "SLUG_TAKEN");
    assert.equal(body2.ERROR, "That short link is already taken.");

    // 3. Duplicate on /api/upload -> 409 Conflict
    const formDataApi = new FormData();
    const fileBlobApi = new Blob(["dup upload"], { type: "image/png" });
    formDataApi.append("myFile", fileBlobApi, "dup.png");
    formDataApi.append("customSlug", slug);

    const res3 = await fetch(`${baseUrl}/api/upload`, {
      method: "POST",
      headers: { "x-api-token": "test-custom-slug-token-777" },
      body: formDataApi,
    });
    assert.equal(res3.status, 409);
    const body3 = await res3.json();
    assert.equal(body3.code, "SLUG_TAKEN");

    // 4. Duplicate on /upload (UI) -> 409 Status
    const formDataUi = new FormData();
    const fileBlobUi = new Blob(["dup upload ui"], { type: "image/png" });
    formDataUi.append("myFile", fileBlobUi, "dup-ui.png");
    formDataUi.append("customSlug", slug);

    const res4 = await fetch(`${baseUrl}/upload`, {
      method: "POST",
      body: formDataUi,
    });
    assert.equal(res4.status, 409);
    const html4 = await res4.text();
    assert.ok(html4.includes("That short link is already taken."));
  });
});
