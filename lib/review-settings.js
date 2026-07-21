const express = require("express");
const settings = require("./settings");
const { STYLES, STYLE_LIST } = require("./styles");
const audit = require("./audit");

// Keys stripped from GET responses (credentials, infra, security-adjacent)
const REDACT_KEYS = new Set([
    "twilioAccountSid", "twilioAuthToken", "twilioPhoneNumber", "twilioMessagingServiceSid",
    "twilioWhatsappNumber", "twilioWhatsappMessagingServiceSid",
    "contentTemplates",
    "openaiApiKey", "modelOrchestrator", "modelVisionLight", "modelImageGen", "modelSmartReply", "modelRefAnalysis",
    "printRelayKey", "customBrands", "usageOverrides", "dubApiKey",
    "adminPhones", // security-adjacent — contains real phone numbers
]);

// Keys blocked from POST payloads (sensitive + event switching)
const BLOCKED_WRITE_KEYS = new Set([
    ...REDACT_KEYS,
    "eventName", // complex side effects — only via main dashboard
]);

function sanitizeSettings(obj) {
    const clean = { ...obj };
    for (const key of REDACT_KEYS) delete clean[key];
    return clean;
}

function sanitizePayload(body) {
    const clean = { ...body };
    for (const key of BLOCKED_WRITE_KEYS) delete clean[key];
    return clean;
}

// ── Routes ─────────────────────────────────────────────────────────────────

function mountReviewSettings(router, requireReviewAuth) {

    // Mobile settings page
    router.get("/settings", requireReviewAuth, (_req, res) => {
        res.type("html").send(buildMobileSettingsHtml());
    });

    // Get sanitized settings
    router.get("/api/settings", requireReviewAuth, (_req, res) => {
        const all = settings.getAll();
        // getAll() shallow-spreads overrides, so event profiles with a partial
        // messages object would drop uncustomized keys. Merge with defaults
        // (same behavior as getMsg() used by the SMS pipeline).
        all.messages = { ...settings.DEFAULTS.messages, ...(all.messages || {}) };
        res.json(sanitizeSettings(all));
    });

    // Save settings (with audit + auto-approve side effect)
    router.post("/api/settings", requireReviewAuth, express.json(), async (req, res) => {
        try {
            // Guard: reject if active event changed since mobile loaded settings
            const targetEvent = req.body._forEvent;
            if (targetEvent && targetEvent !== settings.get("eventName")) {
                return res.status(409).json({
                    error: "Event changed",
                    currentEvent: settings.get("eventName"),
                });
            }

            const changes = sanitizePayload(req.body);
            delete changes._forEvent;
            if (Object.keys(changes).length === 0) {
                return res.json(sanitizeSettings(settings.getAll()));
            }

            // Capture before values for audit
            const beforeValues = {};
            for (const key of Object.keys(changes)) {
                const current = settings.get(key);
                if (current !== undefined) beforeValues[key] = current;
            }

            settings.update(changes);

            // Audit logging
            const afterValues = {};
            let hasChanges = false;
            for (const key of Object.keys(beforeValues)) {
                const newVal = settings.get(key);
                if (JSON.stringify(newVal) !== JSON.stringify(beforeValues[key])) {
                    afterValues[key] = newVal;
                    hasChanges = true;
                }
            }
            if (hasChanges) {
                const changedBefore = {};
                for (const key of Object.keys(afterValues)) changedBefore[key] = beforeValues[key];
                audit.logSettingsChange("review-pin", settings.get("eventName"), changedBefore, afterValues).catch(err => {
                    console.error("📝 Audit log error:", err.message);
                });
            }

            // Review mode toggle only affects NEW items going forward.
            // Pending items already in review stay there until a human
            // explicitly approves or rejects them. See matching note in
            // lib/dashboard.js /api/settings.

            res.json(sanitizeSettings(settings.getAll()));
        } catch (err) {
            console.error("❌ Review settings save error:", err);
            res.status(500).json({ error: "Failed to save settings" });
        }
    });

    // Available files for dropdowns
    router.get("/api/settings/files", requireReviewAuth, (_req, res) => {
        // Return ALL styles (built-in + custom), not just active ones,
        // so disabled styles still appear in toggles and can be re-enabled.
        const styles = STYLE_LIST.map(key => ({ key, name: STYLES[key].name || key }));
        const customStyles = settings.get("customStyles") || {};
        for (const [key, val] of Object.entries(customStyles)) {
            styles.push({ key, name: val.name || key });
        }
        const customBrands = settings.get("customBrands") || {};
        const brands = Object.entries(customBrands).map(([key, val]) => ({ key, name: val.name || key }));
        res.json({
            templates: settings.listTemplates(),
            videos: settings.listVideos(),
            events: settings.listEvents(),
            styles,
            brands,
        });
    });
}

// ── Mobile Settings HTML ───────────────────────────────────────────────────

