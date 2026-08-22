// Load environment variables
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fileUpload = require("express-fileupload");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const helmet = require("helmet");
const compression = require("compression");
const { rateLimit } = require("express-rate-limit");
const axios = require("axios");
const { get, put } = require("@vercel/blob");

const settings = require("./settings.json");

const app = express();

const appName = settings.app.appName || "EmbedCDN";
const appFavicon = settings.app.appFavicon || "/assets/logo.ico";
const appPort = Number(process.env.APP_PORT || settings.app.appPort || 3000);
const configuredAppLink = String(process.env.APP_LINK || settings.app.appLink || "")
  .trim()
  .replace(/\/+$/g, "");
const appBaseUrl = configuredAppLink || `http://localhost:${appPort}`;
const apiToken = process.env.API_TOKEN || settings.api.apiToken || "";
const webhookUrl = process.env.WEBHOOK_URL || settings.app.webhookURL || "";

const discordInvite = settings.social.discord;
const twitterInvite = settings.social.twitter;
const facebookInvite = settings.social.facebook;
const instagramInvite = settings.social.instagram;
const linkedinInvite = settings.social.linkedin;
const githubInvite =
  settings.social.github || "https://github.com/notysozu/EmbedCDN";

const SHORT_LINKS_FILE =
  process.env.SHORT_LINKS_FILE || path.join(__dirname, "data", "short-links.json");
const SHORT_LINKS_BLOB_PATH = "data/short-links.json";
const SHORT_CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const RESERVED_SHORT_SLUGS = new Set([
  "api",
  "assets",
  "dashboard",
  "files",
  "health",
  "login",
  "logout",
  "new",
  "settings",
  "s",
  "subscribe",
  "upload",
  "uploads",
]);

let shortLinksCache = null;
let shortLinksLoaded = false;

const isBlobStorageEnabled = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN);

function generateString(length) {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";

  for (let i = 0; i < length; i += 1) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }

  return result;
}

function generateShortCode(length = 6) {
  let result = "";

  for (let i = 0; i < length; i += 1) {
    result += SHORT_CODE_ALPHABET.charAt(
      Math.floor(Math.random() * SHORT_CODE_ALPHABET.length)
    );
  }

  return result;
}

function sanitizeSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function validateCustomSlug(value) {
  const raw = String(value || "").trim();

  if (!raw) {
    return { slug: "", error: "" };
  }

  const slug = sanitizeSlug(raw);

  if (raw !== slug) {
    return {
      slug,
      error: "Use lowercase letters, numbers, and hyphens only.",
    };
  }

  if (slug.length < 3 || slug.length > 40) {
    return { slug, error: "Custom slugs need to be 3-40 characters." };
  }

  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) {
    return {
      slug,
      error: "Start and end your slug with a letter or number.",
    };
  }

  if (RESERVED_SHORT_SLUGS.has(slug)) {
    return { slug, error: "That short link is reserved." };
  }

  return { slug, error: "" };
}

function getBaseUrl(req) {
  const forwardedHost = req.get("x-forwarded-host");
  const host = forwardedHost || req.get("host");
  const forwardedProto = req.get("x-forwarded-proto");
  const protocol = (forwardedProto || req.protocol || "http").split(",")[0].trim();

  if (host) {
    return `${protocol}://${host}`;
  }

  return configuredAppLink || appBaseUrl;
}

function encodeRoutePart(value) {
  return encodeURIComponent(value).replace(/%2F/g, "/");
}

function getFirstUploadedFile(req) {
  if (!req.files) return null;
  const uploadedFile =
    req.files.myFile ||
    req.files.file ||
    (Object.keys(req.files).length > 0 ? req.files[Object.keys(req.files)[0]] : null);
  return Array.isArray(uploadedFile) ? uploadedFile[0] : uploadedFile;
}

function formatFileSize(size) {
  if (!Number.isFinite(Number(size))) {
    return "Unknown size";
  }

  const bytes = Number(size);

  if (bytes >= 1e9) {
    return `${(bytes / 1e9).toFixed(2)} GB`;
  }

  if (bytes >= 1e6) {
    return `${(bytes / 1e6).toFixed(2)} MB`;
  }

  if (bytes >= 1000) {
    return `${Math.round(bytes / 1000)} KB`;
  }

  return `${bytes} B`;
}

function cleanText(value, maxLength) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
}

const MAX_FILE_SIZE_BYTES =
  Number(process.env.MAX_FILE_SIZE_MB || 25) * 1024 * 1024;

