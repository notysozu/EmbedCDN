const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

describe("⏱️ Tiered Rate Limiting System Verification", () => {
  test("Tier 1: triggers 429 on /subscribe when max attempts exceeded", () => {
    const script = `
      const assert = require('node:assert/strict');
      const http = require('node:http');

      process.env.NODE_ENV = 'test';
      process.env.API_TOKEN = 'rate-limit-token-xyz';
      process.env.APP_PORT = '0';
      process.env.RATE_LIMIT_MAX_SUBSCRIBE = '2';
      process.env.TRUST_PROXY = '1';

      const app = require('./server.js');
      const server = http.createServer(app);

      server.listen(0, '127.0.0.1', async () => {
        const port = server.address().port;
        const baseUrl = 'http://127.0.0.1:' + port;
        const ip = '198.51.100.1';
        let lastStatus = 200;

        try {
          for (let i = 0; i < 5; i += 1) {
            const formData = new URLSearchParams();
            formData.append('email', 'subscriber' + i + '@test.com');

            const res = await fetch(baseUrl + '/subscribe', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-Forwarded-For': ip,
              },
              body: formData.toString(),
              redirect: 'manual',
            });
            lastStatus = res.status;
          }

          assert.equal(lastStatus, 429);
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

    assert.equal(result.status, 0, result.stderr || result.stdout);
  });

  test("Tier 2: triggers 429 on /api/health when API rate limit exceeded", () => {
    const script = `
      const assert = require('node:assert/strict');
      const http = require('node:http');

      process.env.NODE_ENV = 'test';
      process.env.API_TOKEN = 'rate-limit-token-xyz';
      process.env.APP_PORT = '0';
      process.env.RATE_LIMIT_MAX_API = '3';
      process.env.TRUST_PROXY = '1';

      const app = require('./server.js');
      const server = http.createServer(app);

      server.listen(0, '127.0.0.1', async () => {
        const port = server.address().port;
        const baseUrl = 'http://127.0.0.1:' + port;
        const ip = '198.51.100.2';
        let lastStatus = 200;

        try {
          for (let i = 0; i < 6; i += 1) {
            const res = await fetch(baseUrl + '/api/health', {
              headers: {
                'X-Forwarded-For': ip,
              },
            });
            lastStatus = res.status;
          }

          assert.equal(lastStatus, 429);
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

    assert.equal(result.status, 0, result.stderr || result.stdout);
  });

  test("Tier 3: triggers 429 on public read routes when threshold exceeded", () => {
    const script = `
      const assert = require('node:assert/strict');
      const http = require('node:http');

      process.env.NODE_ENV = 'test';
      process.env.API_TOKEN = 'rate-limit-token-xyz';
      process.env.APP_PORT = '0';
      process.env.RATE_LIMIT_MAX_PUBLIC = '5';
      process.env.TRUST_PROXY = '1';

      const app = require('./server.js');
      const server = http.createServer(app);

      server.listen(0, '127.0.0.1', async () => {
        const port = server.address().port;
        const baseUrl = 'http://127.0.0.1:' + port;
        const ip = '198.51.100.3';
        let lastStatus = 200;

        try {
          for (let i = 0; i < 8; i += 1) {
            const res = await fetch(baseUrl + '/', {
              headers: {
                'X-Forwarded-For': ip,
              },
            });
            lastStatus = res.status;
          }

          assert.equal(lastStatus, 429);
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

    assert.equal(result.status, 0, result.stderr || result.stdout);
  });

  test("Upload Limiter: triggers 429 on /api/upload with JSON response when limit exceeded", () => {
    const script = `
      const assert = require('node:assert/strict');
      const http = require('node:http');

      process.env.NODE_ENV = 'test';
      process.env.API_TOKEN = 'rate-limit-token-xyz';
      process.env.APP_PORT = '0';
      process.env.RATE_LIMIT_MAX_UPLOADS = '3';
      process.env.RATE_LIMIT_MAX_API = '1000';
      process.env.TRUST_PROXY = '1';

      const app = require('./server.js');
      const server = http.createServer(app);

      server.listen(0, '127.0.0.1', async () => {
        const port = server.address().port;
        const baseUrl = 'http://127.0.0.1:' + port;
        const ip = '198.51.100.4';
        let lastStatus = 200;
        let lastBody = null;

        try {
          for (let i = 0; i < 6; i += 1) {
            const formData = new FormData();
            const fileBlob = new Blob(['test'], { type: 'image/png' });
            formData.append('myFile', fileBlob, 'rate-test-' + i + '.png');

            const res = await fetch(baseUrl + '/api/upload', {
              method: 'POST',
              headers: {
                'x-api-token': 'rate-limit-token-xyz',
                'X-Forwarded-For': ip,
              },
              body: formData,
            });
            lastStatus = res.status;
            if (res.status === 429) {
              lastBody = await res.json();
            }
          }

          assert.equal(lastStatus, 429);
          assert.ok(lastBody);
          assert.equal(lastBody.code, 'RATE_LIMITED');
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

    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
});
