const express = require("express");
const settings = require("./settings");
const { STYLES, STYLE_LIST } = require("./styles");
const audit = require("./audit");
const { getReviewQueue, approveJob } = require("./queue");

// Keys stripped from GET responses (credentials, infra, security-adjacent)
const REDACT_KEYS = new Set([
    "twilioAccountSid", "twilioAuthToken", "twilioPhoneNumber",
    "openaiApiKey", "modelOrchestrator", "modelVisionLight", "modelImageGen", "modelSmartReply", "modelRefAnalysis",
    "printRelayKey", "customBrands", "usageOverrides",
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

            const wasReviewMode = settings.get("reviewMode") || (settings.get("enableManualReview") ? "human" : "off");

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

            // Auto-approve pending items when human review turned off
            const newReviewMode = settings.get("reviewMode") || (settings.get("enableManualReview") ? "human" : "off");
            if (wasReviewMode === "human" && newReviewMode !== "human") {
                const eventName = settings.get("eventName");
                const reviewJobs = await getReviewQueue(eventName);
                for (const job of reviewJobs) {
                    try {
                        await approveJob(job.filename);
                        console.log(`✅ Auto-approved (review disabled for ${eventName}): ${job.filename}`);
                    } catch (err) {
                        console.error(`❌ Auto-approve failed: ${job.filename} - ${err.message}`);
                    }
                }
            }

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
        res.json({
            templates: settings.listTemplates(),
            videos: settings.listVideos(),
            events: settings.listEvents(),
            styles,
        });
    });
}

// ── Mobile Settings HTML ───────────────────────────────────────────────────

function buildMobileSettingsHtml() {
return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
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
  .sg-group:nth-child(5) .sg h4 { border-left-color: var(--red-400); }

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

<script>
window.onerror = function(msg, src, line) {
  var el = document.getElementById('settingsBody');
  if (el) el.innerHTML = '<p style="color:#EF223A;padding:20px">JS Error: ' + msg + ' (line ' + line + ')</p>';
};
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
  document.getElementById('settingsBody').textContent = 'Fetching...';
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

  // Build messages HTML
  var msgKeys = Object.keys(s.messages || {});
  var msgsHtml = msgKeys.map(function(k) {
    return '<div class="sf"><label>' + esc(friendlyMsgLabel(k)) + '</label>'
      + '<textarea data-msg-key="' + esc(k) + '">' + esc(s.messages[k] || '') + '</textarea></div>';
  }).join('');

  document.getElementById('settingsBody').innerHTML = ''
    // ── Event & Operations ──────────────────────────────────────────────────
    + '<div class="sg-group">'
    + '<div class="sg-group-header" onclick="this.parentElement.classList.toggle(\'open\')">Event &amp; Operations</div>'
    + '<div class="sg-group-body">'
    + '<div class="sg"><h4>Event</h4>'
    + '<div class="sf"><label>Current Event</label>'
    + '<select id="sEventDisplay" disabled>'
    + events.map(function(e) { return '<option' + (e === s.eventName ? ' selected' : '') + '>' + esc(e) + '</option>'; }).join('')
    + '</select>'
    + '<div style="font-size:11px;color:var(--th-text-muted);margin-top:6px">Event switching is only available from the main dashboard.</div>'
    + '</div>'
    + '<div class="sf"><label>Max Prints Per User</label><input type="number" id="sMaxPrints" min="1" value="' + (s.maxPrints || 1) + '"></div>'
    + '</div>'
    + '<div class="sg"><h4>Queue</h4>'
    + '<div class="sf"><div class="toggle-row"><span class="toggle-label">Pause Queue</span>'
    + '<label class="toggle"><input type="checkbox" id="sQueuePaused"' + (s.queuePaused ? ' checked' : '') + '><span class="slider"></span></label></div></div>'
    + '<div class="sf"><label>Max Concurrent Generations</label><input type="number" id="sMaxGen" min="1" max="20" value="' + (s.maxConcurrentGeneration || 3) + '"></div>'
    + '</div>'
    + '</div></div>'

    // ── Styles & Art ────────────────────────────────────────────────────────
    + '<div class="sg-group">'
    + '<div class="sg-group-header" onclick="this.parentElement.classList.toggle(\'open\')">Styles &amp; Art</div>'
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
    + '</div></div>'

    // ── Delivery & Display ──────────────────────────────────────────────────
    + '<div class="sg-group">'
    + '<div class="sg-group-header" onclick="this.parentElement.classList.toggle(\'open\')">Delivery &amp; Display</div>'
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
    + '<div class="sg-group-header" onclick="this.parentElement.classList.toggle(\'open\')">Engagement</div>'
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

    // ── Messages ────────────────────────────────────────────────────────────
    + '<div class="sg-group">'
    + '<div class="sg-group-header" onclick="this.parentElement.classList.toggle(\'open\')">Messages</div>'
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
function saveSettings() {
  var btn = document.getElementById('saveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  var payload = {};

  // Simple fields
  payload.maxPrints = parseInt(document.getElementById('sMaxPrints').value) || 1;
  payload.queuePaused = document.getElementById('sQueuePaused').checked;
  payload.maxConcurrentGeneration = parseInt(document.getElementById('sMaxGen').value) || 3;
  payload.defaultStyle = document.getElementById('sDefaultStyle').value;
  payload.multiSubjectMode = document.getElementById('sMultiSubject').value;
  payload.enablePrinting = document.getElementById('sEnablePrinting').checked;
  payload.reviewMode = document.getElementById('sReviewMode').value;
  payload.reviewPin = document.getElementById('sReviewPin').value;
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

  // Messages
  var messages = {};
  document.querySelectorAll('[data-msg-key]').forEach(function(el) {
    messages[el.getAttribute('data-msg-key')] = el.value;
  });
  payload.messages = messages;
  payload._forEvent = loadedEventName;

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