const DISALLOWED_EXTENSIONS = new Set([
  "exe", "bat", "cmd", "sh", "bash", "ps1", "vbs", "js", "mjs", "cjs",
  "php", "phtml", "php3", "php4", "php5", "phps", "pl", "py", "cgi",
  "jar", "msi", "dll", "com", "scr", "html", "htm", "xhtml", "asp", "aspx", "jsp",
  "wsf", "vbe", "jse", "reg", "hta", "cpl", "inf", "ins", "isp", "pif", "svgz",
  "bin", "action", "apk", "app", "gadget", "workflow"
]);

const DISALLOWED_MIME_TYPES = new Set([
  "text/html",
  "text/javascript",
  "application/javascript",
  "application/x-javascript",
  "application/x-msdownload",
  "application/x-executable",
  "application/x-sh",
  "application/x-php",
  "application/x-httpd-php",
  "application/x-bat",
  "application/x-csh",
  "application/x-python"
]);

function isValidFileName(fileName) {
  if (!fileName || typeof fileName !== "string") return false;
  if (
    fileName.includes("..") ||
    fileName.includes("/") ||
    fileName.includes("\\") ||
    fileName.includes("\0")
  ) {
    return false;
  }
  return /^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(fileName);
}

function validateUploadedFile(uploadedFile) {
  if (!uploadedFile) {
    return { valid: false, error: "No file provided." };
  }

  if (uploadedFile.size > MAX_FILE_SIZE_BYTES) {
    const maxMb = Math.round(MAX_FILE_SIZE_BYTES / (1024 * 1024));
    return {
      valid: false,
      error: `File size exceeds the limit of ${maxMb} MB.`,
    };
  }

  const rawExt = path
    .extname(uploadedFile.name || "")
    .slice(1)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();

  if (DISALLOWED_EXTENSIONS.has(rawExt)) {
    return {
      valid: false,
      error: `Files with the extension '.${rawExt}' are not permitted.`,
    };
  }

  const mime = String(uploadedFile.mimetype || "").toLowerCase().trim();
  if (DISALLOWED_MIME_TYPES.has(mime)) {
    return {
      valid: false,
      error: `Files with MIME type '${mime}' are not permitted.`,
    };
  }

  return { valid: true };
}

function buildStoredFileName(originalName) {
  const rawExt = path
    .extname(originalName || "")
    .slice(1)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const extension = rawExt || "bin";
  return `${generateString(20)}.${extension}`;
}

function blobPathFor(fileName) {
  return `uploads/${fileName}`;
}

async function ensureUploadDirectory() {
  await fs.promises.mkdir(path.join(__dirname, "public", "uploads"), { recursive: true });
}

function moveUploadedFile(uploadedFile, targetPath) {
  return new Promise((resolve, reject) => {
    uploadedFile.mv(targetPath, (error) => {
      error ? reject(error) : resolve();
    });
  });
}

async function saveUploadedFile(uploadedFile, storedFileName, req) {
  if (isBlobStorageEnabled()) {
    const blob = await put(blobPathFor(storedFileName), uploadedFile.data, {
      access: "public",
      contentType: uploadedFile.mimetype,
      allowOverwrite: false,
    });

    return blob.url;
  }

  await ensureUploadDirectory();
  const uploadDir = path.resolve(__dirname, "public", "uploads");
  const targetPath = path.resolve(uploadDir, storedFileName);

  if (!targetPath.startsWith(uploadDir)) {
    throw new Error("Invalid target file path");
  }

  await moveUploadedFile(uploadedFile, targetPath);

  return `${getBaseUrl(req)}/uploads/${encodeRoutePart(storedFileName)}`;
}

async function getStoredFileUrl(fileName, req) {
  if (!isValidFileName(fileName)) {
    return null;
  }

  if (isBlobStorageEnabled()) {
    const blob = await get(blobPathFor(fileName), { access: "public" });
    return blob && blob.blob && blob.blob.url;
  }

  const uploadDir = path.resolve(__dirname, "public", "uploads");
  const localPath = path.resolve(uploadDir, fileName);

  if (!localPath.startsWith(uploadDir)) {
    return null;
  }

  try {
    await fs.promises.stat(localPath);
    return `${getBaseUrl(req)}/uploads/${encodeRoutePart(fileName)}`;
  } catch {
    return null;
  }
}

