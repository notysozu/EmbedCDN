const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

describe("☁️ Dual Storage Parity (@vercel/blob) & Discord Webhook Mocks", () => {
  test("@vercel/blob Storage Parity: upload, shortlink persistence, and redirection via Blob mock", () => {
    // Run an isolated process with BLOB_READ_WRITE_TOKEN set and mocked @vercel/blob
    const script = `
      const assert = require('node:assert/strict');
      const http = require('node:http');

      // Mock in-memory blob storage
      const blobStore = new Map();

      // Pre-seed @vercel/blob in require cache
      const vercelBlob = {
        put: async (blobPath, data, options) => {
          const url = 'https://blob.vercel-storage.com/' + blobPath;
          blobStore.set(blobPath, { data: typeof data === 'string' ? data : data.toString(), url });
          return { url, pathname: blobPath };
        },
        get: async (blobPath, options) => {
          const item = blobStore.get(blobPath);
          if (!item) return null;
          return {
            blob: { url: item.url },
            stream: {
              getReader: () => {
                let sent = false;
                return {
                  read: async () => {
                    if (sent) return { done: true, value: undefined };
                    sent = true;
                    return { done: false, value: Buffer.from(item.data) };
                  }
                };
              }
            }
          };
        }
      };

      const resolvedBlob = require.resolve('@vercel/blob');
      require.cache[resolvedBlob] = {
        id: resolvedBlob,
        filename: resolvedBlob,
        loaded: true,
        exports: vercelBlob
      };

      process.env.NODE_ENV = 'test';
      process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_mock_token';
      process.env.API_TOKEN = 'blob-test-token-888';
      process.env.APP_PORT = '0';
      process.env.RATE_LIMIT_MAX_UPLOADS = '1000';
      process.env.RATE_LIMIT_MAX_API = '1000';
      process.env.RATE_LIMIT_MAX_PUBLIC = '1000';
      process.env.TRUST_PROXY = '1';

      const app = require('./server.js');
      const server = http.createServer(app);

      server.listen(0, '127.0.0.1', async () => {
        const port = server.address().port;
        const baseUrl = 'http://127.0.0.1:' + port;

        try {
          // 1. Upload a file to verify blob.put is invoked
          const formData = new FormData();
          const fileBlob = new Blob(['cloud blob content'], { type: 'image/png' });
          formData.append('myFile', fileBlob, 'cloud-photo.png');
          formData.append('customSlug', 'blob-test-slug');

          const uploadRes = await fetch(baseUrl + '/api/upload', {
            method: 'POST',
            headers: { 'x-api-token': 'blob-test-token-888' },
            body: formData
          });

          assert.equal(uploadRes.status, 200);
          const uploadBody = await uploadRes.json();
          assert.equal(uploadBody.data.shortCode, 'blob-test-slug');
          assert.ok(uploadBody.data.uploadLink.includes('blob.vercel-storage.com/uploads/'));

          const storedFileName = uploadBody.data.fileName;

          // Verify blobStore received the upload
          assert.ok(blobStore.has('uploads/' + storedFileName));

          // 2. Access /uploads/:storedFileName and verify 302 redirect to Blob URL
          const uploadRedirectRes = await fetch(baseUrl + '/uploads/' + storedFileName, {
            redirect: 'manual'
          });
          assert.equal(uploadRedirectRes.status, 302);
          assert.ok(uploadRedirectRes.headers.get('location').includes('blob.vercel-storage.com/uploads/'));

          // 3. Access /files/:storedFileName and verify 200 render with Blob direct image link
          const filePageRes = await fetch(baseUrl + '/files/' + storedFileName);
          assert.equal(filePageRes.status, 200);
          const pageHtml = await filePageRes.text();
          assert.ok(pageHtml.includes('blob.vercel-storage.com/uploads/'));

          // 4. Shortlink redirect via /s/blob-test-slug
          const shortRes = await fetch(baseUrl + '/s/blob-test-slug', {
            redirect: 'manual'
          });
          assert.equal(shortRes.status, 302);

          server.close(() => process.exit(0));
        } catch (err) {
          console.error(err);
          server.close(() => process.exit(1));
        }
      });
    `;

    const result = spawnSync("node", ["-e", script], {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
    });

    assert.equal(
      result.status,
      0,
      `Blob storage parity test failed: ${result.stderr || result.stdout}`
    );
  });

  test("Discord Webhook Mock: dispatches payloads on index, subscribe, upload, and tolerates webhook failures", async () => {
    const script = `
      const assert = require('node:assert/strict');
      const http = require('node:http');

      const capturedWebhooks = [];

      // Intercept axios.post
      const axios = require('axios');
      const originalPost = axios.post;
      axios.post = async (url, payload, options) => {
        capturedWebhooks.push({ url, payload });
        return { status: 204, data: {} };
      };

      process.env.NODE_ENV = 'test';
      process.env.API_TOKEN = 'webhook-test-token';
      process.env.WEBHOOK_URL = 'https://discord.com/api/webhooks/123456789/mock-webhook-token';
      process.env.APP_PORT = '0';
      process.env.RATE_LIMIT_MAX_UPLOADS = '1000';
      process.env.RATE_LIMIT_MAX_SUBSCRIBE = '1000';
      process.env.RATE_LIMIT_MAX_API = '1000';
      process.env.RATE_LIMIT_MAX_PUBLIC = '1000';
      process.env.TRUST_PROXY = '1';

      const app = require('./server.js');
      const server = http.createServer(app);

      server.listen(0, '127.0.0.1', async () => {
        const port = server.address().port;
        const baseUrl = 'http://127.0.0.1:' + port;

        try {
          // 1. Visit index -> triggers "User Connected" webhook
          const res1 = await fetch(baseUrl + '/');
          assert.equal(res1.status, 200);

          // 2. Subscribe -> triggers "Email Received" webhook
          const form = new URLSearchParams();
          form.append('email', 'webhook_test@example.com');
          const res2 = await fetch(baseUrl + '/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: form.toString(),
            redirect: 'manual'
          });
          assert.equal(res2.status, 302);

          // 3. UI Upload -> triggers "User Uploaded a file" webhook
          const uploadForm = new FormData();
          const fileBlob = new Blob(['sample data'], { type: 'image/png' });
          uploadForm.append('myFile', fileBlob, 'webhook_upload.png');
          const res3 = await fetch(baseUrl + '/upload', {
            method: 'POST',
            body: uploadForm
          });
          assert.equal(res3.status, 200);

          // Wait 100ms for async webhook promises
          await new Promise(r => setTimeout(r, 100));

          assert.ok(capturedWebhooks.length >= 3, 'Expected at least 3 webhooks, got ' + capturedWebhooks.length);
          const titles = capturedWebhooks.map(w => w.payload && w.payload.embeds && w.payload.embeds[0] && w.payload.embeds[0].title);
          assert.ok(titles.some(t => t && t.includes('User Connected')), 'Missing User Connected embed');
          assert.ok(titles.some(t => t && t.includes('Email Received')), 'Missing Email Received embed');
          assert.ok(titles.some(t => t && t.includes('User Uploaded a file')), 'Missing User Uploaded embed');

          server.close(() => process.exit(0));
        } catch (err) {
          console.error(err);
          server.close(() => process.exit(1));
        }
      });
    `;

    const result = spawnSync("node", ["-e", script], {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
    });

    assert.equal(result.status, 0, `Webhook test failed: ${result.stderr || result.stdout}`);
  });

  test("Discord Webhook Fault Tolerance: application stays fully operational when webhook target is dead or returns 500", async () => {
    // Start a webhook server that immediately returns 500
    const deadWebhookServer = http.createServer((req, res) => {
      res.writeHead(500);
      res.end("Internal Webhook Server Error");
    });

    await new Promise((resolve) => deadWebhookServer.listen(0, "127.0.0.1", resolve));
    const deadPort = deadWebhookServer.address().port;
    const deadWebhookUrl = `http://127.0.0.1:${deadPort}/broken-webhook`;

    const script = `
      const assert = require('node:assert/strict');
      const http = require('node:http');

      process.env.NODE_ENV = 'test';
      process.env.API_TOKEN = 'webhook-fault-token';
      process.env.WEBHOOK_URL = '${deadWebhookUrl}';
      process.env.APP_PORT = '0';
      process.env.RATE_LIMIT_MAX_UPLOADS = '1000';
      process.env.RATE_LIMIT_MAX_SUBSCRIBE = '1000';
      process.env.RATE_LIMIT_MAX_API = '1000';
      process.env.RATE_LIMIT_MAX_PUBLIC = '1000';

      const app = require('./server.js');
      const server = http.createServer(app);

      server.listen(0, '127.0.0.1', async () => {
        const port = server.address().port;
        const baseUrl = 'http://127.0.0.1:' + port;

        try {
          // Should not throw or crash on failing webhook
          const res = await fetch(baseUrl + '/');
          assert.equal(res.status, 200);

          const form = new URLSearchParams();
          form.append('email', 'fault_tolerant@example.com');
          const res2 = await fetch(baseUrl + '/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: form.toString(),
            redirect: 'manual'
          });
          assert.equal(res2.status, 302);

          // Wait 200ms to verify no unhandled rejection crashes the process
          await new Promise(r => setTimeout(r, 200));
          server.close(() => process.exit(0));
        } catch (err) {
          console.error(err);
          server.close(() => process.exit(1));
        }
      });
    `;

    const result = spawnSync("node", ["-e", script], {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
    });

    await new Promise((resolve) => deadWebhookServer.close(resolve));

    assert.equal(result.status, 0, `Fault tolerance test failed: ${result.stderr || result.stdout}`);
  });
});