function buildMobileSettingsHtml() {
return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<script>(function(){var t=localStorage.getItem('twilio-theme')||'dark';document.documentElement.setAttribute('data-theme',t)})()</script>
<link rel="icon" type="image/svg+xml" href="/assets/icon-twilio-bug-red.svg">
<link rel="stylesheet" href="/assets/twilio-brand.css">
<title>Settings — Twilio Photobooth</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--th-bg); color: var(--th-text-dim); min-height: 100vh;
    padding: 20px 16px; font-family: 'Twilio Sans Text', -apple-system, system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 600px; margin: 0 auto; padding-bottom: 80px; }

  /* Header */
  .header {
    display: flex; justify-content: space-between; align-items: center;
    margin-bottom: 20px; padding-bottom: 14px;
    border-bottom: 1px solid var(--th-card-border); flex-wrap: wrap; gap: 10px;
  }
  .header h1 {
    font-size: 20px; font-weight: 700; color: var(--th-text);
    display: flex; align-items: center; gap: 8px;
  }
  .header-btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 8px 14px; border-radius: 8px; font-size: 13px; font-weight: 600;
    color: var(--th-text-dim); text-decoration: none;
    background: var(--th-card); border: 1px solid var(--th-card-border);
    transition: all .15s; cursor: pointer; min-height: 44px;
  }
  .header-btn:hover { border-color: var(--blue-300); color: var(--blue-300); }
  .header-btn svg { width: 16px; height: 16px; }

  /* Accordion */
  .sg-group { margin-bottom: 8px; }
  .sg-group:last-of-type { margin-bottom: 0; }
  .sg-group-header {
    font-family: 'Twilio Sans Mono', monospace;
    font-size: 11px; font-weight: 700; color: var(--th-text-muted);
    text-transform: uppercase; letter-spacing: 2px;
    padding: 10px 0; display: flex; align-items: center; gap: 14px;
    cursor: pointer; user-select: none; transition: color .15s;
    min-height: 44px;
  }
  .sg-group-header:hover { color: var(--th-text-dim); }
  .sg-group-header::before {
    content: ''; display: inline-block; width: 6px; height: 6px;
    border-right: 2px solid currentColor; border-bottom: 2px solid currentColor;
    transform: rotate(-45deg); transition: transform .2s ease; flex-shrink: 0;
  }
  .sg-group.open .sg-group-header::before { transform: rotate(45deg); }
  .sg-group-header::after {
    content: ''; flex: 1; height: 1px;
    background: linear-gradient(to right, var(--th-card-border), transparent);
  }
  .sg-group-body { display: none; padding-top: 8px; padding-bottom: 12px; }
  .sg-group.open .sg-group-body { display: block; }

  /* Color-coded borders */
  .sg-group:nth-child(1) .sg h4 { border-left-color: var(--brand-red); }
  .sg-group:nth-child(2) .sg h4 { border-left-color: var(--blue-400); }
  .sg-group:nth-child(3) .sg h4 { border-left-color: var(--blue-500); }
  .sg-group:nth-child(4) .sg h4 { border-left-color: var(--blue-300); }
  .sg-group:nth-child(5) .sg h4 { border-left-color: var(--brand-red); }
  .sg-group:nth-child(6) .sg h4 { border-left-color: var(--blue-400); }
  .sg-group:nth-child(7) .sg h4 { border-left-color: var(--blue-500); }
  .sg-group:nth-child(8) .sg h4 { border-left-color: var(--red-400); }

  /* Setting cards */
  .sg {
    background: var(--th-card-gradient); border: 1px solid var(--th-card-border);
    border-radius: 16px; padding: 20px; margin-bottom: 14px;
    transition: all .2s ease; box-shadow: 0 2px 8px var(--th-card-shadow);
  }
  .sg h4 {
    font-family: 'Twilio Sans Display', sans-serif;
    font-size: 15px; font-weight: 800; color: var(--th-text);
    margin-bottom: 18px; padding-left: 12px;
    border-left: 3px solid var(--brand-red);
    line-height: 1.1; padding-top: 2px; padding-bottom: 2px; letter-spacing: 0.02em;
  }

  /* Setting fields */
  .sf { margin-bottom: 18px; }
  .sf:last-child { margin-bottom: 0; }
  .sf label {
    display: block; font-size: 13px; color: var(--th-text-muted);
    margin-bottom: 8px; font-weight: 400; letter-spacing: 0.01em;
  }
  .sf input[type="text"], .sf input[type="number"], .sf select, .sf textarea {
    width: 100%; padding: 12px 14px; border: 1px solid var(--th-input-border);
    border-radius: 8px; background: var(--th-input); color: var(--th-text);
    font-size: 16px; font-family: inherit; transition: border .15s;
    min-height: 44px;
  }
  .sf input:focus, .sf select:focus, .sf textarea:focus {
    outline: none; border-color: var(--blue-400);
    box-shadow: 0 0 0 3px rgba(33,136,239,0.08);
  }
  .sf textarea { min-height: 80px; resize: vertical; }
  .sf .toggle-row {
    display: flex; align-items: center; justify-content: space-between;
    min-height: 44px; gap: 12px;
  }
  .sf .toggle-label { font-size: 14px; color: var(--th-text-dim); }

  /* Toggle switch */
  .toggle {
    position: relative; width: 50px; height: 28px; flex-shrink: 0;
  }
  .toggle input { opacity: 0; width: 0; height: 0; }
  .toggle .slider {
    position: absolute; inset: 0; cursor: pointer;
    background: var(--th-input-border); border-radius: 28px; transition: .2s;
  }
  .toggle .slider::before {
    content: ''; position: absolute; height: 22px; width: 22px;
    left: 3px; bottom: 3px; background: #fff;
    border-radius: 50%; transition: .2s;
  }
  .toggle input:checked + .slider { background: var(--blue-400); }
  .toggle input:checked + .slider::before { transform: translateX(22px); }

  /* Sticky save bar */
  .save-bar {
    position: fixed; bottom: 0; left: 0; right: 0;
    padding: 14px 16px; background: var(--th-bg);
    border-top: 1px solid var(--th-card-border);
    display: flex; gap: 10px; justify-content: center; z-index: 50;
  }
  .save-bar .btn {
    border: none; border-radius: 8px; padding: 14px 32px; cursor: pointer;
    font-size: 15px; font-weight: 700; color: #fff; transition: all .15s;
    min-height: 48px; flex: 1; max-width: 300px;
  }
  .save-bar .btn-save { background: var(--blue-400); }
  .save-bar .btn-save:hover { background: var(--blue-500); }
  .save-bar .btn-save:disabled { opacity: .5; cursor: not-allowed; }

  /* Toast */
  .toast {
    position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
    padding: 12px 24px; border-radius: 8px; font-size: 14px; font-weight: 600;
    color: #fff; z-index: 200; opacity: 0; transition: opacity .3s;
    pointer-events: none;
  }
  .toast.show { opacity: 1; }
  .toast.success { background: var(--blue-400); }
  .toast.error { background: var(--brand-red); }

  /* Confirmation modal */
  .confirm-modal {
    display: none; position: fixed; inset: 0;
    background: rgba(0,0,0,.7); z-index: 300;
    align-items: center; justify-content: center;
    padding: 20px; animation: cm-fade .15s ease-out;
  }
  .confirm-modal.show { display: flex; }
  @keyframes cm-fade { from { opacity: 0; } to { opacity: 1; } }
  .confirm-panel {
    background: var(--th-card); border: 1px solid var(--th-card-border);
    border-radius: 16px; padding: 24px; max-width: 420px; width: 100%;
    box-shadow: 0 12px 40px rgba(0,0,0,.5);
  }
  .confirm-title {
    font-family: 'Twilio Sans Display', sans-serif;
    font-size: 18px; font-weight: 800; color: var(--th-text);
    margin-bottom: 12px;
  }
  .confirm-summary {
    font-size: 13px; color: var(--th-text-dim); line-height: 1.5;
    max-height: 240px; overflow-y: auto;
    background: var(--th-bg); border: 1px solid var(--th-card-border);
    border-radius: 8px; padding: 12px 14px; margin-bottom: 16px;
  }
  .confirm-summary ul { list-style: none; padding: 0; margin: 0; }
  .confirm-summary li { padding: 4px 0; border-bottom: 1px solid var(--th-card-border); font-family: 'Twilio Sans Mono', monospace; font-size: 12px; }
  .confirm-summary li:last-child { border-bottom: none; }
  .confirm-summary .no-changes { color: var(--th-text-muted); font-style: italic; }
  .confirm-actions {
    display: flex; gap: 10px; justify-content: flex-end;
  }
  .confirm-actions .btn {
    border: none; border-radius: 8px; padding: 12px 20px;
    font-size: 14px; font-weight: 700; cursor: pointer;
    font-family: inherit; min-height: 44px;
    transition: all .15s;
  }
  .btn-cancel {
    background: transparent; color: var(--th-text-dim);
    border: 1px solid var(--th-card-border) !important;
  }
  .btn-cancel:hover { border-color: var(--th-text-muted) !important; color: var(--th-text); }
  .btn-confirm {
    background: var(--blue-400); color: #fff;
  }
  .btn-confirm:hover { background: var(--blue-500); }
  .btn-confirm:disabled { opacity: .5; cursor: not-allowed; }

  /* Responsive */
  @media (max-width: 400px) {
    body { padding: 16px 12px; }
    .sg { padding: 16px; }
  }