function defaultShortLinkStore() {
  return {
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
}

function normalizeShortLinkStore(rawStore) {
  const store = rawStore && typeof rawStore === "object" ? rawStore : {};
  const normalized = defaultShortLinkStore();

  normalized.version = store.version || normalized.version;
  normalized.links =
    store.links && typeof store.links === "object" && !Array.isArray(store.links)
      ? store.links
      : {};
  normalized.files =
    store.files && typeof store.files === "object" && !Array.isArray(store.files)
      ? store.files
      : {};
  normalized.analytics = {
    ...normalized.analytics,
    ...(store.analytics && typeof store.analytics === "object" ? store.analytics : {}),
  };
  normalized.updatedAt = store.updatedAt || normalized.updatedAt;

  return normalized;
}

async function readStreamToString(stream) {
  const reader = stream.getReader();
  const chunks = [];

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function loadShortLinks() {
  if (shortLinksLoaded && shortLinksCache) {
    return shortLinksCache;
  }

  let loadedStore = null;

  if (isBlobStorageEnabled()) {
    try {
      const blob = await get(SHORT_LINKS_BLOB_PATH, {
        access: "public",
        useCache: false,
      });

      if (blob && blob.stream) {
        loadedStore = JSON.parse(await readStreamToString(blob.stream));
      }
    } catch (error) {
      if (!/not found/i.test(String(error && error.message))) {
        console.warn("Short link Blob store could not be loaded:", error.message);
      }
    }
  } else {
    try {
      const content = await fs.promises.readFile(SHORT_LINKS_FILE, "utf8");
      loadedStore = JSON.parse(content);
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn("Short link JSON store could not be loaded:", error.message);
      }
    }
  }

  shortLinksCache = normalizeShortLinkStore(loadedStore);
  shortLinksLoaded = true;
  return shortLinksCache;
}

async function saveShortLinks(store) {
  const normalizedStore = normalizeShortLinkStore(store);
  normalizedStore.updatedAt = new Date().toISOString();
  shortLinksCache = normalizedStore;
  shortLinksLoaded = true;

  const body = JSON.stringify(normalizedStore, null, 2);

  if (isBlobStorageEnabled()) {
    await put(SHORT_LINKS_BLOB_PATH, body, {
      access: "public",
      allowOverwrite: true,
      contentType: "application/json",
    });
    return normalizedStore;
  }

  await fs.promises.mkdir(path.dirname(SHORT_LINKS_FILE), { recursive: true });
  await fs.promises.writeFile(SHORT_LINKS_FILE, body, "utf8");
  return normalizedStore;
}

async function ensureUniqueSlug(store, requestedSlug = "") {
  if (requestedSlug) {
    if (store.links[requestedSlug]) {
      const error = new Error("That short link is already taken.");
      error.code = "SLUG_TAKEN";
      error.status = 409;
      throw error;
    }

    return requestedSlug;
  }

  for (let length = 6; length <= 10; length += 1) {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const code = generateShortCode(length);

      if (!store.links[code] && !RESERVED_SHORT_SLUGS.has(code)) {
        return code;
      }
    }
  }

  const error = new Error("Could not generate a unique short link.");
  error.code = "SHORT_CODE_EXHAUSTED";
  error.status = 500;
  throw error;
}

async function assertCustomSlugAvailable(value) {
  const validation = validateCustomSlug(value);

  if (validation.error) {
    const error = new Error(validation.error);
    error.code = "SLUG_INVALID";
    error.status = 400;
    throw error;
  }

  if (!validation.slug) {
    return "";
  }

  const store = await loadShortLinks();

  if (store.links[validation.slug]) {
    const error = new Error("That short link is already taken.");
    error.code = "SLUG_TAKEN";
    error.status = 409;
    throw error;
  }

  return validation.slug;
}

function buildShortUrl(req, code) {
  return `${getBaseUrl(req)}/s/${code}`;
}

function buildFileUrl(req, fileName) {
  return `${getBaseUrl(req)}/files/${encodeRoutePart(fileName)}`;
}

function getUploadMetadata(req, uploadedFile) {
  const originalName = uploadedFile && uploadedFile.name ? uploadedFile.name : "Untitled file";
  const title = cleanText(req.body.title, 90) || originalName;
  const description =
    cleanText(req.body.description, 180) ||
    "Upload once. Share everywhere. Discord is gonna love this one.";

  return {
    title,
    description,
    originalName,
  };
}

