const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");

const DEFAULT_SHORT_LINKS_FILE = path.join(__dirname, "..", "..", "data", "short-links.json");
const UPLOADS_DIR = path.join(__dirname, "..", "..", "public", "uploads");

/**
 * Creates an HTTP server on an ephemeral port.
 */
function startTestServer(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const baseUrl = `http://127.0.0.1:${port}`;
      resolve({ server, baseUrl });
    });
  });
}

/**
 * Closes the HTTP server cleanly.
 */
function stopTestServer(server) {
  return new Promise((resolve, reject) => {
    if (!server) return resolve();
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Creates an isolated temp JSON store file and sets process.env.SHORT_LINKS_FILE.
 * Returns { storePath, cleanupStore }.
 */
function createIsolatedStore() {
  const storeId = crypto.randomBytes(8).toString("hex");
  const tempStorePath = path.join(os.tmpdir(), `embedcdn-test-store-${storeId}.json`);

  const initialData = {
    version: 1,
    links: {},
    files: {},
    analytics: {
      uploads: 0,
      shortClicks: 0,
      fileViews: 0,
    },
    updatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(tempStorePath, JSON.stringify(initialData, null, 2), "utf8");
  process.env.SHORT_LINKS_FILE = tempStorePath;

  return {
    storePath: tempStorePath,
    cleanupStore: () => {
      try {
        if (fs.existsSync(tempStorePath)) {
          fs.unlinkSync(tempStorePath);
        }
      } catch {
        // ignore
      }
    },
  };
}

/**
 * Cleans up any files in public/uploads created during test runs.
 */
function cleanupUploads(existingFilesBeforeTest = new Set()) {
  try {
    if (!fs.existsSync(UPLOADS_DIR)) return;
    const currentFiles = fs.readdirSync(UPLOADS_DIR);
    for (const file of currentFiles) {
      if (!existingFilesBeforeTest.has(file) && file !== ".gitkeep") {
        try {
          fs.unlinkSync(path.join(UPLOADS_DIR, file));
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
}

/**
 * Snapshots the existing files in uploads directory before tests run.
 */
function snapshotUploadsDir() {
  try {
    if (!fs.existsSync(UPLOADS_DIR)) return new Set();
    return new Set(fs.readdirSync(UPLOADS_DIR));
  } catch {
    return new Set();
  }
}

module.exports = {
  startTestServer,
  stopTestServer,
  createIsolatedStore,
  cleanupUploads,
  snapshotUploadsDir,
  DEFAULT_SHORT_LINKS_FILE,
  UPLOADS_DIR,
};