</style>
</head>
<body>

<div class="wrap">
  <div class="header">
    <h1>Settings</h1>
    <a href="/review/queue" class="header-btn" id="queueBtn" style="display:none">
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 4l-5 6 5 6"/><path d="M3 10h14"/></svg>
      Queue
    </a>
  </div>

  <div id="settingsBody">Loading...</div>
</div>

<div class="save-bar">
  <button class="btn btn-save" id="saveBtn" onclick="saveSettings()">Save Changes</button>
</div>

<div class="toast" id="toast"></div>

<div class="confirm-modal" id="confirmModal" onclick="closeConfirm(event)">
  <div class="confirm-panel" onclick="event.stopPropagation()">
    <div class="confirm-title">Save changes?</div>
    <div class="confirm-summary" id="confirmSummary">Loading…</div>
    <div class="confirm-actions">
      <button class="btn btn-cancel" onclick="closeConfirm()">Cancel</button>
      <button class="btn btn-confirm" id="confirmBtn" onclick="confirmSave()">Save</button>
    </div>
  </div>
</div>

<script>
var currentSettings = {};
var fileOptions = {};
var loadedEventName = '';

// ── Toast ──────────────────────────────────────────────────────────────────
function showToast(msg, type) {
  var el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast ' + type + ' show';
  setTimeout(function() { el.className = 'toast'; }, 2500);
}

// ── Load ───────────────────────────────────────────────────────────────────
function loadSettings() {
  document.getElementById('settingsBody').textContent = 'Loading...';
  var opts = { credentials: 'same-origin' };
  Promise.all([
    fetch('/review/api/settings', opts),
    fetch('/review/api/settings/files', opts)
  ]).then(function(results) {
    var sRes = results[0], fRes = results[1];
    if (sRes.status === 401 || fRes.status === 401) {
      document.getElementById('settingsBody').textContent = 'Auth expired (401) — redirecting...';
      window.location.href = '/review';
      return;
    }
    if (!sRes.ok || !fRes.ok) {
      document.getElementById('settingsBody').textContent = 'HTTP error: ' + sRes.status + ' / ' + fRes.status;
      return;
    }
    return Promise.all([sRes.json(), fRes.json()]);
  }).then(function(data) {
    if (!data) return;
    currentSettings = data[0];
    fileOptions = data[1];
    loadedEventName = currentSettings.eventName || '';
    renderSettings();
  }).catch(function(err) {
    document.getElementById('settingsBody').textContent = 'Load failed: ' + (err.message || err);
  });
}