async function createShortLinkForFile(fileId, req, options = {}) {
  const store = await loadShortLinks();
  const requestedSlug = await assertCustomSlugAvailable(options.customSlug);

  if (!requestedSlug && store.files[fileId] && store.links[store.files[fileId]]) {
    return store.links[store.files[fileId]];
  }

  const code = await ensureUniqueSlug(store, requestedSlug);
  const now = new Date().toISOString();

  store.links[code] = {
    code,
    fileId,
    targetPath: `/files/${encodeRoutePart(fileId)}`,
    directUrl: options.uploadLink || "",
    originalName: options.originalName || fileId,
    fileSize: options.fileSize || "",
    title: options.title || fileId,
    description:
      options.description ||
      "Upload once. Share everywhere. Discord is gonna love this one.",
    custom: Boolean(requestedSlug),
    clicks: 0,
    views: 0,
    referrers: [],
    userAgents: [],
    createdAt: now,
    updatedAt: now,
  };

  store.files[fileId] = code;

  if (options.countUpload) {
    store.analytics.uploads = Number(store.analytics.uploads || 0) + 1;
  }

  await saveShortLinks(store);
  return store.links[code];
}

async function createShortLinkForTarget(targetUrl, req, options = {}) {
  const requestedSlug = await assertCustomSlugAvailable(options.customSlug);
  const store = await loadShortLinks();
  const code = await ensureUniqueSlug(store, requestedSlug);
  const now = new Date().toISOString();

  store.links[code] = {
    code,
    targetUrl,
    title: options.title || "Short link",
    description: options.description || "Tiny link. Big preview.",
    custom: Boolean(requestedSlug),
    clicks: 0,
    views: 0,
    referrers: [],
    userAgents: [],
    createdAt: now,
    updatedAt: now,
  };

  await saveShortLinks(store);
  return store.links[code];
}

async function getShortLinkForFile(fileId) {
  const store = await loadShortLinks();
  const code = store.files[fileId];
  return code ? store.links[code] : null;
}

function pushCapped(list, value, limit = 8) {
  if (!value) {
    return list || [];
  }

  const next = Array.isArray(list) ? list.slice() : [];
  next.push({
    value: String(value).slice(0, 180),
    at: new Date().toISOString(),
  });

  return next.slice(-limit);
}

async function trackShortClick(code, req) {
  const store = await loadShortLinks();
  const record = store.links[code];

  if (!record) {
    return null;
  }

  record.clicks = Number(record.clicks || 0) + 1;
  record.referrers = pushCapped(record.referrers, req.get("referer"));
  record.userAgents = pushCapped(record.userAgents, req.get("user-agent"));
  record.updatedAt = new Date().toISOString();
  store.analytics.shortClicks = Number(store.analytics.shortClicks || 0) + 1;

  await saveShortLinks(store);
  return record;
}

function isReservedTopLevelPath(code) {
  return RESERVED_SHORT_SLUGS.has(code) || code === "api-docs";
}

async function trackFileView(fileId, req) {
  const store = await loadShortLinks();
  const code = store.files[fileId];
  const record = code ? store.links[code] : null;

  if (record) {
    record.views = Number(record.views || 0) + 1;
    record.referrers = pushCapped(record.referrers, req.get("referer"));
    record.userAgents = pushCapped(record.userAgents, req.get("user-agent"));
    record.updatedAt = new Date().toISOString();
  }

  store.analytics.fileViews = Number(store.analytics.fileViews || 0) + 1;
  await saveShortLinks(store);
  return record;
}

function getRandomArrayItem(values, fallback) {
  if (!Array.isArray(values) || values.length === 0) {
    return fallback;
  }

  return values[Math.floor(Math.random() * values.length)] || fallback;
}

function buildSharedViewData(req, extra = {}) {
  return {
    appName,
    appFavicon,
    appBaseUrl: getBaseUrl(req),
    discordInvite,
    twitterInvite,
    facebookInvite,
    instagramInvite,
    linkedinInvite,
    githubInvite,
    ...extra,
  };
}

function renderHome(req, res, status = 200, extra = {}) {
  res.status(status).render(
    "views/index",
    buildSharedViewData(req, {
      uploadError: "",
      formValues: {},
      ...extra,
    })
  );
}

function renderError(req, res, status = 404, extra = {}) {
  res.status(status).render(
    "views/404",
    buildSharedViewData(req, {
      errorStatus: status,
      errorEyebrow: status === 404 ? "404 Error" : "Something went sideways",
      errorTitle: status === 404 ? "That link is off the map." : "The upload flow hit a snag.",
      errorMessage:
        status === 404
          ? "The file, route, or short link could not be found. Start fresh and make a cleaner one."
          : "Try again in a moment. If this keeps happening, check storage and environment settings.",
      ...extra,
    })
  );
}

