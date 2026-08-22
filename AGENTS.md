# EmbedCDN Multi-Agent Configuration & Guidelines

This document outlines the specialized agent roles, architecture principles, security guidelines, and testing workflows for collaborating on **EmbedCDN**.

---

## 👥 Specialized Agent Roles

### 1. ⚙️ `backend_engineer` (Backend & Storage Specialist)
- **Scope**: Core Node.js / Express.js logic, routing, middleware, and storage adapters.
- **Key Responsibilities**:
  - Maintain and optimize file handling via local disk (`public/uploads/`) and `@vercel/blob`.
  - Maintain short link generation algorithms, slug validation, collision avoidance, and redirection pipelines (`/s/:code`, `/:code`).
  - Develop and maintain REST endpoints (`/api/upload`, `/api/shorten`, `/api/health`).
  - Manage database migrations and state serialization (`data/short-links.json`).

### 2. 🎨 `frontend_engineer` (UI / UX & Embed Specialist)
- **Scope**: Presentation layer, EJS templates, CSS styling, and client-side JavaScript.
- **Key Responsibilities**:
  - Maintain and polish views (`views/index.ejs`, `views/display.ejs`, `views/api_docs.ejs`, `views/success.ejs`, `views/404.ejs`).
  - Optimize Open Graph (`og:*`) and Twitter Card metadata for rich Discord previews.
  - Implement and improve UI interactions in `assets/js/main.js` (drag-and-drop, copy actions, upload feedback).
  - Ensure mobile responsiveness and accessible design.

### 3. 🛡️ `security_auditor` (Security & Privacy Auditor)
- **Scope**: Authentication, authorization, file upload safety, and data privacy.
- **Key Responsibilities**:
  - Audit `x-api-token` authorization routines across REST endpoints.
  - Implement upload safeguards: MIME-type sniffing, extension whitelisting, file size limits, and path traversal defense.
  - Mitigate abuse vectors: Rate limiting (`express-rate-limit`), ReDoS prevention, parameter sanitization.
  - Verify Discord embed kill-switch behavior (ensuring deleted media cannot be retrieved).

### 4. 🧪 `qa_test_engineer` (QA & Test Automation Engineer)
- **Scope**: Testing infrastructure, automated endpoint testing, edge case verification.
- **Key Responsibilities**:
  - Implement automated test suites (e.g., Jest / Supertest) for API and route validation.
  - Test custom slug edge cases, reserved word collisions, and error responses (400, 401, 404, 500).
  - Build smoke test scripts for rapid verification during deployment.

---

## 🏛️ Architectural Guidelines

1. **Dual Storage Parity**:
   - Always ensure changes work consistently across both local file storage and `@vercel/blob`.
   - Check `isBlobStorageEnabled()` before calling disk I/O routines.

2. **Slug Safety**:
   - Always sanitize and validate user-supplied slugs against `RESERVED_SHORT_SLUGS` using `validateCustomSlug()`.

3. **Discord Crawler Compatibility**:
   - Preserve `<meta property="og:*">` tags and appropriate HTTP status codes in `views/display.ejs` to guarantee Discord crawler previews function reliably.

4. **Configuration Precedence**:
   - Always prioritize environment variables (`process.env.*`) with graceful fallbacks to `settings.json`.

---

## 🚀 Running & Testing

```bash
# Start local development server with live reload
npm run dev

# Start production server
npm start
```