// ── Render ─────────────────────────────────────────────────────────────────
function renderSettings() {
  // Preserve accordion open/closed state across re-renders
  var openSections = {};
  document.querySelectorAll('.sg-group').forEach(function(el, i) {
    openSections[i] = el.classList.contains('open');
  });
  var isReRender = Object.keys(openSections).length > 0;

  var s = currentSettings;
  var styles = fileOptions.styles || [];
  var events = fileOptions.events || [];
  var templates = fileOptions.templates || [];
  var videos = fileOptions.videos || [];

  // Build style toggle HTML
  var styleTogglesHtml = styles.map(function(st) {
    var disabled = (s.disabledStyles || []).indexOf(st.key) !== -1;
    return '<div class="sf"><div class="toggle-row">'
      + '<span class="toggle-label">' + esc(st.name || st.key) + '</span>'
      + '<label class="toggle"><input type="checkbox" data-style-key="' + esc(st.key) + '"'
      + (disabled ? '' : ' checked') + '><span class="slider"></span></label>'
      + '</div></div>';
  }).join('');

  // Build style prompt overrides HTML
  var styleOverrides = s.stylePromptOverrides || {};
  var stylePromptsHtml = styles.map(function(st) {
    return '<div class="sf"><label>' + esc(st.name || st.key) + '</label>'
      + '<textarea data-style-prompt-key="' + esc(st.key) + '" placeholder="Leave blank for default prompt">' + esc(styleOverrides[st.key] || '') + '</textarea></div>';
  }).join('');

  // Build custom style prompts HTML
  var customStylesObj = s.customStyles || {};
  var customStyleKeys = Object.keys(customStylesObj);
  var customStylePromptsHtml = customStyleKeys.map(function(key) {
    var cs = customStylesObj[key];
    return '<div class="sf"><label>' + esc(cs.name || key) + '</label>'
      + '<textarea data-custom-style-key="' + esc(key) + '">' + esc(cs.prompt || '') + '</textarea></div>';
  }).join('');

  // Build brand toggles HTML
  var brands = fileOptions.brands || [];
  var brandTogglesHtml = brands.map(function(br) {
    var disabled = (s.disabledBrands || []).indexOf(br.key) !== -1;
    return '<div class="sf"><div class="toggle-row">'
      + '<span class="toggle-label">' + esc(br.name || br.key) + '</span>'
      + '<label class="toggle"><input type="checkbox" data-brand-key="' + esc(br.key) + '"'
      + (disabled ? '' : ' checked') + '><span class="slider"></span></label>'
      + '</div></div>';
  }).join('');

  // Build brand prompt overrides HTML
  var brandOverrides = s.brandPromptOverrides || {};
  var brandPromptsHtml = brands.map(function(br) {
    return '<div class="sf"><label>' + esc(br.name || br.key) + '</label>'
      + '<textarea data-brand-prompt-key="' + esc(br.key) + '" placeholder="Leave blank for default">' + esc(brandOverrides[br.key] || '') + '</textarea></div>';
  }).join('');

  // Build background choices HTML
  var bgChoices = s.backgroundChoices || [];
  var bgChoicesHtml = bgChoices.map(function(bg, i) {
    return '<div class="sf"><label>' + esc(bg.name || bg.key || ('Background ' + (i+1))) + '</label>'
      + '<textarea data-bg-idx="' + i + '">' + esc(bg.prompt || '') + '</textarea></div>';
  }).join('');

  // Build messages HTML
  var msgKeys = Object.keys(s.messages || {});
  var msgsHtml = msgKeys.map(function(k) {
    return '<div class="sf"><label>' + esc(friendlyMsgLabel(k)) + '</label>'
      + '<textarea data-msg-key="' + esc(k) + '">' + esc(s.messages[k] || '') + '</textarea></div>';
  }).join('');

  document.getElementById('settingsBody').innerHTML = ''
    // ── Event & Operations ──────────────────────────────────────────────────
    + '<div class="sg-group">'
    + '<div class="sg-group-header" onclick="this.parentElement.classList.toggle(\\'open\\')">Event &amp; Operations</div>'
    + '<div class="sg-group-body">'
    + '<div class="sg"><h4>Event</h4>'
    + '<div class="sf"><label>Current Event</label>'
    + '<select id="sEventDisplay" disabled>'
    + events.map(function(e) { return '<option' + (e === s.eventName ? ' selected' : '') + '>' + esc(e) + '</option>'; }).join('')
    + '</select>'
    + '<div style="font-size:11px;color:var(--th-text-muted);margin-top:6px">Event switching is only available from the main dashboard.</div>'
    + '</div>'
    + '<div class="sf"><label>Max Prints Per User</label><input type="number" id="sMaxPrints" min="1" max="100" value="' + (s.maxPrints || 1) + '">'
    + '<div style="font-size:11px;color:var(--th-text-muted);margin-top:6px">Set to <strong>100</strong> for unlimited — disables quota enforcement and hides remaining-count messages in SMS.</div>'
    + '</div>'
    + '<div class="sf"><label>Attendee Language</label><select id="sLanguageMode">'
    + '<option value="en"' + ((s.languageMode || 'en') === 'en' ? ' selected' : '') + '>English</option>'
    + '<option value="pt_BR"' + (s.languageMode === 'pt_BR' ? ' selected' : '') + '>Português (Brasil)</option>'
    + '<option value="ask"' + (s.languageMode === 'ask' ? ' selected' : '') + '>Ask each attendee</option>'
    + '</select><div style="font-size:11px;color:var(--th-text-muted);margin-top:6px">New conversations use this immediately. Active flows keep their original language.</div></div>'
    + '</div>'
    + '<div class="sg"><h4>Queue</h4>'
    + '<div class="sf"><div class="toggle-row"><span class="toggle-label">Pause Queue</span>'
    + '<label class="toggle"><input type="checkbox" id="sQueuePaused"' + (s.queuePaused ? ' checked' : '') + '><span class="slider"></span></label></div></div>'
    + '<div class="sf"><label>Max Concurrent Generations</label><input type="number" id="sMaxGen" min="1" max="20" value="' + (s.maxConcurrentGeneration || 3) + '"></div>'
    + '</div>'
    + '</div></div>'

    // ── Styles & Art ────────────────────────────────────────────────────────
    + '<div class="sg-group">'
    + '<div class="sg-group-header" onclick="this.parentElement.classList.toggle(\\'open\\')">Styles &amp; Art</div>'
    + '<div class="sg-group-body">'
    + '<div class="sg"><h4>Default Style</h4>'
    + '<div class="sf"><label>Style</label><select id="sDefaultStyle">'
    + styles.map(function(st) { return '<option value="' + esc(st.key) + '"' + (st.key === s.defaultStyle ? ' selected' : '') + '>' + esc(st.name || st.key) + '</option>'; }).join('')
    + '</select></div>'
    + '<div class="sf"><label>Multi-Subject Photos</label><select id="sMultiSubject">'
    + '<option value="normal"' + (s.multiSubjectMode === 'normal' ? ' selected' : '') + '>Normal (generate as usual)</option>'
    + '<option value="caricature"' + (s.multiSubjectMode === 'caricature' ? ' selected' : '') + '>Caricature (exaggerated style)</option>'
    + '<option value="reject"' + (s.multiSubjectMode === 'reject' ? ' selected' : '') + '>Reject (ask for solo selfie)</option>'
    + '</select></div>'
    + '</div>'
    + '<div class="sg"><h4>Style Toggles</h4>' + styleTogglesHtml + '</div>'
    + '<div class="sg"><h4>Style Prompt Overrides</h4>'
    + '<div style="font-size:11px;color:var(--th-text-muted);margin-bottom:14px">Override the generation prompt for individual styles. Leave blank to use the default.</div>'
    + stylePromptsHtml + '</div>'
    + (customStyleKeys.length ? '<div class="sg"><h4>Custom Style Prompts</h4>' + customStylePromptsHtml + '</div>' : '')
    + '</div></div>'

    // ── Brands ──────────────────────────────────────────────────────────────
    + (brands.length ? '<div class="sg-group">'
    + '<div class="sg-group-header" onclick="this.parentElement.classList.toggle(\\'open\\')">Brands</div>'
    + '<div class="sg-group-body">'
    + '<div class="sg"><h4>Brand Menu</h4>'
    + '<div class="sf"><div class="toggle-row"><span class="toggle-label">Show Brand Menu to Users</span>'
    + '<label class="toggle"><input type="checkbox" id="sEnableBrandMenu"' + (s.enableBrandMenu ? ' checked' : '') + '><span class="slider"></span></label></div></div>'
    + '</div>'
    + '<div class="sg"><h4>Brand Toggles</h4>' + brandTogglesHtml + '</div>'
    + '<div class="sg"><h4>Brand Prompt Overrides</h4>'
    + '<div style="font-size:11px;color:var(--th-text-muted);margin-bottom:14px">Override the prompt for specific brands. Leave blank for the brand default.</div>'
    + brandPromptsHtml + '</div>'
    + '</div></div>' : '')

    // ── Backgrounds ─────────────────────────────────────────────────────────
    + '<div class="sg-group">'
    + '<div class="sg-group-header" onclick="this.parentElement.classList.toggle(\\'open\\')">Backgrounds</div>'
    + '<div class="sg-group-body">'
    + '<div class="sg"><h4>Background Menu</h4>'
    + '<div class="sf"><div class="toggle-row"><span class="toggle-label">Show Background Menu to Users</span>'
    + '<label class="toggle"><input type="checkbox" id="sEnableBgMenu"' + (s.enableBackgroundMenu ? ' checked' : '') + '><span class="slider"></span></label></div></div>'
    + '</div>'
    + '<div class="sg"><h4>Default Background Prompt</h4>'
    + '<div class="sf"><textarea id="sPromptBackground" rows="3">' + esc(s.promptBackground || '') + '</textarea></div>'
    + '</div>'
    + (bgChoices.length ? '<div class="sg"><h4>Background Choices</h4>'
    + '<div style="font-size:11px;color:var(--th-text-muted);margin-bottom:14px">Edit the prompt for each background choice.</div>'
    + bgChoicesHtml + '</div>' : '')
    + '</div></div>'

    // ── Delivery & Display ──────────────────────────────────────────────────
    + '<div class="sg-group">'
    + '<div class="sg-group-header" onclick="this.parentElement.classList.toggle(\\'open\\')">Delivery &amp; Display</div>'
    + '<div class="sg-group-body">'
    + '<div class="sg"><h4>Delivery</h4>'
    + '<div class="sf"><div class="toggle-row"><span class="toggle-label">Enable Printing</span>'
    + '<label class="toggle"><input type="checkbox" id="sEnablePrinting"' + (s.enablePrinting ? ' checked' : '') + '><span class="slider"></span></label></div></div>'
    + '</div>'
    + '<div class="sg"><h4>Review</h4>'
    + '<div class="sf"><label>Review Mode</label><select id="sReviewMode">'
    + '<option value="off"' + (s.reviewMode === 'off' ? ' selected' : '') + '>Off</option>'
    + '<option value="human"' + (s.reviewMode === 'human' ? ' selected' : '') + '>Human</option>'
    + '<option value="ai"' + (s.reviewMode === 'ai' ? ' selected' : '') + '>AI</option>'
    + '</select></div>'
    + '<div class="sf"><label>Review PIN</label><input type="text" id="sReviewPin" maxlength="6" placeholder="4-6 digits" inputmode="numeric" pattern="[0-9]*" value="' + esc(s.reviewPin || '') + '" style="max-width:180px"></div>'
    + '<div class="sf"><label>Variants per Review (Human only)</label><select id="sVariantsPerReview">'
    + '<option value="1"' + ((s.variantsPerReview || 1) === 1 ? ' selected' : '') + '>1 (standard)</option>'
    + '<option value="2"' + ((s.variantsPerReview || 1) === 2 ? ' selected' : '') + '>2</option>'
    + '<option value="3"' + ((s.variantsPerReview || 1) === 3 ? ' selected' : '') + '>3 (pick best of 3)</option>'
    + '</select>'
    + '<div style="font-size:11px;color:var(--th-text-muted);margin-top:6px">When Review Mode is Human, generate N variants per photo. Reviewer picks the best one.</div>'
    + '</div>'
    + '<div class="sf"><label>Per-Variant Regeneration Limit</label><select id="sRegenerationLimit">'
    + '<option value="1"' + ((s.regenerationLimit || 2) === 1 ? ' selected' : '') + '>1</option>'
    + '<option value="2"' + ((s.regenerationLimit || 2) === 2 ? ' selected' : '') + '>2 (default)</option>'
    + '<option value="3"' + ((s.regenerationLimit || 2) === 3 ? ' selected' : '') + '>3</option>'
    + '<option value="4"' + ((s.regenerationLimit || 2) === 4 ? ' selected' : '') + '>4</option>'
    + '<option value="5"' + ((s.regenerationLimit || 2) === 5 ? ' selected' : '') + '>5</option>'
    + '</select>'
    + '<div style="font-size:11px;color:var(--th-text-muted);margin-top:6px">Maximum regenerations per variant before the button locks (safety cap).</div>'
    + '</div>'
    + '</div>'
    + '<div class="sg"><h4>Booth Display</h4>'
    + '<div class="sf"><label>Display Mode</label><select id="sBoothDisplayMode">'
    + '<option value="video"' + (s.boothDisplayMode === 'video' ? ' selected' : '') + '>Video</option>'
    + '<option value="static"' + (s.boothDisplayMode === 'static' ? ' selected' : '') + '>Static Page</option>'
    + '<option value="none"' + (s.boothDisplayMode === 'none' ? ' selected' : '') + '>None (Photo Book Only)</option>'
    + '</select></div>'
    + '<div class="sf"><label>Headline</label><input type="text" id="sBoothHeadline" value="' + esc(s.boothHeadline || '') + '"></div>'
    + '<div class="sf"><label>Subline</label><input type="text" id="sBoothSubline" value="' + esc(s.boothSubline || '') + '"></div>'
    + '</div>'
    + '</div></div>'

    // ── Engagement ──────────────────────────────────────────────────────────
    + '<div class="sg-group">'
    + '<div class="sg-group-header" onclick="this.parentElement.classList.toggle(\\'open\\')">Engagement</div>'
    + '<div class="sg-group-body">'
    + '<div class="sg"><h4>Lead Capture</h4>'
    + '<div class="sf"><label>Lead Capture Mode</label><select id="sLeadCapture">'
    + '<option value="disabled"' + (s.leadCaptureMode === 'disabled' ? ' selected' : '') + '>Disabled</option>'
    + '<option value="before"' + (s.leadCaptureMode === 'before' ? ' selected' : '') + '>Before Portrait</option>'
    + '<option value="after"' + (s.leadCaptureMode === 'after' ? ' selected' : '') + '>After Portrait</option>'
    + '</select></div></div>'
    + '<div class="sg"><h4>Promo &amp; NPS</h4>'
    + '<div class="sf"><div class="toggle-row"><span class="toggle-label">Promo Message</span>'
    + '<label class="toggle"><input type="checkbox" id="sEnablePromo"' + (s.enablePromoMessage ? ' checked' : '') + '><span class="slider"></span></label></div></div>'
    + '<div class="sf"><label>Promo Text</label><textarea id="sPromoMessage">' + esc(s.promoMessage || '') + '</textarea></div>'
    + '<div class="sf"><div class="toggle-row"><span class="toggle-label">NPS Survey</span>'
    + '<label class="toggle"><input type="checkbox" id="sEnableNps"' + (s.enableNps ? ' checked' : '') + '><span class="slider"></span></label></div></div>'
    + '</div>'
    + '</div></div>'

    // ── Prompt Tweaks ───────────────────────────────────────────────────────
    + '<div class="sg-group">'
    + '<div class="sg-group-header" onclick="this.parentElement.classList.toggle(\\'open\\')">Prompt Tweaks</div>'
    + '<div class="sg-group-body">'
    + '<div class="sg"><h4>Generation Prompts</h4>'
    + '<div class="sf"><label>User Directive</label><textarea id="sPromptDirective" rows="2">' + esc(s.promptUserDirective || '') + '</textarea></div>'
    + '<div class="sf"><label>Preserve Instructions</label><textarea id="sPromptPreserve" rows="3">' + esc(s.promptPreserve || '') + '</textarea></div>'
    + '<div class="sf"><label>Composition</label><textarea id="sPromptComposition" rows="3">' + esc(s.promptComposition || '') + '</textarea></div>'
    + '</div>'
    + '<div class="sg"><h4>Brand Prompts</h4>'
    + '<div class="sf"><label>Brand Preserve Instructions</label><textarea id="sPromptPreserveBrand" rows="3">' + esc(s.promptPreserveBrand || '') + '</textarea></div>'
    + '<div class="sf"><label>Brand Instruction (logos/text)</label><textarea id="sPromptBrandInstruction" rows="3">' + esc(s.promptBrandInstruction || '') + '</textarea></div>'
    + '<div class="sf"><label>Global Brand Prompt</label><textarea id="sBrandPrompt" rows="2">' + esc(s.brandPrompt || '') + '</textarea></div>'
    + '</div>'
    + '</div></div>'

    // ── Messages ────────────────────────────────────────────────────────────
    + '<div class="sg-group">'
    + '<div class="sg-group-header" onclick="this.parentElement.classList.toggle(\\'open\\')">Messages</div>'
    + '<div class="sg-group-body">'
    + '<div class="sg"><h4>SMS Templates</h4>' + msgsHtml + '</div>'
    + '</div></div>';

  // Show Queue button only when human review is active
  var queueBtn = document.getElementById('queueBtn');
  if (queueBtn) queueBtn.style.display = s.reviewMode === 'human' ? '' : 'none';

  // Restore accordion state (on re-render) or open first section (on initial render)
  document.querySelectorAll('.sg-group').forEach(function(el, i) {
    if (isReRender ? openSections[i] : i === 0) el.classList.add('open');
  });
}