function isPrivateOrLoopbackHost(hostname) {
  if (!hostname) return true;
  const lowerHost = hostname.toLowerCase().trim();
  if (
    lowerHost === "localhost" ||
    lowerHost === "127.0.0.1" ||
    lowerHost === "0.0.0.0" ||
    lowerHost === "::1" ||
    lowerHost === "169.254.169.254" ||
    lowerHost.endsWith(".localhost") ||
    lowerHost.endsWith(".local") ||
    lowerHost.endsWith(".internal") ||
    lowerHost.endsWith(".onion")
  ) {
    return true;
  }

  const ipv4Match = lowerHost.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 0) return true;
  }

  return false;
}

function sendWebhook(payload) {
  if (!webhookUrl) {
    return;
  }

  try {
    const parsed = new URL(webhookUrl);
    if (!["http:", "https:"].includes(parsed.protocol) || isPrivateOrLoopbackHost(parsed.hostname)) {
      return;
    }
  } catch {
    return;
  }

  axios.post(webhookUrl, payload, { timeout: 3000 }).catch((error) => {
    console.warn("Webhook delivery failed:", error.message);
  });
}

function getCleanTargetUrl(value) {
  const targetUrl = cleanText(value, 2048);

  if (!targetUrl) {
    return "";
  }

  if (targetUrl.startsWith("/")) {
    if (targetUrl.startsWith("//") || targetUrl.startsWith("/\\")) {
      return "";
    }
    return targetUrl;
  }

  try {
    const parsed = new URL(targetUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return "";
    }
    if (isPrivateOrLoopbackHost(parsed.hostname)) {
      return "";
    }
    return parsed.toString();
  } catch {
    return "";
  }
}

app.disable("x-powered-by");
if (process.env.TRUST_PROXY !== "0" && process.env.TRUST_PROXY !== "false") {
  app.set("trust proxy", Number(process.env.TRUST_PROXY) || 1);
}

const corsOriginConfig = process.env.CORS_ORIGIN || "*";
const corsOptions = {
  origin: corsOriginConfig === "*" ? "*" : corsOriginConfig.split(",").map((s) => s.trim()),
  methods: ["GET", "POST", "OPTIONS", "HEAD"],
  allowedHeaders: ["Content-Type", "x-api-token", "Authorization"],
  credentials: true,
};

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://fonts.googleapis.com",
          "https://cdn.jsdelivr.net",
        ],
        fontSrc: [
          "'self'",
          "https://fonts.gstatic.com",
          "https://cdn.jsdelivr.net",
          "data:",
        ],
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        mediaSrc: ["'self'", "blob:", "https:"],
        connectSrc: ["'self'", "https:"],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
        upgradeInsecureRequests: null,
      },
    },
    crossOriginResourcePolicy: { policy: "cross-origin" },
    crossOriginEmbedderPolicy: false,
    frameguard: { action: "sameorigin" },
    xContentTypeOptions: true,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
  })
);

app.use(
  compression({
    threshold: 1024,
    filter: (req, res) => {
      if (req.headers["x-no-compression"]) return false;
      const contentType = res.getHeader("Content-Type") || "";
      if (
        /image\/(jpeg|png|webp|gif)|video\/(mp4|webm)|audio\/(mp3|wav|ogg)/.test(
          String(contentType)
        )
      ) {
        return false;
      }
      return compression.filter(req, res);
    },
  })
);

app.use(cors(corsOptions));
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "/"));

app.use(
  fileUpload({
    createParentPath: true,
    limits: { fileSize: MAX_FILE_SIZE_BYTES },
    abortOnLimit: true,
    responseOnLimit: "File size exceeds allowed limit",
  })
);

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

app.use(
  express.static(path.join(__dirname, "public"), {
    maxAge: "1d",
    etag: true,
    lastModified: true,
    setHeaders: (res) => {
      res.setHeader(
        "Cache-Control",
        "public, max-age=86400, stale-while-revalidate=3600"
      );
    },
  })
);

app.use(
  "/assets",
  express.static(path.join(__dirname, "assets"), {
    maxAge: "7d",
    etag: true,
    lastModified: true,
    setHeaders: (res) => {
      res.setHeader(
        "Cache-Control",
        "public, max-age=604800, stale-while-revalidate=86400, immutable"
      );
    },
  })
);

function safeTokenCompare(provided, expected) {
  if (
    typeof provided !== "string" ||
    typeof expected !== "string" ||
    !provided ||
    !expected
  ) {
    return false;
  }
  const providedHash = crypto.createHash("sha256").update(provided).digest();
  const expectedHash = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(providedHash, expectedHash);
}

