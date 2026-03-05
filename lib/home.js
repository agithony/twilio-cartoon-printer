const path = require("path");
const express = require("express");
const settings = require("./settings");

const router = express.Router();

const ASSETS_DIR = path.join(__dirname, "..", "assets");

router.get("/", (req, res) => {
    if (!req.originalUrl.endsWith("/") && !req.originalUrl.includes("?"))
        return res.redirect(req.originalUrl + "/");
    res.type("html").send(buildHomeHtml());
});

router.get("/video", (req, res) => {
    res.type("html").send(buildVideoHtml());
});

router.get("/combo", (req, res) => {
    res.type("html").send(COMBO_HTML);
});

function buildHomeHtml() {
return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Twilio + AI Photo Generator</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { font-size: 16px; }
  body {
    font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0B0D11;
    color: #B0B8C4;
    min-height: 100vh;
    padding: clamp(24px, 4vw, 56px) clamp(16px, 3vw, 40px);
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 860px; margin: 0 auto; }

  /* Header */
  .hero { text-align: center; margin-bottom: 48px; padding-top: 8px; }
  .hero-brand { display: flex; align-items: center; justify-content: center; gap: 10px; margin-bottom: 10px; }
  .hero-brand svg { flex-shrink: 0; }
  .hero h1 { font-size: 28px; font-weight: 700; color: #F7F8F8; letter-spacing: -0.5px; }
  .hero .subtitle { font-size: 15px; color: #636B78; font-weight: 400; margin-top: 6px; }

  /* Action cards */
  .actions { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 40px; }
  .action-card {
    background: #13161D;
    border: 1px solid #1E222B;
    border-radius: 14px;
    padding: 28px;
    text-decoration: none;
    transition: border-color .2s, box-shadow .2s;
    display: block;
  }
  .action-card:hover { border-color: #2A3040; box-shadow: 0 8px 32px rgba(0,0,0,.25); }
  .action-card .card-icon { width: 40px; height: 40px; border-radius: 10px; display: flex; align-items: center; justify-content: center; margin-bottom: 16px; }
  .action-card .card-icon svg { width: 20px; height: 20px; }
  .action-card.dashboard .card-icon { background: rgba(75,139,245,0.1); color: #4B8BF5; }
  .action-card.booth .card-icon { background: rgba(46,186,84,0.1); color: #2EBA54; }
  .action-card.outreach .card-icon { background: rgba(232,133,58,0.1); color: #E8853A; }
  .action-card h2 { font-size: 16px; font-weight: 600; color: #E8EAED; margin-bottom: 8px; }
  .action-card p { font-size: 13.5px; color: #636B78; line-height: 1.6; }

  /* Expandable sub-options */
  .sub-options { overflow: hidden; max-height: 0; transition: max-height .3s ease, margin .3s ease; margin-top: 0; }
  .sub-options.open { max-height: 200px; margin-top: 14px; }
  .sub-toggle {
    display: inline-flex; align-items: center; gap: 5px;
    margin-top: 14px; padding: 0; border: none; background: none;
    font-size: 12.5px; color: #636B78;
    cursor: pointer; font-family: inherit; transition: color .15s;
  }
  .sub-toggle:hover { color: #B0B8C4; }
  .sub-toggle svg { width: 12px; height: 12px; transition: transform .25s; }
  .sub-toggle.open svg { transform: rotate(180deg); }
  .sub-links { display: flex; gap: 10px; flex-wrap: wrap; }
  .sub-link {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 7px 14px; border-radius: 8px;
    background: #1A1E27; border: 1px solid #252A34;
    color: #B0B8C4; text-decoration: none;
    font-size: 12.5px; font-weight: 500; transition: all .15s;
  }
  .sub-link:hover { background: #252A34; border-color: #313845; color: #E8EAED; }

  /* Sections */
  .section { margin-bottom: 36px; }
  .section-title {
    font-size: 11px; font-weight: 600; color: #4D5562;
    text-transform: uppercase; letter-spacing: 1px; margin-bottom: 16px;
    padding-bottom: 10px; border-bottom: 1px solid #1A1E27;
  }

  /* How it works */
  .steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  @media (max-width: 640px) { .steps { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 420px) { .steps { grid-template-columns: 1fr; } }
  .step {
    background: #13161D;
    border: 1px solid #1E222B;
    border-radius: 12px;
    padding: 18px 14px;
    display: flex;
    gap: 10px;
    align-items: flex-start;
  }
  .step-num {
    display: inline-flex; align-items: center; justify-content: center;
    width: 24px; height: 24px; border-radius: 50%; flex-shrink: 0;
    background: rgba(242,47,70,0.08); color: #F22F46;
    font-size: 11px; font-weight: 700;
  }
  .step-text { font-size: 12.5px; color: #8B95A5; line-height: 1.5; }
  .step-text a { color: #4B8BF5; text-decoration: none; font-weight: 500; transition: color .15s; }
  .step-text a:hover { color: #6BA3F7; text-decoration: underline; }

  .footer {
    text-align: center; color: #2D3340; font-size: 12px; font-weight: 500;
    margin-top: 48px; padding-top: 20px; border-top: 1px solid #151921;
  }
  .footer a { color: #3D4555; text-decoration: none; }
  .footer a:hover { color: #636B78; }

  /* Settings panel */
  .settings-toggle {
    display: flex; align-items: center; gap: 10px; cursor: pointer;
    padding: 16px 20px;
    background: #13161D; border: 1px solid #1E222B; border-radius: 12px;
    margin-bottom: 14px; transition: border-color .2s; user-select: none;
  }
  .settings-toggle:hover { border-color: #2A3040; }
  .settings-toggle h3 { font-size: 11px; font-weight: 600; color: #4D5562; text-transform: uppercase; letter-spacing: 1px; }
  .settings-toggle svg { width: 12px; height: 12px; color: #4D5562; margin-left: auto; transition: transform .25s; }
  .settings-toggle.open svg { transform: rotate(180deg); }
  .settings-panel { overflow: hidden; max-height: 0; transition: max-height .4s ease, overflow 0s .4s; }
  .settings-panel.open { max-height: 5000px; overflow: visible; transition: max-height .4s ease, overflow 0s 0s; }
  .sg { background: #13161D; border: 1px solid #1E222B; border-radius: 12px; padding: 22px; margin-bottom: 12px; }
  .sg h4 { font-size: 13.5px; font-weight: 600; color: #E8EAED; margin-bottom: 16px; }
  .sf { margin-bottom: 16px; }
  .sf:last-child { margin-bottom: 0; }
  .sf label { display: block; font-size: 12.5px; color: #636B78; margin-bottom: 6px; font-weight: 500; }
  .sf input[type="text"], .sf input[type="number"], .sf input[type="url"], .sf select, .sf textarea {
    width: 100%; padding: 9px 13px; border-radius: 8px; border: 1px solid #252A34;
    background: #0E1117; color: #E8EAED; font-size: 14px; font-family: inherit;
    transition: border-color .2s;
  }
  .sf input:focus, .sf select:focus, .sf textarea:focus { outline: none; border-color: #4B8BF5; box-shadow: 0 0 0 3px rgba(75,139,245,0.1); }
  .sf textarea { resize: vertical; min-height: 64px; }
  .sf-row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  @media (max-width: 540px) { .sf-row { grid-template-columns: 1fr; } }
  .preview-box { margin-top: 10px; display: none; }
  .preview-box img { max-width: 200px; max-height: 280px; border-radius: 8px; border: 1px solid #1E222B; background: #0B0D11; }
  .preview-box video { max-width: 280px; max-height: 160px; border-radius: 8px; border: 1px solid #1E222B; background: #0B0D11; }
  .preview-box .no-preview { font-size: 11.5px; color: #4D5562; font-style: italic; }
  .style-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
  .style-card {
    background: #0E1117; border: 1px solid #1A1E27; border-radius: 10px; overflow: hidden;
    transition: border-color .15s;
  }
  .style-card:hover { border-color: #252A34; }
  .style-card.disabled { opacity: .45; }
  .style-card-thumb {
    width: 100%; aspect-ratio: 5/7; background: #0B0D11; display: flex;
    align-items: center; justify-content: center; overflow: hidden;
  }
  .style-card-thumb img { width: 100%; height: 100%; object-fit: cover; }
  .style-card-thumb .no-thumb { font-size: 11px; color: #2D3340; }
  .style-card-body { padding: 10px; }
  .style-card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px; }
  .style-card-header .sname { font-size: 13px; font-weight: 600; color: #B0B8C4; }
  .style-card-header input.sname-edit { font-size: 13px; font-weight: 600; color: #B0B8C4; background: transparent; border: 1px solid transparent; border-radius: 4px; padding: 1px 4px; font-family: inherit; width: 100%; transition: border-color .2s; }
  .style-card-header input.sname-edit:hover { border-color: #252A34; }
  .style-card-header input.sname-edit:focus { outline: none; border-color: #4B8BF5; background: #0E1117; }
  .style-card-header .slabel { font-size: 10px; color: #4D5562; }
  .style-card-actions { display: flex; align-items: center; justify-content: space-between; margin-top: 6px; }
  .style-card-actions .prompt-link { font-size: 11px; color: #4B8BF5; cursor: pointer; background: none; border: none; padding: 0; font-family: inherit; }
  .style-card-actions .prompt-link:hover { text-decoration: underline; }
  .style-card-actions .remove-link { font-size: 11px; color: #F22F46; cursor: pointer; background: none; border: none; padding: 0; font-family: inherit; }
  .style-card-actions .remove-link:hover { text-decoration: underline; }
  .toggle-sw { position: relative; width: 36px; height: 20px; flex-shrink: 0; }
  .toggle-sw input { opacity: 0; width: 0; height: 0; }
  .toggle-sw .slider { position: absolute; inset: 0; border-radius: 10px; background: #2A3040; cursor: pointer; transition: .2s; }
  .toggle-sw .slider::before { content: ''; position: absolute; left: 2px; top: 2px; width: 16px; height: 16px; border-radius: 50%; background: #8B95A5; transition: .2s; }
  .toggle-sw input:checked + .slider { background: #2EBA54; }
  .toggle-sw input:checked + .slider::before { background: #fff; transform: translateX(16px); }
  .delivery-switch { display: flex; gap: 0; border-radius: 10px; overflow: hidden; border: 1px solid #1E222B; }
  .delivery-switch button {
    flex: 1; padding: 10px 16px; border: none; cursor: pointer; font-size: 13px; font-weight: 600;
    font-family: inherit; transition: background .15s, color .15s; display: flex; align-items: center; justify-content: center; gap: 7px;
  }
  .delivery-switch button.ds-print {
    background: #1A1E27; color: #4D5562;
  }
  .delivery-switch button.ds-print.active {
    background: #2EBA5422; color: #2EBA54; box-shadow: inset 0 0 0 1px #2EBA5466;
  }
  .delivery-switch button.ds-digital {
    background: #1A1E27; color: #4D5562;
  }
  .delivery-switch button.ds-digital.active {
    background: #4B8BF522; color: #4B8BF5; box-shadow: inset 0 0 0 1px #4B8BF566;
  }
  .delivery-switch button svg { width: 16px; height: 16px; flex-shrink: 0; }
  .delivery-switch button.lc-btn { background: #1A1E27; color: #4D5562; }
  .delivery-switch button.lc-btn.active { background: #9B6FE822; color: #9B6FE8; box-shadow: inset 0 0 0 1px #9B6FE866; }
  .delivery-status.mode-lead { background: #9B6FE812; color: #9B6FE8; border: 1px solid #9B6FE833; }
  .delivery-status { font-size: 11.5px; margin-top: 8px; padding: 6px 10px; border-radius: 6px; }
  .delivery-status.mode-both { background: #2EBA5412; color: #2EBA54; border: 1px solid #2EBA5433; }
  .delivery-status.mode-digital { background: #4B8BF512; color: #4B8BF5; border: 1px solid #4B8BF533; }
  .phone-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .phone-tag { display: inline-flex; align-items: center; gap: 5px; padding: 5px 11px; border-radius: 6px; background: #1A1E27; color: #B0B8C4; font-size: 12.5px; }
  .phone-tag .remove { cursor: pointer; color: #4D5562; font-weight: bold; font-size: 13px; line-height: 1; }
  .phone-tag .remove:hover { color: #F22F46; }
  .phone-add { display: flex; gap: 8px; }
  .phone-add input { flex: 1; }
  .btn { padding: 9px 18px; border-radius: 8px; border: 1px solid #252A34; background: #1A1E27; color: #B0B8C4; font-size: 13px; font-weight: 500; cursor: pointer; transition: all .15s; font-family: inherit; }
  .btn:hover { background: #252A34; border-color: #313845; color: #E8EAED; }
  .btn-primary { background: #F22F46; border-color: #F22F46; color: #fff; }
  .btn-primary:hover { background: #D42A3F; border-color: #D42A3F; }
  .btn-danger { border-color: rgba(242,47,70,0.2); color: #F22F46; }
  .btn-danger:hover { background: rgba(242,47,70,0.08); }
  .settings-actions { display: flex; gap: 10px; align-items: center; margin-top: 20px; }
  .save-msg { font-size: 12.5px; color: #2EBA54; opacity: 0; transition: opacity .3s; }
  .save-msg.show { opacity: 1; }
  .custom-style-form { margin-top: 14px; padding: 16px; border-radius: 10px; background: #0E1117; border: 1px solid #1E222B; }
  .custom-style-form .sf { margin-bottom: 12px; }
  .tip {
    display: inline-flex; align-items: center; justify-content: center;
    width: 15px; height: 15px; border-radius: 50%; background: #1E222B; color: #4D5562;
    font-size: 10px; font-weight: 700; cursor: help; position: relative;
    margin-left: 5px; vertical-align: middle; flex-shrink: 0; transition: color .15s, background .15s;
  }
  .tip:hover { background: #252A34; color: #8B95A5; }
  .tip:hover::after {
    content: attr(data-tip); position: absolute; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%);
    background: #1E222B; color: #B0B8C4; padding: 10px 14px; border-radius: 8px;
    font-size: 12px; font-weight: 400; line-height: 1.5; white-space: normal;
    width: max-content; max-width: 280px; z-index: 100; box-shadow: 0 8px 24px rgba(0,0,0,.5);
    pointer-events: none; border: 1px solid #252A34;
  }
  .tip:hover::before {
    content: ''; position: absolute; bottom: calc(100% + 3px); left: 50%; transform: translateX(-50%);
    border: 5px solid transparent; border-top-color: #1E222B; z-index: 100;
  }
  .sg-help { display: inline; }
  .sg-help .tip { margin-left: 6px; }
  .file-upload-row { display: flex; gap: 8px; align-items: center; margin-top: 10px; }
  .file-upload-row input[type="file"] { font-size: 12px; color: #4D5562; }
  .file-upload-row input[type="file"]::file-selector-button {
    padding: 6px 12px; border-radius: 6px; border: 1px solid #252A34; background: #1A1E27;
    color: #B0B8C4; font-size: 12px; cursor: pointer; font-family: inherit; transition: all .15s;
  }
  .file-upload-row input[type="file"]::file-selector-button:hover { background: #252A34; color: #E8EAED; }
  .upload-status { font-size: 11px; color: #2EBA54; }
  .upload-status.err { color: #F22F46; }
  .save-banner {
    padding: 14px 20px; border-radius: 10px; margin-bottom: 14px;
    font-size: 14px; font-weight: 500; text-align: center;
    display: none; animation: bannerFade 3s forwards;
  }
  .save-banner.success { display: block; background: rgba(46,186,84,0.08); color: #2EBA54; border: 1px solid rgba(46,186,84,0.15); }
  .save-banner.reset-ok { display: block; background: rgba(75,139,245,0.08); color: #4B8BF5; border: 1px solid rgba(75,139,245,0.15); }
  @keyframes bannerFade { 0%,70% { opacity: 1; } 100% { opacity: 0; } }
  .btn-sm { padding: 5px 11px; font-size: 11.5px; }
  .select-row { display: flex; gap: 8px; align-items: center; }
  .select-row select { flex: 1; }
  textarea.style-prompt { display: none; margin-top: 8px; padding: 8px 10px; border-radius: 6px; background: #0B0D11; border: 1px solid #1A1E27; font-size: 11px; color: #B0B8C4; line-height: 1.5; width: 100%; resize: vertical; font-family: inherit; min-height: 80px; transition: border-color .2s; }
  textarea.style-prompt:focus { outline: none; border-color: #4B8BF5; box-shadow: 0 0 0 3px rgba(75,139,245,0.1); }
  textarea.style-prompt.open { display: block; }
  .style-card-actions .reset-link { font-size: 11px; color: #E8853A; cursor: pointer; background: none; border: none; padding: 0; font-family: inherit; display: none; }
  .style-card-actions .reset-link:hover { text-decoration: underline; }
  .style-card-actions .reset-link.visible { display: inline; }
</style>
</head>
<body>
<div class="wrap">

<div class="hero">
  <div class="hero-brand">
    <svg width="32" height="32" viewBox="0 0 256 256" fill="none"><circle cx="128" cy="128" r="128" fill="#F22F46"/><circle cx="128" cy="128" r="84" fill="none" stroke="#fff" stroke-width="16"/><circle cx="100" cy="100" r="18" fill="#fff"/><circle cx="156" cy="100" r="18" fill="#fff"/><circle cx="100" cy="156" r="18" fill="#fff"/><circle cx="156" cy="156" r="18" fill="#fff"/></svg>
    <h1>Twilio + AI Photo Generator</h1>
  </div>
  <div class="subtitle">Admin Console</div>
</div>

<!-- Quick Actions -->
<div class="actions">
  <div class="action-card booth">
    <a href="/home/combo" target="_blank" style="text-decoration:none;color:inherit;display:block">
      <div class="card-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg></div>
      <h2>Launch Booth Display</h2>
      <p>Split-screen with intro video and photo book. Drag the divider to resize. Ideal for a single booth monitor.</p>
    </a>
    <button class="sub-toggle" id="subToggle" onclick="event.stopPropagation();this.classList.toggle('open');document.getElementById('subOpts').classList.toggle('open')">
      Open individually <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
    </button>
    <div class="sub-options" id="subOpts">
      <div class="sub-links">
        <a href="/home/video" target="_blank" class="sub-link">&#x1F3AC; Intro Video</a>
        <a href="/photogallery/" target="_blank" class="sub-link">&#x1F4D6; Photo Book</a>
      </div>
    </div>
  </div>
  <a href="/dashboard/" class="action-card dashboard">
    <div class="card-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg></div>
    <h2>Open Dashboard</h2>
    <p>Monitor live prints, manage the queue, track paper, and generate event reports.</p>
  </a>
  <a href="/outreach/" class="action-card outreach">
    <div class="card-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div>
    <h2>Outreach</h2>
    <p>Send broadcast messages, run raffles, download lead capture reports, and manage event communications.</p>
  </a>
</div>

<!-- Settings -->
<div class="section">
  <div class="settings-toggle" id="settingsToggle" onclick="this.classList.toggle('open');document.getElementById('settingsPanel').classList.toggle('open');if(this.classList.contains('open'))loadSettings()">
    <h3>Settings</h3>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
  </div>
  <div class="settings-panel" id="settingsPanel">

    <div id="saveBanner" class="save-banner"></div>

    <div class="sg"><h4>Event</h4>
      <div class="sf-row">
        <div class="sf"><label>Event Name <span class="tip" data-tip="Identifies this event. Used in SMS messages and to separate download folders per event.">?</span></label><input type="text" id="sEventName"></div>
        <div class="sf"><label>Max Prints Per User <span class="tip" data-tip="How many free prints each attendee gets. Admin numbers are unlimited.">?</span></label><input type="number" id="sMaxPrints" min="1"></div>
      </div>
      <div class="sf"><label>Max Concurrent Generations <span class="tip" data-tip="How many AI image generations can run at the same time. Higher = faster throughput but more API usage.">?</span></label><input type="number" id="sMaxGen" min="1" max="20"></div>
    </div>

    <div class="sg"><h4>Lead Capture <span class="tip" data-tip="Capture attendee contact info via a quick SMS survey. 'Before' asks questions before creating their portrait. 'After' asks after the portrait is ready, before delivering the result.">?</span></h4>
      <input type="hidden" id="sLeadMode" value="disabled">
      <div class="sf">
        <label>Lead Capture Mode</label>
        <div class="delivery-switch" style="max-width:420px">
          <button type="button" class="lc-btn active" data-mode="disabled" onclick="setLeadMode('disabled')">Disabled</button>
          <button type="button" class="lc-btn" data-mode="before" onclick="setLeadMode('before')">Before</button>
          <button type="button" class="lc-btn" data-mode="after" onclick="setLeadMode('after')">After</button>
        </div>
        <div class="delivery-status" id="leadStatus" style="margin-top:8px">Lead capture is off</div>
      </div>
    </div>

    <div class="sg"><h4>Art &amp; Branding <span class="tip" data-tip="Configure AI art generation. The brand prompt is appended to every style for event-specific branding like clothing or logos. Toggle individual styles on/off below.">?</span></h4>
      <div class="sf"><label>Default Style <span class="tip" data-tip="The style used when someone sends a photo without specifying one.">?</span></label><select id="sDefaultStyle"></select></div>
      <div class="sf"><label>Brand Prompt <span class="tip" data-tip="Applied to all styles. Use for clothing, logos, or visual themes that should appear in every portrait. Leave blank to disable.">?</span></label><textarea id="sBrandPrompt" rows="3" placeholder="e.g. The subject should be wearing a bright red Twilio t-shirt with the Twilio logo clearly visible"></textarea></div>
      <div id="stylesList"></div>
      <div style="margin-top:12px">
        <button class="btn" onclick="document.getElementById('customStyleForm').style.display=document.getElementById('customStyleForm').style.display==='none'?'block':'none'">+ Add Custom Style</button>
        <div id="customStyleForm" class="custom-style-form" style="display:none">
          <div class="sf"><label>Style Name <span class="tip" data-tip="The name attendees will type to select this style.">?</span></label><input type="text" id="csName" placeholder="e.g. oil painting"></div>
          <div class="sf"><label>Prompt <span class="tip" data-tip="The AI prompt used to transform the selfie. Be specific about the artistic style you want.">?</span></label><textarea id="csPrompt" placeholder="Transform this photo into an oil painting with visible brushstrokes..."></textarea></div>
          <button class="btn btn-primary" onclick="addCustomStyle()">Add Style</button>
        </div>
      </div>
    </div>

    <div class="sg"><h4>Booth &amp; Delivery <span class="tip" data-tip="Configure physical booth hardware and delivery mode. Disable printing to run digital-only (MMS delivery, no printer required).">?</span></h4>
      <input type="hidden" id="sEnablePrinting" value="true">
      <div class="sf">
        <label style="margin-bottom:6px">Delivery Mode</label>
        <div class="delivery-switch">
          <button type="button" class="ds-print active" onclick="setDeliveryMode(true)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg> Print + Digital</button>
          <button type="button" class="ds-digital" onclick="setDeliveryMode(false)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg> Digital Only</button>
        </div>
        <div class="delivery-status mode-both" id="deliveryStatus">Portraits are printed and sent via MMS</div>
      </div>
      <div class="sf">
        <label>Printer <span class="tip" data-tip="Printers detected on this computer via system print settings. Click Refresh if you just connected a new printer.">?</span></label>
        <div class="select-row"><select id="sPrinter"><option value="">Loading...</option></select><button class="btn btn-sm" onclick="refreshPrinters()">Refresh</button></div>
      </div>
      <div id="printSettingsSection">
        <div class="sf-row" style="margin-top:2px">
          <div class="sf">
            <label>Print Size <span class="tip" data-tip="Paper size for printing. Controls the image pixel dimensions and the PageSize flag sent to the printer.">?</span></label>
            <select id="sPrintSize">
              <option value="4x6">4x6 (1200 x 1800px)</option>
              <option value="5x7" selected>5x7 (1500 x 2100px)</option>
              <option value="8x10">8x10 (2400 x 3000px)</option>
            </select>
          </div>
          <div class="sf">
            <label>Print Quality <span class="tip" data-tip="Resolution sent to the printer. Higher quality uses more ink and prints slower.">?</span></label>
            <select id="sPrintQuality">
              <option value="standard">Standard (360 DPI)</option>
              <option value="high" selected>High (720 DPI)</option>
              <option value="max">Max (1440 DPI)</option>
            </select>
          </div>
        </div>
        <div class="sf">
          <label>Custom Print Flags <span class="tip" data-tip="Additional raw flags appended to the lp command. For non-Epson printers or advanced CUPS options. Example: -o MediaType=Glossy">?</span></label>
          <input type="text" id="sCustomPrintFlags" placeholder="-o MediaType=Glossy">
        </div>
      </div>
      <div class="sf">
        <label>Template Frame <span class="tip" data-tip="A PNG overlay composited on top of every generated portrait. Use None for no frame.">?</span></label>
        <select id="sTemplate" onchange="updateTemplatePreview()"><option value="">None</option></select>
        <div class="file-upload-row"><input type="file" id="uploadTemplate" accept=".png,.jpg,.jpeg,.gif,.svg"><button class="btn btn-sm" onclick="uploadFile('template')">Upload</button><span class="upload-status" id="uploadTemplateStatus"></span></div>
        <div class="preview-box" id="templatePreview"></div>
      </div>
      <div class="sf">
        <label>Intro Video <span class="tip" data-tip="Looping video shown on the booth display to attract attendees.">?</span></label>
        <select id="sVideo" onchange="updateVideoPreview()"><option value="">Loading...</option></select>
        <div class="file-upload-row"><input type="file" id="uploadVideo" accept=".mp4,.webm,.mov"><button class="btn btn-sm" onclick="uploadFile('video')">Upload</button><span class="upload-status" id="uploadVideoStatus"></span></div>
        <div class="preview-box" id="videoPreview"></div>
      </div>
    </div>

    <div class="sg"><h4>Messaging <span class="tip" data-tip="Admin access and SMS messaging. Admin phones get unlimited prints and are hidden from metrics. Promo messages are appended to SMS replies.">?</span></h4>
      <div class="sf"><label>Admin Phone Numbers <span class="tip" data-tip="Phone numbers in E.164 format (e.g. +14155551234). Admins get unlimited prints and are excluded from dashboard metrics.">?</span></label>
        <div class="phone-tags" id="phoneTags"></div>
        <div class="phone-add"><input type="text" id="phoneInput" placeholder="+14155551234"><button class="btn" onclick="addPhone()">Add</button></div>
      </div>
      <div class="sf"><label>Terms URL <span class="tip" data-tip="If set, a link to your terms is included in the first SMS to each new user.">?</span></label><input type="url" id="sTermsUrl" placeholder="https://example.com/terms"></div>
      <div class="sf"><label>First-Time User Message <span class="tip" data-tip="Appended to the confirmation SMS for first-time users only. Leave blank to disable.">?</span></label><textarea id="sPromoIntro" rows="3" placeholder="e.g. P.S. Join us at SIGNAL 2025, June 25-26! Register free: https://signal.twilio.com"></textarea></div>
      <div class="sf"><label>Returning User Message <span class="tip" data-tip="Appended to confirmation and print-ready SMS for returning users. Leave blank to disable.">?</span></label><textarea id="sPromoReturning" rows="3" placeholder="e.g. Have you registered for SIGNAL yet? Don't miss out: https://signal.twilio.com"></textarea></div>
    </div>

    <div class="settings-actions">
      <button class="btn btn-primary" onclick="saveSettings()">Save Settings</button>
      <button class="btn btn-danger" onclick="resetSettings()">Reset to Defaults</button>
      <span class="save-msg" id="saveMsg">Settings saved!</span>
    </div>

  </div>
</div>

<!-- How It Works -->
<div class="section">
  <div class="section-title">How It Works</div>
  <div class="steps">
    <div class="step"><div class="step-num">1</div><div class="step-text">Configure your event, styles, and printer in <a href="#" onclick="document.querySelector('.settings-toggle').click();return false">Settings</a> above</div></div>
    <div class="step"><div class="step-num">2</div><div class="step-text"><a href="/home/combo" target="_blank">Launch the Booth Display</a> on a monitor for attendees to see</div></div>
    <div class="step"><div class="step-num">3</div><div class="step-text">Attendees text a selfie to your Twilio number with a style name</div></div>
    <div class="step"><div class="step-num">4</div><div class="step-text">AI generates their portrait and it prints at your booth. Monitor progress in the <a href="/dashboard/" target="_blank">Dashboard</a></div></div>
    <div class="step"><div class="step-num">5</div><div class="step-text">They get an SMS with their portrait when it's ready to pick up</div></div>
    <div class="step"><div class="step-num">6</div><div class="step-text">Use <a href="/outreach/" target="_blank">Outreach</a> to send broadcasts, run raffles, download lead reports, and engage attendees</div></div>
  </div>
</div>

<div class="footer">Powered by <a href="https://www.twilio.com" target="_blank">Twilio</a> + <a href="https://openai.com" target="_blank">OpenAI</a></div>

</div><!-- /.wrap -->

<script>
// ── Settings ──
var _settings = {};
var _files = {};
var _adminPhones = [];
var _customStyles = {};
var _stylePromptOverrides = {};

async function loadSettings() {
  try {
    var [sr, fr] = await Promise.all([
      fetch("/dashboard/api/settings"),
      fetch("/dashboard/api/settings/files")
    ]);
    _settings = await sr.json();
    _files = await fr.json();
    _adminPhones = (_settings.adminPhones || []).slice();
    _customStyles = Object.assign({}, _settings.customStyles || {});
    _stylePromptOverrides = Object.assign({}, _settings.stylePromptOverrides || {});
    populateSettings();
  } catch(e) { console.error("Failed to load settings", e); }
}

function setDeliveryMode(printing) {
  document.getElementById("sEnablePrinting").value = printing ? "true" : "false";
  var btnPrint = document.querySelector(".ds-print");
  var btnDigital = document.querySelector(".ds-digital");
  var status = document.getElementById("deliveryStatus");
  var printSection = document.getElementById("printSettingsSection");
  if (printing) {
    btnPrint.classList.add("active"); btnDigital.classList.remove("active");
    status.className = "delivery-status mode-both";
    status.textContent = "Portraits are printed and sent via MMS";
    if (printSection) printSection.style.display = "";
  } else {
    btnPrint.classList.remove("active"); btnDigital.classList.add("active");
    status.className = "delivery-status mode-digital";
    status.textContent = "Portraits are sent via MMS only (no printer needed)";
    if (printSection) printSection.style.display = "none";
  }
}

function setLeadMode(mode) {
  document.getElementById("sLeadMode").value = mode;
  document.querySelectorAll(".lc-btn").forEach(function(btn) {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });
  var status = document.getElementById("leadStatus");
  if (mode === "before") {
    status.className = "delivery-status mode-lead";
    status.textContent = "Attendees complete a quick survey before their portrait is created";
  } else if (mode === "after") {
    status.className = "delivery-status mode-lead";
    status.textContent = "Attendees complete a quick survey before receiving their portrait";
  } else {
    status.className = "delivery-status";
    status.textContent = "Lead capture is off";
  }
}

function populateSettings() {
  document.getElementById("sEventName").value = _settings.eventName || "";
  document.getElementById("sMaxPrints").value = _settings.maxPrints || 2;
  document.getElementById("sMaxGen").value = _settings.maxConcurrentGeneration || 3;
  document.getElementById("sTermsUrl").value = _settings.termsUrl || "";
  document.getElementById("sPromoIntro").value = _settings.promoIntro || "";
  document.getElementById("sPromoReturning").value = _settings.promoReturning || "";
  setDeliveryMode(_settings.enablePrinting !== false);
  setLeadMode(_settings.leadCaptureMode || "disabled");
  document.getElementById("sBrandPrompt").value = _settings.brandPrompt || "";

  // Print settings
  document.getElementById("sPrintSize").value = _settings.printSize || "5x7";
  document.getElementById("sPrintQuality").value = _settings.printQuality || "high";
  document.getElementById("sCustomPrintFlags").value = _settings.customPrintFlags || "";

  // Dropdowns
  fillSelect("sPrinter", _files.printers || [], _settings.printerName, "Select printer...");
  fillSelect("sTemplate", _files.templates || [], _settings.templateFile, "None (no frame)");
  fillSelect("sVideo", _files.videos || [], _settings.videoFile, "Select video...");
  updateTemplatePreview();
  updateVideoPreview();

  // Phone tags
  renderPhoneTags();

  // Styles
  renderStyles();
}

function fillSelect(id, options, current, placeholder) {
  var sel = document.getElementById(id);
  sel.innerHTML = '<option value="">' + placeholder + '</option>';
  options.forEach(function(o) {
    var opt = document.createElement("option");
    opt.value = o; opt.textContent = o;
    if (o === current) opt.selected = true;
    sel.appendChild(opt);
  });
}

function updateTemplatePreview() {
  var val = document.getElementById("sTemplate").value;
  var box = document.getElementById("templatePreview");
  if (val) {
    box.innerHTML = '<img src="/templates/' + encodeURIComponent(val) + '">';
    box.style.display = "block";
  } else { box.style.display = "none"; }
}

function updateVideoPreview() {
  var val = document.getElementById("sVideo").value;
  var box = document.getElementById("videoPreview");
  if (val) {
    box.innerHTML = '<video src="/assets/' + encodeURIComponent(val) + '" muted loop playsinline autoplay></video>';
    box.style.display = "block";
  } else { box.style.display = "none"; }
}

function loadStylePreviews() {
  _builtInStyles.forEach(function(s, i) { loadOnePreview(s.key, "sp" + i); });
  Object.keys(_customStyles).forEach(function(k) { loadOnePreview(k, "spc_" + k); });
}

async function loadOnePreview(styleKey, elId) {
  var el = document.getElementById(elId);
  if (!el) return;
  try {
    var r = await fetch("/dashboard/api/style-preview?style=" + encodeURIComponent(styleKey));
    var d = await r.json();
    if (d.image) {
      el.innerHTML = '<img src="' + d.image + '">';
    } else {
      el.innerHTML = '<span class="no-thumb">No preview</span>';
    }
  } catch(e) {
    el.innerHTML = '<span class="no-thumb">No preview</span>';
  }
}

function renderPhoneTags() {
  var container = document.getElementById("phoneTags");
  container.innerHTML = _adminPhones.map(function(p, i) {
    return '<span class="phone-tag">' + p + ' <span class="remove" onclick="removePhone(' + i + ')">x</span></span>';
  }).join("");
}

function addPhone() {
  var input = document.getElementById("phoneInput");
  var phone = input.value.trim();
  if (phone && !_adminPhones.includes(phone)) {
    _adminPhones.push(phone);
    renderPhoneTags();
    input.value = "";
  }
}

function removePhone(idx) {
  _adminPhones.splice(idx, 1);
  renderPhoneTags();
}

var _builtInStyles = ${JSON.stringify(Object.entries(require("./styles").STYLES).map(([k, v]) => ({ key: k, name: v.name, prompt: v.prompt })))};

function renderStyles() {
  var disabled = _settings.disabledStyles || [];
  var html = "";

  _builtInStyles.forEach(function(s, i) {
    var isDisabled = disabled.includes(s.key);
    var checked = !isDisabled ? "checked" : "";
    var hasOverride = !!_stylePromptOverrides[s.key];
    var promptText = _stylePromptOverrides[s.key] || s.prompt;
    html += '<div class="style-card' + (isDisabled ? ' disabled' : '') + '">'
      + '<div class="style-card-thumb" id="sp' + i + '"><span class="no-thumb">Loading...</span></div>'
      + '<div class="style-card-body">'
      + '<div class="style-card-header"><span class="sname">' + escHtml(s.name) + '</span><span class="slabel">built-in</span></div>'
      + '<div class="style-card-actions">'
      + '<button class="prompt-link" onclick="togglePrompt(\\'bp' + i + '\\')">prompt</button>'
      + '<button class="reset-link' + (hasOverride ? ' visible' : '') + '" id="rst' + i + '" onclick="resetBuiltInPrompt(' + i + ')">reset</button>'
      + '<label class="toggle-sw"><input type="checkbox" data-style="' + s.key + '" ' + checked + ' onchange="this.closest(\\'.style-card\\').classList.toggle(\\'disabled\\',!this.checked);rebuildDefaultStyleDropdown()"><span class="slider"></span></label>'
      + '</div>'
      + '<textarea class="style-prompt" id="bp' + i + '" rows="6" oninput="onBuiltInPromptEdit(' + i + ',this.value)">' + escHtml(promptText) + '</textarea>'
      + '</div></div>';
  });

  Object.keys(_customStyles).forEach(function(k) {
    html += '<div class="style-card">'
      + '<div class="style-card-thumb" id="spc_' + k + '"><span class="no-thumb">Loading...</span></div>'
      + '<div class="style-card-body">'
      + '<div class="style-card-header"><input class="sname-edit" value="' + escAttr(_customStyles[k].name) + '" oninput="onCustomNameEdit(\\''+k+'\\',this.value)"><span class="slabel">custom</span></div>'
      + '<div class="style-card-actions">'
      + '<button class="prompt-link" onclick="togglePrompt(\\'cp_' + k + '\\')">prompt</button>'
      + '<button class="remove-link" onclick="removeCustomStyle(\\''+k+'\\')">remove</button>'
      + '</div>'
      + '<textarea class="style-prompt" id="cp_' + k + '" rows="6" oninput="onCustomPromptEdit(\\''+k+'\\',this.value)">' + escHtml(_customStyles[k].prompt || "") + '</textarea>'
      + '</div></div>';
  });

  document.getElementById("stylesList").className = "style-grid";
  document.getElementById("stylesList").innerHTML = html;
  loadStylePreviews();
  rebuildDefaultStyleDropdown();
}

function rebuildDefaultStyleDropdown() {
  var sel = document.getElementById("sDefaultStyle");
  var current = sel.value || _settings.defaultStyle || "cartoon";
  sel.innerHTML = "";
  // Built-in styles that are checked (enabled)
  _builtInStyles.forEach(function(s) {
    var cb = document.querySelector('#stylesList input[data-style="' + s.key + '"]');
    if (cb && cb.checked) {
      var opt = document.createElement("option");
      opt.value = s.key;
      opt.textContent = s.name;
      if (s.key === current) opt.selected = true;
      sel.appendChild(opt);
    }
  });
  // Custom styles (always enabled)
  Object.keys(_customStyles).forEach(function(k) {
    var opt = document.createElement("option");
    opt.value = k;
    opt.textContent = _customStyles[k].name;
    if (k === current) opt.selected = true;
    sel.appendChild(opt);
  });
  // If current selection was removed, default to first option
  if (sel.value !== current && sel.options.length > 0) {
    sel.options[0].selected = true;
  }
}

function togglePrompt(id) {
  var el = document.getElementById(id);
  if (el) el.classList.toggle("open");
}

function onBuiltInPromptEdit(idx, value) {
  var s = _builtInStyles[idx];
  if (value.trim() === s.prompt.trim()) {
    delete _stylePromptOverrides[s.key];
  } else {
    _stylePromptOverrides[s.key] = value;
  }
  var rst = document.getElementById("rst" + idx);
  if (rst) rst.classList.toggle("visible", !!_stylePromptOverrides[s.key]);
}

function resetBuiltInPrompt(idx) {
  var s = _builtInStyles[idx];
  delete _stylePromptOverrides[s.key];
  var ta = document.getElementById("bp" + idx);
  if (ta) ta.value = s.prompt;
  var rst = document.getElementById("rst" + idx);
  if (rst) rst.classList.remove("visible");
}

function onCustomPromptEdit(key, value) {
  if (_customStyles[key]) _customStyles[key].prompt = value;
}

function onCustomNameEdit(key, value) {
  if (_customStyles[key]) {
    _customStyles[key].name = value;
    rebuildDefaultStyleDropdown();
  }
}

function escHtml(s) {
  var d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function escAttr(s) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function addCustomStyle() {
  var name = document.getElementById("csName").value.trim();
  var prompt = document.getElementById("csPrompt").value.trim();
  if (!name || !prompt) return;
  var key = name.toLowerCase().replace(/\\s+/g, "-");
  _customStyles[key] = { name: name, prompt: prompt };
  document.getElementById("csName").value = "";
  document.getElementById("csPrompt").value = "";
  document.getElementById("customStyleForm").style.display = "none";
  renderStyles();
}

function removeCustomStyle(key) {
  delete _customStyles[key];
  renderStyles();
}

// ── File Upload ──
async function uploadFile(type) {
  var inputId = type === "template" ? "uploadTemplate" : "uploadVideo";
  var statusId = type === "template" ? "uploadTemplateStatus" : "uploadVideoStatus";
  var input = document.getElementById(inputId);
  var status = document.getElementById(statusId);
  if (!input.files || !input.files[0]) { status.textContent = "No file selected"; status.className = "upload-status err"; return; }
  var file = input.files[0];
  status.textContent = "Uploading..."; status.className = "upload-status";

  try {
    var url = "/dashboard/api/settings/upload?filename=" + encodeURIComponent(file.name) + "&type=" + encodeURIComponent(type);
    var r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file
    });
    var result = await r.json();
    if (result.error) { status.textContent = result.error; status.className = "upload-status err"; return; }

    status.textContent = "Uploaded " + result.filename;
    status.className = "upload-status";
    input.value = "";

    // Refresh the dropdown and select the new file
    var selectId = type === "template" ? "sTemplate" : "sVideo";
    var placeholder = type === "template" ? "None (no frame)" : "Select video...";
    fillSelect(selectId, result.files, result.filename, placeholder);
  } catch(e) { status.textContent = "Upload failed"; status.className = "upload-status err"; }
}

// ── Refresh Printers ──
async function refreshPrinters() {
  var sel = document.getElementById("sPrinter");
  var current = sel.value;
  sel.innerHTML = '<option value="">Refreshing...</option>';
  try {
    var r = await fetch("/dashboard/api/settings/files");
    var files = await r.json();
    _files.printers = files.printers;
    fillSelect("sPrinter", files.printers || [], current, "Select printer...");
  } catch(e) { fillSelect("sPrinter", [], current, "Error loading printers"); }
}

// ── Save / Reset ──
function showBanner(text, type) {
  var banner = document.getElementById("saveBanner");
  banner.textContent = text;
  banner.className = "save-banner " + type;
  // Reset animation
  banner.style.animation = "none";
  banner.offsetHeight; // force reflow
  banner.style.animation = "";
}

async function saveSettings() {
  var disabledStyles = [];
  document.querySelectorAll('#stylesList input[type="checkbox"]').forEach(function(cb) {
    if (!cb.checked) disabledStyles.push(cb.dataset.style);
  });

  var body = {
    eventName: document.getElementById("sEventName").value,
    maxPrints: parseInt(document.getElementById("sMaxPrints").value) || 2,
    maxConcurrentGeneration: parseInt(document.getElementById("sMaxGen").value) || 3,
    printerName: document.getElementById("sPrinter").value,
    templateFile: document.getElementById("sTemplate").value,
    videoFile: document.getElementById("sVideo").value,
    adminPhones: _adminPhones,
    termsUrl: document.getElementById("sTermsUrl").value,
    promoIntro: document.getElementById("sPromoIntro").value,
    promoReturning: document.getElementById("sPromoReturning").value,
    enablePrinting: document.getElementById("sEnablePrinting").value === "true",
    printSize: document.getElementById("sPrintSize").value,
    printQuality: document.getElementById("sPrintQuality").value,
    customPrintFlags: document.getElementById("sCustomPrintFlags").value,
    leadCaptureMode: document.getElementById("sLeadMode").value,
    brandPrompt: document.getElementById("sBrandPrompt").value,
    defaultStyle: document.getElementById("sDefaultStyle").value,
    disabledStyles: disabledStyles,
    stylePromptOverrides: _stylePromptOverrides,
    customStyles: _customStyles,
  };

  try {
    var r = await fetch("/dashboard/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    _settings = await r.json();

    showBanner("Settings saved -- changes are active immediately.", "success");

    var msg = document.getElementById("saveMsg");
    msg.classList.add("show");
    setTimeout(function() { msg.classList.remove("show"); }, 2500);
  } catch(e) { alert("Failed to save settings: " + e.message); }
}

async function resetSettings() {
  if (!confirm("Reset all settings to defaults?")) return;
  try {
    var r = await fetch("/dashboard/api/settings/reset", { method: "POST" });
    _settings = await r.json();
    _adminPhones = (_settings.adminPhones || []).slice();
    _customStyles = Object.assign({}, _settings.customStyles || {});
    _stylePromptOverrides = {};
    populateSettings();

    showBanner("Settings reset to defaults -- changes are active immediately.", "reset-ok");

    var msg = document.getElementById("saveMsg");
    msg.textContent = "Settings reset!";
    msg.classList.add("show");
    setTimeout(function() { msg.classList.remove("show"); msg.textContent = "Settings saved!"; }, 2500);
  } catch(e) { alert("Failed to reset: " + e.message); }
}
</script>
</body>
</html>`;
} // end buildHomeHtml

function buildVideoHtml() {
const videoFile = settings.get("videoFile");
return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Get Started — Twilio AI Photobooth</title>
<style>
  * { margin: 0; padding: 0; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: #000; }
  video {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
  }
</style>
</head>
<body>
<video id="vid" autoplay loop muted playsinline src="/assets/${videoFile}"></video>
<div style="position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:10;display:flex;align-items:center;gap:8px">
  <div id="playBtn" style="background:rgba(0,0,0,0.6);border:1px solid rgba(255,255,255,0.2);border-radius:8px;padding:8px 18px;color:rgba(255,255,255,0.7);font-family:sans-serif;font-size:13px;cursor:pointer;user-select:none;backdrop-filter:blur(8px);display:flex;align-items:center;gap:6px;transition:all .2s">
    <svg id="pbIcon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
    <span id="pbLabel">Pause</span>
  </div>
  <div id="fsBtn" style="background:rgba(0,0,0,0.6);border:1px solid rgba(255,255,255,0.2);border-radius:8px;padding:8px 18px;color:rgba(255,255,255,0.7);font-family:sans-serif;font-size:13px;cursor:pointer;user-select:none;backdrop-filter:blur(8px);display:flex;align-items:center;gap:6px;transition:all .2s">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
    <span>Fullscreen</span>
  </div>
</div>
<script>
var v = document.getElementById("vid");
v.play().catch(function() {});

// Hide fullscreen button when embedded in combo iframe (combo has its own)
if (window.self !== window.top) {
  document.getElementById("fsBtn").style.display = "none";
}

// Custom play/pause button only — clicking video area does nothing
var pbBtn = document.getElementById("playBtn");
pbBtn.addEventListener("click", function() {
  if (v.paused) { v.play(); document.getElementById("pbIcon").innerHTML = '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>'; document.getElementById("pbLabel").textContent = "Pause"; }
  else { v.pause(); document.getElementById("pbIcon").innerHTML = '<polygon points="5 3 19 12 5 21 5 3"/>'; document.getElementById("pbLabel").textContent = "Play"; }
});

// Fullscreen toggle
document.getElementById("fsBtn").addEventListener("click", function() {
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    if (document.exitFullscreen) document.exitFullscreen();
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
  } else {
    var el = document.documentElement;
    if (el.requestFullscreen) el.requestFullscreen();
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  }
});
</script>
</body>
</html>`;
} // end buildVideoHtml

const COMBO_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Booth Display — Twilio AI Photobooth</title>
<style>
  * { margin: 0; padding: 0; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: #000; }
  .split {
    display: flex; width: 100%; height: 100%;
  }
  .split iframe {
    border: none; height: 100%;
  }
  #leftPane { flex: 1; }
  #rightPane { flex: 1; }
  .handle {
    width: 8px; flex-shrink: 0; cursor: col-resize;
    background: rgba(255,255,255,0.06);
    position: relative; z-index: 10;
    transition: background .15s;
  }
  .handle:hover, .handle.active {
    background: rgba(255,255,255,0.15);
  }
  .handle::after {
    content: ''; position: absolute;
    top: 50%; left: 50%; transform: translate(-50%,-50%);
    width: 3px; height: 36px; border-radius: 2px;
    background: rgba(255,255,255,0.25);
  }
  /* Overlay to capture mouse over iframes during drag */
  .drag-overlay {
    display: none; position: fixed; inset: 0; z-index: 5;
    cursor: col-resize;
  }
  .drag-overlay.active { display: block; }
</style>
</head>
<body>
<div class="split" id="split">
  <iframe id="leftPane" src="/home/video" allow="autoplay; fullscreen" allowfullscreen></iframe>
  <div class="handle" id="handle"></div>
  <iframe id="rightPane" src="/photogallery/" allow="fullscreen" allowfullscreen></iframe>
</div>
<div class="drag-overlay" id="overlay"></div>
<script>
(function() {
  var handle = document.getElementById("handle");
  var overlay = document.getElementById("overlay");
  var left = document.getElementById("leftPane");
  var right = document.getElementById("rightPane");
  var dragging = false;

  handle.addEventListener("mousedown", function(e) {
    e.preventDefault();
    dragging = true;
    handle.classList.add("active");
    overlay.classList.add("active");
  });

  document.addEventListener("mousemove", function(e) {
    if (!dragging) return;
    var x = e.clientX;
    var total = window.innerWidth;
    var pct = (x / total) * 100;
    pct = Math.max(15, Math.min(85, pct));
    left.style.flex = "none";
    right.style.flex = "none";
    left.style.width = pct + "%";
    right.style.width = (100 - pct) + "%";
  });

  document.addEventListener("mouseup", function() {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("active");
    overlay.classList.remove("active");
  });
})();
</script>
</body>
</html>`;

function mountHome(app) {
    app.use("/templates", express.static(path.join(__dirname, "..", "templates")));
    app.use("/assets", express.static(ASSETS_DIR));
    app.use("/home", router);
    console.log("🏠 Home page mounted at /home");
}

module.exports = { mountHome };