// ── Save ───────────────────────────────────────────────────────────────────
var _pendingPayload = null;

function saveSettings() {
  var payload = buildPayload();
  var summary = summarizeChanges(payload);
  _pendingPayload = payload;
  showConfirmModal(summary);
}

function showConfirmModal(summary) {
  var modal = document.getElementById('confirmModal');
  var sum = document.getElementById('confirmSummary');
  var confirmBtn = document.getElementById('confirmBtn');
  // Build summary with safe DOM APIs (no innerHTML)
  sum.replaceChildren();
  if (summary.count === 0) {
    var emptyDiv = document.createElement('div');
    emptyDiv.className = 'no-changes';
    emptyDiv.textContent = 'No changes to save.';
    sum.appendChild(emptyDiv);
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Save';
  } else {
    var ul = document.createElement('ul');
    summary.items.forEach(function(line) {
      var li = document.createElement('li');
      li.textContent = line;
      ul.appendChild(li);
    });
    sum.appendChild(ul);
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Save ' + summary.count + ' change' + (summary.count === 1 ? '' : 's');
  }
  modal.classList.add('show');
}

function closeConfirm(e) {
  if (e && e.target && e.target.closest && e.target.closest('.confirm-panel')) return;
  document.getElementById('confirmModal').classList.remove('show');
  _pendingPayload = null;
}