const authenticate = (req, res, next) => {
  if (!apiToken) {
    return res.status(503).json({ error: "API token is not configured" });
  }

  const authorizationHeader = req.headers["x-api-token"];

  if (!authorizationHeader || !safeTokenCompare(authorizationHeader, apiToken)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
};

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX_UPLOADS || 30),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    if (req.originalUrl.startsWith("/api/")) {
      return res.status(429).json({
        ERROR: "Too many uploads from this IP. Please try again later.",
        code: "RATE_LIMITED",
      });
    }
    return renderHome(req, res, 429, {
      uploadError:
        "Too many uploads from this IP. Please wait a few minutes before trying again.",
      formValues: {
        customSlug: req.body.customSlug || "",
        title: req.body.title || "",
        description: req.body.description || "",
      },
    });
  },
});

const subscribeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX_SUBSCRIBE || 5),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    return res
      .status(429)
      .send("Too many subscription attempts. Please try again later.");
  },
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX_API || 150),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    return res.status(429).json({
      ERROR: "Too many requests. Please slow down.",
      code: "RATE_LIMITED",
    });
  },
});

const publicReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX_PUBLIC || 600),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    return renderError(req, res, 429, {
      errorEyebrow: "Rate Limited",
      errorTitle: "Slow down a bit.",
      errorMessage: "You have made too many requests recently. Please wait a moment before trying again.",
    });
  },
});

app.get("/", publicReadLimiter, (req, res) => {
  renderHome(req, res);

  sendWebhook({
    embeds: [
      {
        title: "User Connected (/index)",
        color: 0xffa657,
        description: `IP - ||${req.socket.remoteAddress}||`,
      },
    ],
  });
});

app.post("/subscribe", subscribeLimiter, (req, res) => {
  const email = cleanText(req.body.email, 180);
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!email || !emailRegex.test(email)) {
    res.redirect("/?error=invalid_email");
    return;
  }

  sendWebhook({
    embeds: [
      {
        title: "Email Received (Subscription)",
        color: 0xffa657,
        description: `Email - \`${email}\``,
      },
    ],
  });

  res.redirect("/");
});

app.get("/upload", publicReadLimiter, (req, res) => {
  res.redirect("/#upload");
});

app.get("/api-docs", publicReadLimiter, (req, res) => {
  res.status(200).render(
    "views/api_docs",
    buildSharedViewData(req, {
      docsUploadEndpoint: `${getBaseUrl(req)}/api/upload`,
      docsHealthEndpoint: `${getBaseUrl(req)}/api/health`,
      docsFileField: "myFile",
      docsAuthHeader: "x-api-token",
      docsSampleToken: "YOUR_API_TOKEN",
      docsSampleSlug: "launch-assets",
      docsResponseExample: {
        data: {
          fileLink: `${getBaseUrl(req)}/files/abc123.png`,
          shortLink: `${getBaseUrl(req)}/s/demo`,
          shortCode: "demo",
          fileSize: "248 KB",
          fileName: "abc123.png",
          uploadLink: `${getBaseUrl(req)}/uploads/abc123.png`,
          title: "Launch poster",
          description: "Tiny link. Big preview.",
        },
      },
    })
  );
});

app.post("/upload", uploadLimiter, async (req, res) => {
  const uploadedFile = getFirstUploadedFile(req);
  const formValues = {
    customSlug: req.body.customSlug || "",
    title: req.body.title || "",
    description: req.body.description || "",
  };

  if (!uploadedFile) {
    renderHome(req, res, 400, {
      uploadError: "No file selected. Tiny link. Big preview. We still need the file.",
      formValues,
    });
    return;
  }

  const validation = validateUploadedFile(uploadedFile);
  if (!validation.valid) {
    renderHome(req, res, 400, {
      uploadError: validation.error,
      formValues,
    });
    return;
  }

  try {
    await assertCustomSlugAvailable(req.body.customSlug);

    const storedFileName = buildStoredFileName(uploadedFile.name);
    const metadata = getUploadMetadata(req, uploadedFile);
    const filesize = formatFileSize(uploadedFile.size);
    const uploadLink = await saveUploadedFile(uploadedFile, storedFileName, req);
    const fileLink = buildFileUrl(req, storedFileName);
    const shortRecord = await createShortLinkForFile(storedFileName, req, {
      customSlug: req.body.customSlug,
      uploadLink,
      fileSize: filesize,
      title: metadata.title,
      description: metadata.description,
      originalName: metadata.originalName,
      countUpload: true,
    });
    const shortLink = buildShortUrl(req, shortRecord.code);

    res.status(200).render(
      "views/success.ejs",
      buildSharedViewData(req, {
        uploadLink,
        fileLink,
        shortLink,
        shortCode: shortRecord.code,
        fileSize: filesize,
        fileName: storedFileName,
        originalName: metadata.originalName,
        embedTitle: metadata.title,
        embedDescription: metadata.description,
      })
    );

    sendWebhook({
      embeds: [
        {
          title: "User Uploaded a file (/upload)",
          color: 0xffa657,
          description: `User IP - ||${req.ip}||`,
          image: {
            url: uploadLink,
          },
        },
      ],
    });
  } catch (error) {
    if (["SLUG_INVALID", "SLUG_TAKEN"].includes(error.code)) {
      renderHome(req, res, error.status || 400, {
        uploadError: error.message,
        formValues,
      });
      return;
    }

    console.error(error);
    renderError(req, res, 500, {
      errorEyebrow: "Upload Failed",
      errorTitle: "Your file is not cooking yet.",
      errorMessage:
        "Storage did not accept the upload. Check Vercel Blob/local upload settings and try again.",
    });
  }
});

