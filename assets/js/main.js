/**
 * EmbedCDN - Client-Side Micro-Interactions & UX Engine
 * Vanilla ES6+ - Zero Dependencies
 */

(function () {
  "use strict";

  const body = document.body;
  const root = document.documentElement;

  // DOM Elements
  const navToggle = document.querySelector("[data-nav-toggle]");
  const navPanel = document.querySelector("[data-nav-panel]");
  const uploadForm = document.querySelector("[data-upload-form]");
  const uploadZone = document.querySelector("[data-upload-zone]");
  const fileInput = document.querySelector("[data-file-input]");
  const fileName = document.querySelector("[data-file-name]");
  const fileCard = document.querySelector("[data-file-card]");
  const fileThumb = document.querySelector("[data-file-thumb]");
  const filePreview = document.querySelector("[data-file-preview]");
  const selectedName = document.querySelector("[data-selected-name]");
  const selectedSize = document.querySelector("[data-selected-size]");
  const titleInput = document.querySelector("[data-title-input]");
  const descriptionInput = document.querySelector("[data-description-input]");
  const slugInput = document.querySelector("[data-slug-input]");
  const slugHelp = document.querySelector("[data-slug-help]");
  const submitButton = document.querySelector("[data-submit-button]");
  const formError = document.querySelector("[data-form-error]");
  const revealItems = document.querySelectorAll(".reveal");
  const resultData = document.querySelector("[data-upload-result]");

  // Constants
  const RECENT_KEY = "embedcdn:recent-uploads";
  const DOCS_LAST_SHORT_KEY = "embedcdn:docs-last-short-link";
  const MAX_RECOMMENDED_SIZE = 25 * 1024 * 1024; // 25 MB (Standard Discord preview limit)

  let activeObjectUrl = "";

  /**
   * Human-readable byte formatting
   */
  const formatBytes = function (bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) {
      return "0 B";
    }
    if (bytes >= 1e9) {
      return (bytes / 1e9).toFixed(2) + " GB";
    }
    if (bytes >= 1e6) {
      return (bytes / 1e6).toFixed(2) + " MB";
    }
    if (bytes >= 1000) {
      return Math.round(bytes / 1000) + " KB";
    }
    return bytes + " B";
  };

  /**
   * Slugify string for branded URLs
   */
  const slugify = function (value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  };

  /**
   * Get application short base URL
   */
  const getShortBase = function () {
    const slugPrefix = document.querySelector(".slug-input-wrap span");
    if (slugPrefix && slugPrefix.textContent) {
      return slugPrefix.textContent.replace(/\/s\/?$/, "");
    }
    const current = window.location.origin;
    return current === "null" ? "https://yourdomain.com" : current;
  };

  /**
   * Set text content across multiple selector targets
   */
  const setText = function (selector, value) {
    document.querySelectorAll(selector).forEach(function (element) {
      element.textContent = value;
    });
  };

  /**
   * Trigger subtle device haptics when supported
   */
  const triggerHaptic = function (pattern) {
    try {
      if (typeof navigator !== "undefined" && navigator.vibrate) {
        navigator.vibrate(pattern || [15, 30]);
      }
    } catch {
      // Ignore vibration errors on unsupported environments
    }
  };

  /**
   * Display dynamic slide-in toast notifications
   */
  const showToast = function (message, type) {
    let stack = document.querySelector("[data-toast-stack]");

    if (!stack) {
      stack = document.createElement("div");
      stack.className = "toast-stack";
      stack.setAttribute("data-toast-stack", "");
      stack.setAttribute("aria-live", "polite");
      stack.setAttribute("aria-atomic", "true");
      document.body.appendChild(stack);
    }

    const toast = document.createElement("div");
    toast.className = "toast" + (type === "error" ? " is-error" : "");
    toast.innerHTML =
      '<i class="bi ' +
      (type === "error" ? "bi-exclamation-triangle" : "bi-check2-circle") +
      '" aria-hidden="true"></i><span></span>';
    toast.querySelector("span").textContent = message;
    stack.appendChild(toast);

    window.setTimeout(function () {
      toast.classList.add("is-leaving");
      window.setTimeout(function () {
        toast.remove();
      }, 220);
    }, 3200);
  };

  /**
   * Copy string to clipboard with visual & haptic feedback
   */
  const copyText = async function (value, label) {
    if (!value) {
      showToast("Nothing to copy yet", "error");
      return false;
    }

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const tempInput = document.createElement("input");
        tempInput.value = value;
        document.body.appendChild(tempInput);
        tempInput.select();
        document.execCommand("copy");
        tempInput.remove();
      }

      triggerHaptic([20]);
      showToast(label || "Copied to clipboard");
      return true;
    } catch (error) {
      showToast("Copy failed", "error");
      return false;
    }
  };

  /**
   * Extract text value from targeted element
   */
  const copyValueFromTarget = function (selector) {
    if (!selector) {
      return "";
    }
    const target = document.querySelector(selector);
    if (!target) {
      return "";
    }
    if (typeof target.value === "string") {
      return target.value;
    }
    return target.textContent || "";
  };

  /**
   * Recent Uploads Storage Management
   */
  const getRecentUploads = function () {
    try {
      return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    } catch {
      return [];
    }
  };

  const saveRecentUploads = function (items) {
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(items.slice(0, 8)));
    } catch {
      // Storage quota exceeded or disabled
    }
  };

  const addRecentUpload = function (item) {
    if (!item.shortLink && !item.embedLink && !item.directLink) {
      return;
    }

    const next = [
      {
        fileName: item.fileName || "Hosted file",
        embedLink: item.embedLink || "",
        shortLink: item.shortLink || "",
        directLink: item.directLink || "",
        createdAt: new Date().toISOString(),
      },
    ].concat(
      getRecentUploads().filter(function (recent) {
        return recent.shortLink !== item.shortLink && recent.embedLink !== item.embedLink;
      })
    );

    saveRecentUploads(next);
  };

  const latestLink = function () {
    const recent = getRecentUploads();
    return recent.length ? recent[0].shortLink || recent[0].embedLink || recent[0].directLink : "";
  };

  /**
   * Update live preview images across mockups
   */
  const updatePreviewImages = function (url, isImage) {
    document.querySelectorAll("[data-preview-image]").forEach(function (element) {
      if (isImage && url) {
        element.style.backgroundImage = "url('" + url + "')";
        element.classList.add("has-image");
      } else {
        element.style.backgroundImage = "";
        element.classList.remove("has-image");
      }
    });
  };

  /**
   * Synchronize all platform live previews (Discord, X/Twitter, WhatsApp)
   */
  const updateLivePreview = function () {
    const selectedFile = fileInput && fileInput.files && fileInput.files[0];
    const title =
      (titleInput && titleInput.value.trim()) ||
      (selectedFile && selectedFile.name) ||
      "Fresh upload";
    const description =
      (descriptionInput && descriptionInput.value.trim()) ||
      "Upload once. Share everywhere.";
    const slug = slugify(slugInput && slugInput.value);
    const shortUrl = getShortBase() + "/s/" + (slug || "ready");
    const fileUrl = getShortBase() + "/files/" + (selectedFile ? selectedFile.name : "generated-file");

    setText("[data-preview-title]", title);
    setText("[data-preview-description]", description);
    setText("[data-preview-short-link]", shortUrl);
    setText("[data-preview-file-link]", fileUrl);
  };

  /**
   * Validate custom slug input in real time
   */
  const validateSlug = function () {
    if (!slugInput || !slugHelp) {
      return true;
    }

    const raw = slugInput.value.trim();

    if (!raw) {
      slugHelp.textContent = "Use lowercase letters, numbers, and hyphens. Max 40 characters.";
      slugHelp.classList.remove("is-error");
      updateLivePreview();
      return true;
    }

    const clean = slugify(raw);
    const valid =
      raw === clean &&
      raw.length >= 3 &&
      raw.length <= 40 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(raw);

    if (!valid) {
      slugHelp.textContent =
        "Use 3-40 lowercase letters, numbers, and hyphens. No leading or trailing hyphens.";
      slugHelp.classList.add("is-error");
      updateLivePreview();
      return false;
    }

    slugHelp.textContent = getShortBase() + "/s/" + raw;
    slugHelp.classList.remove("is-error");
    updateLivePreview();
    return true;
  };

  /**
   * Determine file category icon
   */
  const getFileIconClass = function (file) {
    if (!file) return "bi-file-earmark";
    const type = file.type || "";
    const name = file.name.toLowerCase();

    if (type.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/.test(name)) {
      return "bi-file-earmark-image";
    }
    if (type.startsWith("video/") || /\.(mp4|webm|mov|m4v|mkv)$/.test(name)) {
      return "bi-file-earmark-play";
    }
    if (type.startsWith("audio/") || /\.(mp3|ogg|wav|m4a|flac|aac)$/.test(name)) {
      return "bi-file-earmark-music";
    }
    if (type === "application/pdf" || name.endsWith(".pdf")) {
      return "bi-file-earmark-pdf";
    }
    if (/\.(zip|tar|gz|rar|7z)$/.test(name)) {
      return "bi-file-earmark-zip";
    }
    if (/\.(js|ts|json|html|css|py|go|rs|c|cpp|java|php)$/.test(name)) {
      return "bi-file-earmark-code";
    }
    return "bi-file-earmark";
  };

  /**
   * Update file selection state & previews
   */
  const updateFileState = function () {
    if (!fileInput) {
      return;
    }

    const files = fileInput.files;
    const file = files && files[0];

    if (activeObjectUrl) {
      URL.revokeObjectURL(activeObjectUrl);
      activeObjectUrl = "";
    }

    if (!file) {
      if (fileName) {
        fileName.textContent = "No file selected";
      }
      if (fileCard) {
        fileCard.classList.add("is-hidden");
      }
      if (uploadZone) {
        uploadZone.classList.remove("has-file");
      }
      updatePreviewImages("", false);
      updateLivePreview();
      return;
    }

    if (fileName) {
      fileName.textContent = file.name;
    }
    if (selectedName) {
      selectedName.textContent = file.name;
    }
    if (selectedSize) {
      selectedSize.textContent = formatBytes(file.size);
      if (file.size > MAX_RECOMMENDED_SIZE) {
        selectedSize.classList.add("is-warning");
        selectedSize.title = "File exceeds 25 MB. Discord may not render rich inline video.";
      } else {
        selectedSize.classList.remove("is-warning");
        selectedSize.removeAttribute("title");
      }
    }
    if (fileCard) {
      fileCard.classList.remove("is-hidden");
    }
    if (uploadZone) {
      uploadZone.classList.add("has-file");
    }

    const isImage = file.type && file.type.indexOf("image/") === 0;

    // Update thumbnail icon or image preview
    if (fileThumb) {
      const iconEl = fileThumb.querySelector("i");
      if (iconEl) {
        iconEl.className = "bi " + getFileIconClass(file);
      }
    }

    if (isImage) {
      activeObjectUrl = URL.createObjectURL(file);
      if (filePreview) {
        filePreview.src = activeObjectUrl;
        filePreview.alt = file.name + " preview";
      }
      if (fileThumb) {
        fileThumb.classList.add("has-image");
      }
      updatePreviewImages(activeObjectUrl, true);
    } else {
      if (filePreview) {
        filePreview.removeAttribute("src");
        filePreview.alt = "";
      }
      if (fileThumb) {
        fileThumb.classList.remove("has-image");
      }
      updatePreviewImages("", false);
    }

    updateLivePreview();
  };

  /**
   * Render algorithmic QR placeholder matrix
   */
  const renderQrPlaceholder = function () {
    document.querySelectorAll("[data-qr-placeholder]").forEach(function (qr) {
      const value = qr.getAttribute("data-qr-value") || "embedcdn";
      let seed = 0;

      for (let i = 0; i < value.length; i += 1) {
        seed = (seed + value.charCodeAt(i) * (i + 3)) % 997;
      }

      qr.innerHTML = "";

      for (let i = 0; i < 81; i += 1) {
        const cell = document.createElement("span");
        const finder =
          (i < 21 && i % 9 < 3) ||
          (i < 27 && i % 9 > 5) ||
          (i > 53 && i % 9 < 3);
        const on = finder || ((i * 17 + seed) % 5 < 2);
        if (on) {
          cell.classList.add("is-on");
        }
        qr.appendChild(cell);
      }
    });
  };

  /**
   * Render Recent Uploads Drawer Modal
   */
  const renderRecentPanel = function () {
    let overlay = document.querySelector("[data-recent-overlay]");

    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "recent-overlay";
      overlay.setAttribute("data-recent-overlay", "");
      overlay.innerHTML =
        '<section class="recent-panel" role="dialog" aria-modal="true" aria-label="Recent uploads">' +
        '<div class="recent-head"><h2>Recent uploads</h2><button class="icon-button" type="button" data-close-recent aria-label="Close recent uploads"><i class="bi bi-x-lg" aria-hidden="true"></i></button></div>' +
        '<div class="recent-list" data-recent-list></div>' +
        '<button class="button button-secondary button-full" type="button" data-clear-recent><i class="bi bi-trash3" aria-hidden="true"></i><span>Clear recent uploads</span></button>' +
        "</section>";
      document.body.appendChild(overlay);

      overlay.addEventListener("click", function (event) {
        if (event.target === overlay || event.target.closest("[data-close-recent]")) {
          overlay.classList.remove("is-open");
        }
      });

      overlay.querySelector("[data-clear-recent]").addEventListener("click", function () {
        saveRecentUploads([]);
        renderRecentPanel();
        showToast("Recent uploads cleared");
      });
    }

    const list = overlay.querySelector("[data-recent-list]");
    const items = getRecentUploads();
    list.innerHTML = "";

    if (!items.length) {
      list.innerHTML =
        '<div class="empty-state">No recent uploads yet. Your uploads will be remembered here.</div>';
      return overlay;
    }

    items.forEach(function (item) {
      const row = document.createElement("article");
      row.className = "recent-item";
      row.innerHTML =
        "<div><strong></strong><code></code></div>" +
        '<div class="recent-actions">' +
        '<button class="icon-button" type="button" data-copy-short aria-label="Copy short link"><i class="bi bi-link-45deg" aria-hidden="true"></i></button>' +
        '<button class="icon-button" type="button" data-copy-embed aria-label="Copy embed link"><i class="bi bi-copy" aria-hidden="true"></i></button>' +
        '<a class="icon-button" target="_blank" rel="noreferrer" aria-label="Open link"><i class="bi bi-box-arrow-up-right" aria-hidden="true"></i></a>' +
        "</div>";
      row.querySelector("strong").textContent = item.fileName || "Hosted file";
      row.querySelector("code").textContent = item.shortLink || item.embedLink || item.directLink || "";
      row.querySelector("[data-copy-short]").addEventListener("click", function () {
        copyText(item.shortLink || item.embedLink, "Copied short link");
      });
      row.querySelector("[data-copy-embed]").addEventListener("click", function () {
        copyText(item.embedLink || item.shortLink, "Copied embed link");
      });
      row.querySelector("a").href = item.embedLink || item.shortLink || item.directLink || "/";
      list.appendChild(row);
    });

    return overlay;
  };

  const openRecentPanel = function () {
    const overlay = renderRecentPanel();
    overlay.classList.add("is-open");
    const close = overlay.querySelector("[data-close-recent]");
    if (close) {
      close.focus();
    }
  };

  // Mobile Navigation Toggle
  if (navToggle && navPanel) {
    navToggle.addEventListener("click", function () {
      const isOpen = body.classList.toggle("nav-open");
      navToggle.setAttribute("aria-expanded", String(isOpen));
    });

    navPanel.querySelectorAll("a").forEach(function (link) {
      link.addEventListener("click", function () {
        body.classList.remove("nav-open");
        navToggle.setAttribute("aria-expanded", "false");
      });
    });
  }

  // Drag & Drop Upload Zone Handling
  if (uploadZone && fileInput) {
    ["dragenter", "dragover"].forEach(function (eventName) {
      uploadZone.addEventListener(eventName, function (event) {
        event.preventDefault();
        uploadZone.classList.add("is-dragover");
      });
    });

    ["dragleave", "dragend", "drop"].forEach(function (eventName) {
      uploadZone.addEventListener(eventName, function (event) {
        event.preventDefault();
        uploadZone.classList.remove("is-dragover");
      });
    });

    uploadZone.addEventListener("drop", function (event) {
      if (event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length) {
        fileInput.files = event.dataTransfer.files;
        updateFileState();
        triggerHaptic([15]);
        showToast("File staged for upload");
      }
    });

    uploadZone.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        fileInput.click();
      }
    });

    fileInput.addEventListener("change", updateFileState);
  }

  // Real-time Inputs Event Listeners
  if (titleInput) {
    titleInput.addEventListener("input", updateLivePreview);
  }

  if (descriptionInput) {
    descriptionInput.addEventListener("input", updateLivePreview);
  }

  if (slugInput) {
    slugInput.addEventListener("input", validateSlug);
  }

  // Upload Form Submission Handler
  if (uploadForm && submitButton) {
    uploadForm.addEventListener("submit", function (event) {
      const hasFile = fileInput && fileInput.files && fileInput.files.length;
      const slugOk = validateSlug();

      if (!hasFile || !slugOk) {
        event.preventDefault();
        if (formError) {
          formError.classList.remove("is-hidden");
          formError.querySelector("span").textContent = !hasFile
            ? "No file selected. Please choose or drop a file to upload."
            : "Custom slug is invalid. Use 3-40 lowercase letters, numbers, and hyphens.";
        }
        triggerHaptic([40, 50, 40]);
        showToast(!hasFile ? "Please select a file" : "Slug is invalid", "error");
        return;
      }

      uploadForm.classList.add("is-submitting");
      submitButton.setAttribute("aria-busy", "true");
      submitButton.disabled = true;
      showToast("Uploading media...");
    });
  }

  // One-Click Copy Triggers
  document.querySelectorAll("[data-copy-button]").forEach(function (button) {
    button.addEventListener("click", async function () {
      const didCopy = await copyText(
        button.getAttribute("data-copy-value"),
        button.getAttribute("data-copy-label") || "Copied link"
      );

      if (didCopy) {
        const icon = button.querySelector("i");
        const originalClass = icon ? icon.className : "";
        button.classList.add("is-copied");
        if (icon) {
          icon.className = "bi bi-check2";
        }
        window.setTimeout(function () {
          button.classList.remove("is-copied");
          if (icon) {
            icon.className = originalClass;
          }
        }, 1600);
      }
    });
  });

  document.querySelectorAll("[data-copy-source]").forEach(function (button) {
    button.addEventListener("click", async function () {
      const sourceId = button.getAttribute("data-copy-source");
      const source = sourceId ? document.getElementById(sourceId) : null;
      const didCopy = await copyText(source ? source.textContent : "", "Copied code sample");
      if (didCopy) {
        const icon = button.querySelector("i");
        const originalClass = icon ? icon.className : "";
        button.classList.add("is-copied");
        if (icon) {
          icon.className = "bi bi-check2";
        }
        window.setTimeout(function () {
          button.classList.remove("is-copied");
          if (icon) {
            icon.className = originalClass;
          }
        }, 1600);
      }
    });
  });

  document.querySelectorAll("[data-copy-target]").forEach(function (button) {
    button.addEventListener("click", async function () {
      const didCopy = await copyText(
        copyValueFromTarget(button.getAttribute("data-copy-target")),
        button.getAttribute("data-copy-label") || "Copied value"
      );
      if (didCopy) {
        const icon = button.querySelector("i");
        const originalClass = icon ? icon.className : "";
        button.classList.add("is-copied");
        if (icon) {
          icon.className = "bi bi-check2";
        }
        window.setTimeout(function () {
          button.classList.remove("is-copied");
          if (icon) {
            icon.className = originalClass;
          }
        }, 1600);
      }
    });
  });

  // Platform Preview Tabs Switcher
  document.querySelectorAll("[data-preview-tabs]").forEach(function (tabs) {
    tabs.addEventListener("click", function (event) {
      const button = event.target.closest("[data-preview-tab]");
      if (!button) {
        return;
      }

      const target = button.getAttribute("data-preview-tab");
      const group = tabs.parentElement;

      tabs.querySelectorAll("[data-preview-tab]").forEach(function (tab) {
        const active = tab === button;
        tab.classList.toggle("is-active", active);
        tab.setAttribute("aria-selected", String(active));
      });

      group.querySelectorAll("[data-preview-panel]").forEach(function (panel) {
        const active = panel.getAttribute("data-preview-panel") === target;
        panel.hidden = !active;
        panel.classList.toggle("is-active", active);
      });
    });
  });

  // API Documentation Language Tabs
  document.querySelectorAll("[data-doc-lang-tabs]").forEach(function (tabs) {
    tabs.addEventListener("click", function (event) {
      const button = event.target.closest("[data-doc-lang]");
      if (!button) {
        return;
      }

      const target = button.getAttribute("data-doc-lang");
      const group = tabs.parentElement;

      tabs.querySelectorAll("[data-doc-lang]").forEach(function (tab) {
        const active = tab === button;
        tab.classList.toggle("is-active", active);
        tab.setAttribute("aria-selected", String(active));
      });

      group.querySelectorAll("[data-doc-lang-panel]").forEach(function (panel) {
        const active = panel.getAttribute("data-doc-lang-panel") === target;
        panel.hidden = !active;
        panel.classList.toggle("is-active", active);
      });
    });
  });

  // Quick Action Triggers
  document.querySelectorAll("[data-open-recent]").forEach(function (button) {
    button.addEventListener("click", openRecentPanel);
  });

  document.querySelectorAll("[data-copy-latest]").forEach(function (button) {
    button.addEventListener("click", function () {
      copyText(latestLink(), "Copied latest link");
    });
  });

  // Interactive API Tester
  document.querySelectorAll("[data-api-tester]").forEach(function (form) {
    const endpoint = form.getAttribute("data-endpoint") || "/api/upload";
    const tokenInput = form.querySelector("[data-api-token-input]");
    const fileInputEl = form.querySelector("[data-api-file-input]");
    const submit = form.querySelector("[data-api-test-button]");
    const submitLabel = form.querySelector("[data-api-test-label]");
    const resultRoot = document.querySelector("[data-api-result]");
    const statusEl = document.querySelector("[data-api-result-status]");
    const jsonEl = document.querySelector("[data-api-result-json]");
    const linksEl = document.querySelector("[data-api-result-links]");
    const fileLinkEl = document.querySelector("[data-api-result-file-link]");
    const shortLinkEl = document.querySelector("[data-api-result-short-link]");

    const setStatus = function (text, state) {
      if (!statusEl) {
        return;
      }
      statusEl.textContent = text;
      statusEl.className = "result-pill" + (state ? " is-" + state : "");
    };

    const setJson = function (value) {
      if (jsonEl) {
        jsonEl.textContent = JSON.stringify(value, null, 2);
      }
    };

    const setLinks = function (payload) {
      const data = payload && payload.data ? payload.data : {};
      const fileLink = data.fileLink || "";
      const shortLink = data.shortLink || "";

      if (fileLinkEl) {
        fileLinkEl.value = fileLink;
      }
      if (shortLinkEl) {
        shortLinkEl.value = shortLink;
      }
      if (linksEl) {
        linksEl.classList.toggle("is-hidden", !fileLink && !shortLink);
      }
      if (shortLink) {
        try {
          localStorage.setItem(DOCS_LAST_SHORT_KEY, shortLink);
        } catch {}
      }
    };

    try {
      const lastShortLink = localStorage.getItem(DOCS_LAST_SHORT_KEY);
      if (lastShortLink && shortLinkEl) {
        shortLinkEl.value = lastShortLink;
      }
    } catch {}

    form.addEventListener("submit", async function (event) {
      event.preventDefault();

      const token = tokenInput ? tokenInput.value.trim() : "";
      const file = fileInputEl && fileInputEl.files ? fileInputEl.files[0] : null;

      if (!token) {
        setStatus("Missing token", "error");
        setJson({ error: "Add your API token before testing." });
        showToast("API token required", "error");
        return;
      }

      if (!file) {
        setStatus("Missing file", "error");
        setJson({ error: "Choose a file before testing the upload endpoint." });
        showToast("File required", "error");
        return;
      }

      const formData = new FormData(form);

      if (submit) {
        submit.disabled = true;
      }
      if (submitLabel) {
        submitLabel.textContent = "Uploading...";
      }

      setStatus("Uploading...", "loading");

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "x-api-token": token,
          },
          body: formData,
        });

        const payload = await response.json().catch(function () {
          return { error: "The server returned a non-JSON response." };
        });

        setJson(payload);

        if (!response.ok) {
          setStatus("Upload failed", "error");
          if (linksEl) {
            linksEl.classList.add("is-hidden");
          }
          showToast("API upload failed", "error");
          return;
        }

        setLinks(payload);
        setStatus("Upload passed", "success");
        showToast("API upload succeeded");

        if (resultRoot) {
          resultRoot.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
      } catch (error) {
        setStatus("Network error", "error");
        setJson({ error: error && error.message ? error.message : "Request failed." });
        if (linksEl) {
          linksEl.classList.add("is-hidden");
        }
        showToast("API request failed", "error");
      } finally {
        if (submit) {
          submit.disabled = false;
        }
        if (submitLabel) {
          submitLabel.textContent = "Test Upload";
        }
      }
    });
  });

  // Interactive Health Checker
  document.querySelectorAll("[data-api-health-check]").forEach(function (button) {
    const endpoint = button.getAttribute("data-endpoint") || "/api/health";
    const statusEl = document.querySelector("[data-api-health-status]");
    const latencyEl = document.querySelector("[data-api-health-latency]");
    const timeEl = document.querySelector("[data-api-health-time]");
    const jsonEl = document.querySelector("[data-api-health-json]");

    button.addEventListener("click", async function () {
      button.disabled = true;
      if (statusEl) {
        statusEl.textContent = "Checking...";
      }

      const startedAt = window.performance && window.performance.now
        ? window.performance.now()
        : Date.now();

      try {
        const response = await fetch(endpoint, { method: "GET" });
        const payload = await response.json();
        const endedAt = window.performance && window.performance.now
          ? window.performance.now()
          : Date.now();
        const duration = Math.max(1, Math.round(endedAt - startedAt));

        if (jsonEl) {
          jsonEl.textContent = JSON.stringify(payload, null, 2);
        }

        if (statusEl) {
          statusEl.textContent = response.ok && payload.ok ? "Online" : "Issue detected";
        }

        if (latencyEl) {
          latencyEl.textContent = duration + " ms";
        }

        if (timeEl) {
          timeEl.textContent = payload.time || "No timestamp returned";
        }

        showToast(response.ok ? "API is online" : "Health check returned an error", response.ok ? "" : "error");
      } catch (error) {
        if (statusEl) {
          statusEl.textContent = "Offline";
        }
        if (latencyEl) {
          latencyEl.textContent = "Request failed";
        }
        if (timeEl) {
          timeEl.textContent = "No response";
        }
        if (jsonEl) {
          jsonEl.textContent = JSON.stringify(
            { error: error && error.message ? error.message : "Health check failed." },
            null,
            2
          );
        }
        showToast("API health check failed", "error");
      } finally {
        button.disabled = false;
      }
    });
  });

  // Global Keyboard Shortcuts
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      const recent = document.querySelector("[data-recent-overlay]");
      if (recent) {
        recent.classList.remove("is-open");
      }
    }
  });

  // Dismiss Card Animation
  document.querySelectorAll("[data-dismiss-card]").forEach(function (button) {
    button.addEventListener("click", function () {
      const card = button.closest(".success-modal");
      if (card) {
        card.classList.add("is-dismissed");
      }
      window.setTimeout(function () {
        window.location.href = "/";
      }, 230);
    });
  });

  // Post-Upload Auto Registration in Recent Uploads
  if (resultData) {
    addRecentUpload({
      fileName: resultData.getAttribute("data-file-name"),
      embedLink: resultData.getAttribute("data-embed-link"),
      shortLink: resultData.getAttribute("data-short-link"),
      directLink: resultData.getAttribute("data-direct-link"),
    });
  }

  // Initial Form Error Toast
  if (formError && !formError.classList.contains("is-hidden")) {
    const message = formError.textContent.trim();
    showToast(message || "Upload failed", "error");
  }

  // Scroll Reveal Observer
  if ("IntersectionObserver" in window && revealItems.length) {
    const observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12 }
    );

    revealItems.forEach(function (item) {
      observer.observe(item);
    });
  } else {
    revealItems.forEach(function (item) {
      item.classList.add("is-visible");
    });
  }

  // Initialize Page State
  validateSlug();
  updateLivePreview();
  renderQrPlaceholder();
  root.classList.add("js-ready");
})();