function confirmSave() {
  if (!_pendingPayload) return;
  document.getElementById('confirmModal').classList.remove('show');
  var payload = _pendingPayload;
  _pendingPayload = null;
  performSave(payload);
}

// Diff the payload against currentSettings and return a list of human-readable
// change lines. Used to populate the confirmation modal. Does not attempt to
// be exhaustive — shows simple scalar changes verbatim, summarizes collections.
function summarizeChanges(payload) {
  var items = [];
  var ignoredKeys = { _forEvent: true };
  function label(key) {
    return key.replace(/([A-Z])/g, ' $1').replace(/^./, function(c) { return c.toUpperCase(); });
  }
  function shorten(val) {
    if (val == null || val === '') return '(empty)';
    var s = typeof val === 'string' ? val : JSON.stringify(val);
    return s.length > 40 ? s.slice(0, 37) + '…' : s;
  }
  for (var key in payload) {
    if (ignoredKeys[key]) continue;
    var oldVal = currentSettings[key];
    var newVal = payload[key];
    var same = JSON.stringify(oldVal) === JSON.stringify(newVal);
    if (same) continue;
    if (typeof newVal === 'object' && newVal !== null) {
      if (Array.isArray(newVal)) {
        items.push(label(key) + ': ' + ((oldVal && oldVal.length) || 0) + ' → ' + newVal.length + ' items');
      } else {
        var changedCount = 0;
        var oldObj = oldVal && typeof oldVal === 'object' ? oldVal : {};
        for (var k in newVal) {
          if (JSON.stringify(newVal[k]) !== JSON.stringify(oldObj[k])) changedCount++;
        }
        if (changedCount > 0) {
          items.push(label(key) + ': ' + changedCount + ' field' + (changedCount === 1 ? '' : 's') + ' changed');
        }
      }
    } else {
      items.push(label(key) + ': ' + shorten(oldVal) + ' → ' + shorten(newVal));
    }
  }
  return { count: items.length, items: items };
}