app.post("/api/upload", cors(corsOptions), apiLimiter, uploadLimiter, authenticate, async (req, res) => {
  const uploadedFile = getFirstUploadedFile(req);

  if (!uploadedFile) {
    res.status(400).json({ ERROR: "No Files Specified" });
    return;
  }

  const validation = validateUploadedFile(uploadedFile);
  if (!validation.valid) {
    res.status(400).json({ ERROR: validation.error, code: "FILE_INVALID" });
    return;
  }

  try {
    await assertCustomSlugAvailable(req.body.customSlug);

    const storedFileName = buildStoredFileName(uploadedFile.name);
    const metadata = getUploadMetadata(req, uploadedFile);
    const uploadLink = await saveUploadedFile(uploadedFile, storedFileName, req);
    const fileLink = buildFileUrl(req, storedFileName);
    const filesize = formatFileSize(uploadedFile.size);
    const shortRecord = await createShortLinkForFile(storedFileName, req, {
      customSlug: req.body.customSlug,
      uploadLink,
      fileSize: filesize,
      title: metadata.title,
      description: metadata.description,
      originalName: metadata.originalName,
      countUpload: true,
    });

    res.status(200).json({
      data: {
        fileLink,
        shortLink: buildShortUrl(req, shortRecord.code),
        shortCode: shortRecord.code,
        fileSize: filesize,
        fileName: storedFileName,
        uploadLink,
        title: metadata.title,
        description: metadata.description,
      },
    });
  } catch (error) {
    if (["SLUG_INVALID", "SLUG_TAKEN"].includes(error.code)) {
      res.status(error.status || 400).json({
        ERROR: error.message,
        code: error.code,
      });
      return;
    }

    console.error(error);
    res.status(500).json({ ERROR: "Error uploading file" });
  }
});

app.post("/api/shorten", cors(corsOptions), apiLimiter, authenticate, async (req, res) => {
  const targetUrl = getCleanTargetUrl(req.body.targetUrl);

  if (!targetUrl) {
    res.status(400).json({
      ERROR: "Provide a valid http(s) targetUrl or local path",
      code: "TARGET_INVALID",
    });
    return;
  }

  try {
    const shortRecord = await createShortLinkForTarget(targetUrl, req, {
      customSlug: req.body.customSlug,
      title: cleanText(req.body.title, 90),
      description: cleanText(req.body.description, 180),
    });

    res.status(200).json({
      data: {
        targetUrl,
        shortLink: buildShortUrl(req, shortRecord.code),
        shortCode: shortRecord.code,
        clicks: shortRecord.clicks,
      },
    });
  } catch (error) {
    if (["SLUG_INVALID", "SLUG_TAKEN"].includes(error.code)) {
      res.status(error.status || 400).json({
        ERROR: error.message,
        code: error.code,
      });
      return;
    }

    console.error(error);
    res.status(500).json({ ERROR: "Error creating short link" });
  }
});

app.get("/api/health", apiLimiter, (req, res) => {
  res.status(200).json({
    ok: true,
    service: `${appName} API`,
    time: new Date().toISOString(),
  });
});

