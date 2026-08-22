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
  UPLOADS_DIR,
} = require("./helpers/test-utils.js");

const { storePath, cleanupStore } = createIsolatedStore();

process.env.NODE_ENV = "test";
process.env.API_TOKEN = "test-upload-pipeline-token-123";
process.env.APP_PORT = "0";
process.env.MAX_FILE_SIZE_MB = "1"; // 1 MB limit for tests
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

describe("📦 Upload Pipeline Test Matrix", () => {
  test("Standard media formats: successfully uploads .png, .jpg, .webp, .gif via /api/upload", async () => {
    const formats = [
      { name: "test-image.png", mime: "image/png", data: "fake-png-bytes" },
      { name: "test-photo.jpg", mime: "image/jpeg", data: "fake-jpg-bytes" },
      { name: "test-modern.webp", mime: "image/webp", data: "fake-webp-bytes" },
      { name: "test-anim.gif", mime: "image/gif", data: "fake-gif-bytes" },
    ];

    for (const fmt of formats) {
      const formData = new FormData();
      const fileBlob = new Blob([fmt.data], { type: fmt.mime });
      formData.append("myFile", fileBlob, fmt.name);
      formData.append("title", `Test ${fmt.name}`);
      formData.append("description", `Testing upload of ${fmt.name}`);

      const res = await fetch(`${baseUrl}/api/upload`, {
        method: "POST",
        headers: { "x-api-token": "test-upload-pipeline-token-123" },
        body: formData,
      });

      assert.equal(res.status, 200, `Failed for format ${fmt.name}`);
      const body = await res.json();
      assert.ok(body.data);
      assert.ok(body.data.shortCode);
      assert.ok(body.data.shortLink);
      assert.ok(body.data.fileLink);
      assert.ok(body.data.fileName);
      assert.equal(body.data.title, `Test ${fmt.name}`);
      assert.equal(body.data.description, `Testing upload of ${fmt.name}`);

      // Verify file is persisted locally
      const localFilePath = path.join(UPLOADS_DIR, body.data.fileName);
      assert.ok(fs.existsSync(localFilePath), `File ${body.data.fileName} should exist on disk`);
    }
  });

  test("Video and audio formats: successfully uploads .mp4 and .mp3 via /api/upload", async () => {
    const mediaFiles = [
      { name: "sample-video.mp4", mime: "video/mp4", data: "fake-mp4-data" },
      { name: "sample-audio.mp3", mime: "audio/mpeg", data: "fake-mp3-data" },
    ];

    for (const file of mediaFiles) {
      const formData = new FormData();
      const fileBlob = new Blob([file.data], { type: file.mime });
      formData.append("myFile", fileBlob, file.name);

      const res = await fetch(`${baseUrl}/api/upload`, {
        method: "POST",
        headers: { "x-api-token": "test-upload-pipeline-token-123" },
        body: formData,
      });

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.data.fileName);
      assert.ok(fs.existsSync(path.join(UPLOADS_DIR, body.data.fileName)));
    }
  });

  test("UI form upload: POST /upload renders success.ejs with 200 OK", async () => {
    const formData = new FormData();
    const fileBlob = new Blob(["ui upload content test"], { type: "image/png" });
    formData.append("myFile", fileBlob, "ui-test-photo.png");
    formData.append("title", "UI Custom Title");
    formData.append("description", "UI Custom Description");

    const res = await fetch(`${baseUrl}/upload`, {
      method: "POST",
      body: formData,
    });

    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("UI Custom Title"));
    assert.ok(html.includes("UI Custom Description"));
    assert.ok(html.includes("/files/"));
    assert.ok(html.includes("/s/"));
  });

  test("Missing file: POST /api/upload returns 400 Bad Request with error message", async () => {
    const res = await fetch(`${baseUrl}/api/upload`, {
      method: "POST",
      headers: { "x-api-token": "test-upload-pipeline-token-123" },
      body: new FormData(),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ERROR, "No Files Specified");
  });

  test("Missing file: POST /upload (UI) renders index page with 400 status and uploadError", async () => {
    const res = await fetch(`${baseUrl}/upload`, {
      method: "POST",
      body: new FormData(),
    });

    assert.equal(res.status, 400);
    const html = await res.text();
    assert.ok(html.includes("No file selected"));
  });

  test("Oversized file: POST /api/upload rejects file exceeding MAX_FILE_SIZE_MB", async () => {
    const largeBuffer = Buffer.alloc(1.2 * 1024 * 1024, "x");
    const formData = new FormData();
    const fileBlob = new Blob([largeBuffer], { type: "image/png" });
    formData.append("myFile", fileBlob, "huge-file.png");

    try {
      const res = await fetch(`${baseUrl}/api/upload`, {
        method: "POST",
        headers: { "x-api-token": "test-upload-pipeline-token-123" },
        body: formData,
      });
      assert.ok([200, 400, 413].includes(res.status));
      if (res.status === 200) {
        const body = await res.json();
        assert.fail(`Should not have succeeded with oversized file: ${JSON.stringify(body)}`);
      }
    } catch (err) {
      // EPIPE or ECONNRESET happens when server closes stream early on limits
      assert.ok(err.message.includes("fetch failed") || err.code === "EPIPE" || err.code === "ECONNRESET");
    }
  });

  test("Oversized file: POST /upload (UI) rejects file exceeding size limit", async () => {
    const largeBuffer = Buffer.alloc(1.2 * 1024 * 1024, "y");
    const formData = new FormData();
    const fileBlob = new Blob([largeBuffer], { type: "image/png" });
    formData.append("myFile", fileBlob, "huge-file-ui.png");

    try {
      const res = await fetch(`${baseUrl}/upload`, {
        method: "POST",
        body: formData,
      });
      assert.ok([400, 413].includes(res.status));
    } catch (err) {
      assert.ok(err.message.includes("fetch failed") || err.code === "EPIPE" || err.code === "ECONNRESET");
    }
  });

  test("Disallowed extensions: rejects executable and script file extensions with 400 FILE_INVALID", async () => {
    const disallowedExtensions = [
      "payload.exe",
      "exploit.bat",
      "script.sh",
      "cmd.cmd",
      "powershell.ps1",
      "vbscript.vbs",
      "danger.js",
      "module.mjs",
      "common.cjs",
      "backdoor.php",
      "php4file.php4",
      "python_script.py",
      "archive.jar",
      "installer.msi",
      "library.dll",
      "index.html",
      "page.htm",
      "doc.xhtml",
      "dotnet.asp",
      "dotnetx.aspx",
      "java.jsp",
      "app.apk",
      "executable.bin",
      "flow.workflow",
      "app.app",
      "cgi_bin.cgi",
      "perl_script.pl",
    ];

    for (const filename of disallowedExtensions) {
      const formData = new FormData();
      const fileBlob = new Blob(["malicious payload content"], { type: "application/octet-stream" });
      formData.append("myFile", fileBlob, filename);

      const res = await fetch(`${baseUrl}/api/upload`, {
        method: "POST",
        headers: { "x-api-token": "test-upload-pipeline-token-123" },
        body: formData,
      });

      assert.equal(res.status, 400, `Expected rejection for ${filename}`);
      const body = await res.json();
      assert.equal(body.code, "FILE_INVALID");
      assert.ok(body.ERROR.includes("not permitted"));
    }
  });

  test("Disallowed MIME types: rejects dangerous MIME types with 400 FILE_INVALID", async () => {
    const dangerousMimes = [
      { mime: "text/html", name: "safe_name.txt" },
      { mime: "text/javascript", name: "safe_name.txt" },
      { mime: "application/javascript", name: "safe_name.txt" },
      { mime: "application/x-javascript", name: "safe_name.txt" },
      { mime: "application/x-msdownload", name: "safe_name.txt" },
      { mime: "application/x-executable", name: "safe_name.txt" },
      { mime: "application/x-sh", name: "safe_name.txt" },
      { mime: "application/x-php", name: "safe_name.txt" },
      { mime: "application/x-httpd-php", name: "safe_name.txt" },
      { mime: "application/x-bat", name: "safe_name.txt" },
      { mime: "application/x-csh", name: "safe_name.txt" },
      { mime: "application/x-python", name: "safe_name.txt" },
    ];

    for (const item of dangerousMimes) {
      const formData = new FormData();
      const fileBlob = new Blob(["some content"], { type: item.mime });
      formData.append("myFile", fileBlob, item.name);

      const res = await fetch(`${baseUrl}/api/upload`, {
        method: "POST",
        headers: { "x-api-token": "test-upload-pipeline-token-123" },
        body: formData,
      });

      assert.equal(res.status, 400, `Expected rejection for MIME: ${item.mime}`);
      const body = await res.json();
      assert.equal(body.code, "FILE_INVALID");
    }
  });

  test("Metadata preservation: custom title and description are sanitized and stored", async () => {
    const formData = new FormData();
    const fileBlob = new Blob(["metadata content"], { type: "image/png" });
    formData.append("myFile", fileBlob, "metadata-sample.png");
    formData.append("title", "   Custom  Title   With   Spaces   ");
    formData.append("description", "   Long   Description   With   Extra   Spaces   ");

    const res = await fetch(`${baseUrl}/api/upload`, {
      method: "POST",
      headers: { "x-api-token": "test-upload-pipeline-token-123" },
      body: formData,
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.title, "Custom Title With Spaces");
    assert.equal(body.data.description, "Long Description With Extra Spaces");
  });
});