function buildPayload() {
  var payload = {};

  // Simple fields
  payload.maxPrints = parseInt(document.getElementById('sMaxPrints').value) || 1;
  payload.languageMode = document.getElementById('sLanguageMode').value;
  payload.queuePaused = document.getElementById('sQueuePaused').checked;
  payload.maxConcurrentGeneration = parseInt(document.getElementById('sMaxGen').value) || 3;
  payload.defaultStyle = document.getElementById('sDefaultStyle').value;
  payload.multiSubjectMode = document.getElementById('sMultiSubject').value;
  payload.enablePrinting = document.getElementById('sEnablePrinting').checked;
  payload.reviewMode = document.getElementById('sReviewMode').value;
  payload.reviewPin = document.getElementById('sReviewPin').value;
  var vpr = document.getElementById('sVariantsPerReview');
  if (vpr) payload.variantsPerReview = parseInt(vpr.value) || 1;
  var rgl = document.getElementById('sRegenerationLimit');
  if (rgl) payload.regenerationLimit = parseInt(rgl.value) || 2;
  payload.boothDisplayMode = document.getElementById('sBoothDisplayMode').value;
  payload.boothHeadline = document.getElementById('sBoothHeadline').value;
  payload.boothSubline = document.getElementById('sBoothSubline').value;
  payload.leadCaptureMode = document.getElementById('sLeadCapture').value;
  payload.enablePromoMessage = document.getElementById('sEnablePromo').checked;
  payload.promoMessage = document.getElementById('sPromoMessage').value;
  payload.enableNps = document.getElementById('sEnableNps').checked;

  // Style toggles — collect disabled styles
  var disabledStyles = [];
  document.querySelectorAll('[data-style-key]').forEach(function(cb) {
    if (!cb.checked) disabledStyles.push(cb.getAttribute('data-style-key'));
  });
  payload.disabledStyles = disabledStyles;

  // Style prompt overrides
  var stylePromptOverrides = {};
  document.querySelectorAll('[data-style-prompt-key]').forEach(function(el) {
    var val = el.value.trim();
    if (val) stylePromptOverrides[el.getAttribute('data-style-prompt-key')] = val;
  });
  payload.stylePromptOverrides = stylePromptOverrides;

  // Custom style prompts — merge updated prompt into existing custom style objects
  var customStyles = {};
  var existingCustom = currentSettings.customStyles || {};
  document.querySelectorAll('[data-custom-style-key]').forEach(function(el) {
    var key = el.getAttribute('data-custom-style-key');
    if (existingCustom[key]) {
      customStyles[key] = {};
      for (var p in existingCustom[key]) customStyles[key][p] = existingCustom[key][p];
      customStyles[key].prompt = el.value;
    }
  });
  if (Object.keys(customStyles).length) payload.customStyles = customStyles;

  // Brand toggles
  var disabledBrands = [];
  document.querySelectorAll('[data-brand-key]').forEach(function(cb) {
    if (!cb.checked) disabledBrands.push(cb.getAttribute('data-brand-key'));
  });
  payload.disabledBrands = disabledBrands;
  var brandMenuEl = document.getElementById('sEnableBrandMenu');
  if (brandMenuEl) payload.enableBrandMenu = brandMenuEl.checked;

  // Brand prompt overrides
  var brandPromptOverrides = {};
  document.querySelectorAll('[data-brand-prompt-key]').forEach(function(el) {
    var val = el.value.trim();
    if (val) brandPromptOverrides[el.getAttribute('data-brand-prompt-key')] = val;
  });
  payload.brandPromptOverrides = brandPromptOverrides;

  // Backgrounds
  payload.enableBackgroundMenu = document.getElementById('sEnableBgMenu').checked;
  payload.promptBackground = document.getElementById('sPromptBackground').value;
  var backgroundChoices = (currentSettings.backgroundChoices || []).map(function(bg) {
    var copy = {};
    for (var p in bg) copy[p] = bg[p];
    return copy;
  });
  document.querySelectorAll('[data-bg-idx]').forEach(function(el) {
    var idx = parseInt(el.getAttribute('data-bg-idx'));
    if (backgroundChoices[idx]) backgroundChoices[idx].prompt = el.value;
  });
  if (backgroundChoices.length) payload.backgroundChoices = backgroundChoices;

  // Prompt tweaks
  payload.promptUserDirective = document.getElementById('sPromptDirective').value;
  payload.promptPreserve = document.getElementById('sPromptPreserve').value;
  payload.promptComposition = document.getElementById('sPromptComposition').value;
  payload.promptPreserveBrand = document.getElementById('sPromptPreserveBrand').value;
  payload.promptBrandInstruction = document.getElementById('sPromptBrandInstruction').value;
  payload.brandPrompt = document.getElementById('sBrandPrompt').value;

  // Messages
  var messages = {};
  document.querySelectorAll('[data-msg-key]').forEach(function(el) {
    messages[el.getAttribute('data-msg-key')] = el.value;
  });
  payload.messages = messages;
  payload._forEvent = loadedEventName;
  return payload;
}

function performSave(payload) {
  var btn = document.getElementById('saveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  fetch('/review/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    credentials: 'same-origin'
  }).then(function(res) {
    if (res.status === 401) { window.location.href = '/review'; return; }
    if (res.status === 409) {
      return res.json().then(function(conflict) {
        showToast('Event changed to "' + (conflict.currentEvent || '?') + '" — reloading…', 'error');
        setTimeout(loadSettings, 1500);
      });
    }
    if (!res.ok) throw new Error('Save failed');
    return res.json().then(function(data) {
      currentSettings = data;
      loadedEventName = currentSettings.eventName || '';
      renderSettings();
      showToast('Settings saved', 'success');
    });
  }).catch(function() {
    showToast('Failed to save', 'error');
  }).then(function() {
    btn.disabled = false;
    btn.textContent = 'Save Changes';
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────
function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function friendlyMsgLabel(key) {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, function(c) { return c.toUpperCase(); });
}

loadSettings();
</script>
</body></html>`;
}

module.exports = { mountReviewSettings };