app.get("/s/:code", publicReadLimiter, async (req, res) => {
  const code = sanitizeSlug(req.params.code);

  if (!code || code !== req.params.code) {
    renderError(req, res, 404, {
      errorEyebrow: "Short Link Missing",
      errorTitle: "That short link is not in the drawer.",
      errorMessage: "Check the slug and try again, or upload a fresh file.",
    });
    return;
  }

  try {
    const record = await trackShortClick(code, req);

    if (!record) {
      renderError(req, res, 404, {
        errorEyebrow: "Short Link Missing",
        errorTitle: "That short link is not in the drawer.",
        errorMessage: "Check the slug and try again, or upload a fresh file.",
      });
      return;
    }

    res.redirect(302, record.targetUrl || record.targetPath || `/files/${record.fileId}`);
  } catch (error) {
    console.error(error);
    renderError(req, res, 500, {
      errorEyebrow: "Redirect Failed",
      errorTitle: "The short link tripped on the way out.",
      errorMessage: "The link exists, but the redirect could not be completed right now.",
    });
  }
});

app.get("/:code", publicReadLimiter, async (req, res, next) => {
  const code = sanitizeSlug(req.params.code);

  if (!code || code !== req.params.code || isReservedTopLevelPath(code)) {
    next();
    return;
  }

  try {
    const record = await trackShortClick(code, req);

    if (!record) {
      next();
      return;
    }

    res.redirect(302, record.targetUrl || record.targetPath || `/files/${record.fileId}`);
  } catch (error) {
    console.error(error);
    renderError(req, res, 500, {
      errorEyebrow: "Redirect Failed",
      errorTitle: "The short link tripped on the way out.",
      errorMessage: "The link exists, but the redirect could not be completed right now.",
    });
  }
});

app.get("/uploads/*", publicReadLimiter, async (req, res, next) => {
  if (!isBlobStorageEnabled()) {
    return next();
  }

  const rawPath = decodeURIComponent(req.path.slice(9));
  const fileToGet = path.basename(rawPath);

  if (!isValidFileName(fileToGet) || fileToGet !== rawPath) {
    return next();
  }

  try {
    const imageDirectLink = await getStoredFileUrl(fileToGet, req);

    if (!imageDirectLink) {
      return next();
    }

    res.redirect(302, imageDirectLink);
  } catch (error) {
    next(error);
  }
});

app.get("/files/*", publicReadLimiter, async (req, res) => {
  const rawPath = decodeURIComponent(req.path.slice(7));
  const fileToGet = path.basename(rawPath);

  if (!isValidFileName(fileToGet) || fileToGet !== rawPath) {
    renderError(req, res, 404, {
      errorEyebrow: "File Not Found",
      errorTitle: "That file link has no file behind it.",
      errorMessage: "The asset may have been removed, renamed, or never uploaded.",
    });
    return;
  }

  try {
    const imageDirectLink = await getStoredFileUrl(fileToGet, req);

    if (!imageDirectLink) {
      renderError(req, res, 404, {
        errorEyebrow: "File Not Found",
        errorTitle: "That file link has no file behind it.",
        errorMessage: "The asset may have been removed, renamed, or never uploaded.",
      });
      return;
    }

    let shortRecord = await getShortLinkForFile(fileToGet);

    if (!shortRecord) {
      shortRecord = await createShortLinkForFile(fileToGet, req, {
        uploadLink: imageDirectLink,
        title: getRandomArrayItem(settings.embed.title, "Discord-ready upload"),
        description: getRandomArrayItem(
          settings.embed.description,
          "Clean, stable, preview-friendly file hosting."
        ),
      });
    }

    const trackedRecord = await trackFileView(fileToGet, req);
    const activeRecord = trackedRecord || shortRecord;
    const title =
      activeRecord.title || getRandomArrayItem(settings.embed.title, "Discord-ready upload");
    const description =
      activeRecord.description ||
      getRandomArrayItem(
        settings.embed.description,
        "Clean, stable, preview-friendly file hosting."
      );

    res.status(200).render(
      "views/display",
      buildSharedViewData(req, {
        imageDirectLink,
        fileLink: buildFileUrl(req, fileToGet),
        shortLink: buildShortUrl(req, activeRecord.code),
        shortCode: activeRecord.code,
        fileName: fileToGet,
        originalName: activeRecord.originalName || fileToGet,
        fileSize: activeRecord.fileSize || "",
        title,
        description,
        app_link: configuredAppLink || "/",
        clicks: activeRecord.clicks || 0,
        views: activeRecord.views || 0,
      })
    );
  } catch (error) {
    console.error(error);
    renderError(req, res, 404);
  }
});

app.use((req, res) => {
  renderError(req, res, 404);
});

if (require.main === module) {
  const listenPort = process.env.PORT || appPort;

  app.listen(listenPort, (err) => {
    err
      ? console.log(err)
      : console.log(`Webserver Started on appPort: ${listenPort}`);
  });
}

module.exports = app;
