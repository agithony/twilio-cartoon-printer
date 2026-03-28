const path = require("path");
const express = require("express");
const settings = require("./settings");
const brb = require("./brb");
const { userBarSnippet } = require("./auth");

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

router.get("/break", (req, res) => {
    res.type("html").send(buildBreakHtml());
});

router.get("/combo", (req, res) => {
    res.type("html").send(buildComboHtml());
});

function buildHomeHtml() {
return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/assets/icon-twilio-bug-red.svg">
<title>Home — Twilio Photobooth</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { font-size: 17px; }
  body {
    font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0f1219;
    color: #b8c0cc;
    min-height: 100vh;
    padding: clamp(24px, 4vw, 56px) clamp(16px, 3vw, 40px);
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 920px; margin: 0 auto; }

  /* Header */
  .hero { text-align: center; margin-bottom: 48px; padding-top: 8px; }
  .hero-brand { display: flex; align-items: center; justify-content: center; gap: 12px; margin-bottom: 12px; }
  .hero-brand svg { flex-shrink: 0; }
  .hero h1 { font-size: 30px; font-weight: 700; color: #edf0f5; letter-spacing: -0.5px; }
  .hero .subtitle { font-size: 16px; color: #6b7585; font-weight: 400; margin-top: 8px; }

  /* Action cards */
  .actions { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 40px; }
  .action-card {
    background: linear-gradient(145deg, #1a2030, #171c25);
    border: 1px solid #252d3a;
    border-radius: 16px;
    padding: 26px;
    text-decoration: none;
    transition: all .25s ease;
    display: block;
    box-shadow: 0 2px 8px rgba(0,0,0,.1);
  }
  .action-card:hover { border-color: #364050; box-shadow: 0 12px 40px rgba(0,0,0,.25); transform: translateY(-3px); }
  .action-card .card-icon { width: 40px; height: 40px; border-radius: 10px; display: flex; align-items: center; justify-content: center; margin-bottom: 16px; }
  .action-card .card-icon svg { width: 20px; height: 20px; }
  .action-card.dashboard .card-icon { background: rgba(75,139,245,0.1); color: #6199f5; }
  .action-card.booth .card-icon { background: rgba(46,186,84,0.1); color: #3cc968; }
  .action-card.outreach .card-icon { background: rgba(232,133,58,0.1); color: #f0983a; }
  .action-card h2 { font-size: 17px; font-weight: 600; color: #e2e6ec; margin-bottom: 8px; }
  .action-card p { font-size: 14px; color: #6b7585; line-height: 1.6; }

  /* Expandable sub-options */
  .sub-options { overflow: hidden; max-height: 0; transition: max-height .3s ease, margin .3s ease; margin-top: 0; }
  .sub-options.open { max-height: 200px; margin-top: 16px; }
  .sub-toggle {
    display: inline-flex; align-items: center; gap: 5px;
    margin-top: 16px; padding: 0; border: none; background: none;
    font-size: 13px; color: #6b7585;
    cursor: pointer; font-family: inherit; transition: color .15s;
  }
  .sub-toggle:hover { color: #b8c0cc; }
  .sub-toggle svg { width: 12px; height: 12px; transition: transform .25s; }
  .sub-toggle.open svg { transform: rotate(180deg); }
  .sub-links { display: flex; gap: 8px; flex-wrap: wrap; }
  .sub-link {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 8px 16px; border-radius: 8px;
    background: #1c2230; border: 1px solid #2e3744;
    color: #b8c0cc; text-decoration: none;
    font-size: 13px; font-weight: 500; transition: all .15s;
  }
  .sub-link:hover { background: #2e3744; border-color: #313845; color: #e2e6ec; }

  /* Sections */
  .section { margin-bottom: 36px; }
  .section-title {
    font-size: 12px; font-weight: 600; color: #525c6c;
    text-transform: uppercase; letter-spacing: 1px; margin-bottom: 16px;
    padding-bottom: 12px; border-bottom: 1px solid #1c2230;
  }

  /* How it works */
  .steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  @media (max-width: 640px) { .steps { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 420px) { .steps { grid-template-columns: 1fr; } }
  .step {
    background: linear-gradient(145deg, #1a2030, #171c25);
    border: 1px solid #252d3a;
    border-radius: 14px;
    padding: 18px;
    display: flex;
    gap: 12px;
    align-items: flex-start;
    transition: border-color .2s, box-shadow .2s;
  }
  .step:hover { border-color: #2e3744; box-shadow: 0 2px 8px rgba(0,0,0,.1); }
  .step-num {
    display: inline-flex; align-items: center; justify-content: center;
    width: 24px; height: 24px; border-radius: 50%; flex-shrink: 0;
    background: rgba(242,47,70,0.08); color: #F22F46;
    font-size: 12px; font-weight: 700;
  }
  .step-text { font-size: 13px; color: #94a0b0; line-height: 1.5; }
  .step-text a { color: #6199f5; text-decoration: none; font-weight: 500; transition: color .15s; }
  .step-text a:hover { color: #6BA3F7; text-decoration: underline; }

  .footer {
    text-align: center; color: #525c6c; font-size: 12px; font-weight: 500;
    margin-top: 48px; padding-top: 24px; border-top: 1px solid #1c2230;
  }
  .footer a { color: #6b7585; text-decoration: none; }
  .footer a:hover { color: #94a0b0; }

  /* Settings panel */
  .settings-toggle {
    display: flex; align-items: center; gap: 12px; cursor: pointer;
    padding: 20px 26px;
    background: linear-gradient(145deg, #1a2030, #171c25); border: 1px solid #252d3a; border-radius: 16px;
    margin-bottom: 16px; transition: all .25s ease; user-select: none;
    box-shadow: 0 2px 8px rgba(0,0,0,.08);
  }
  .settings-toggle:hover { border-color: #364050; background: linear-gradient(145deg, #1e2538, #1a2030); box-shadow: 0 4px 16px rgba(0,0,0,.15); }
  .settings-toggle.open { border-color: #2e3744; background: linear-gradient(145deg, #1e2538, #1a2030); margin-bottom: 0; border-radius: 16px 16px 0 0; border-bottom-color: #252d3a; }
  .settings-toggle h3 { font-size: 13px; font-weight: 700; color: #6b7585; text-transform: uppercase; letter-spacing: 1.5px; }
  .settings-toggle svg { width: 14px; height: 14px; color: #525c6c; margin-left: auto; transition: transform .3s ease; }
  .settings-toggle.open svg { transform: rotate(180deg); color: #6b7585; }
  .settings-panel { overflow: hidden; max-height: 0; transition: max-height .4s ease, overflow 0s .4s; padding: 0 2px; }
  .settings-panel.open { max-height: 15000px; overflow: visible; transition: max-height .5s ease, overflow 0s 0s; padding-top: 16px; }
  .sg { background: linear-gradient(160deg, #1a2030, #171c25); border: 1px solid #252d3a; border-radius: 16px; padding: 26px; margin-bottom: 14px; transition: all .2s ease; box-shadow: 0 2px 8px rgba(0,0,0,.08); }
  .sg:hover { border-color: #2e3744; box-shadow: 0 4px 16px rgba(0,0,0,.15); }
  .sg h4 { font-size: 15px; font-weight: 600; color: #e2e6ec; margin-bottom: 18px; padding-left: 12px; border-left: 3px solid #F22F46; line-height: 1.1; padding-top: 2px; padding-bottom: 2px; }
  .sg-group { margin-bottom: 8px; }
  .sg-group:last-of-type { margin-bottom: 0; }
  .sg-group-header {
    font-size: 11px; font-weight: 700; color: #525c6c;
    text-transform: uppercase; letter-spacing: 2px;
    padding: 10px 0;
    display: flex; align-items: center; gap: 14px;
    cursor: pointer; user-select: none; transition: color .15s;
  }
  .sg-group-header:hover { color: #94a0b0; }
  .sg-group-header::before {
    content: ''; display: inline-block; width: 6px; height: 6px;
    border-right: 2px solid currentColor; border-bottom: 2px solid currentColor;
    transform: rotate(-45deg); transition: transform .2s ease;
    flex-shrink: 0;
  }
  .sg-group.open .sg-group-header::before { transform: rotate(45deg); }
  .sg-group-header::after { content: ''; flex: 1; height: 1px; background: linear-gradient(to right, #252d3a, transparent); }
  .sg-group-body { display: none; padding-top: 8px; padding-bottom: 12px; }
  .sg-group.open .sg-group-body { display: block; }
  .sg-group:nth-child(1) .sg h4 { border-left-color: #F22F46; }
  .sg-group:nth-child(2) .sg h4 { border-left-color: #c084fc; }
  .sg-group:nth-child(3) .sg h4 { border-left-color: #6199f5; }
  .sg-group:nth-child(4) .sg h4 { border-left-color: #3cc968; }
  .sg-group:nth-child(5) .sg h4 { border-left-color: #f0983a; }
  .sg-group:nth-child(6) .sg h4 { border-left-color: #e879a8; }
  .sg-group:nth-child(7) .sg h4 { border-left-color: #525c6c; }
  .sf-sub-label {
    font-size: 11px; font-weight: 700; color: #525c6c;
    text-transform: uppercase; letter-spacing: 1.5px;
    margin-bottom: 14px; padding-bottom: 0;
  }
  .sf { margin-bottom: 18px; }
  .sf:last-child { margin-bottom: 0; }
  .sf label { display: block; font-size: 13px; color: #6b7585; margin-bottom: 8px; font-weight: 500; letter-spacing: 0.01em; }
  .sf input[type="text"], .sf input[type="number"], .sf input[type="url"], .sf input[type="password"], .sf select, .sf textarea {
    width: 100%; padding: 11px 14px; border-radius: 10px; border: 1px solid #252d3a;
    background: #0f1219; color: #e2e6ec; font-size: 14px; font-family: inherit;
    transition: border-color .2s, box-shadow .2s;
  }
  .sf input:focus, .sf select:focus, .sf textarea:focus { outline: none; border-color: #6199f5; box-shadow: 0 0 0 3px rgba(75,139,245,0.08); }
  .sf textarea { resize: vertical; min-height: 64px; line-height: 1.5; }
  .combo-box { position: relative; }
  .combo-box input { padding-right: 36px; }
  .combo-arrow {
    position: absolute; right: 1px; top: 1px; bottom: 1px; width: 34px;
    background: none; border: none; cursor: pointer; color: #525c6c;
    display: flex; align-items: center; justify-content: center;
    border-radius: 0 8px 8px 0; transition: color .15s;
  }
  .combo-arrow:hover { color: #b8c0cc; }
  .combo-dropdown {
    display: none; position: absolute; left: 0; right: 0; top: 100%; margin-top: 4px;
    background: #1c2230; border: 1px solid #313845; border-radius: 8px;
    max-height: 180px; overflow-y: auto; z-index: 50;
    box-shadow: 0 10px 32px rgba(0,0,0,.5), 0 0 0 1px rgba(75,139,245,0.08);
  }
  .combo-dropdown.open { display: block; }
  .combo-dropdown .combo-item {
    padding: 9px 14px; font-size: 14px; color: #b8c0cc; cursor: pointer;
    transition: background .1s, color .1s; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    border-bottom: 1px solid #2e3744;
  }
  .combo-dropdown .combo-item:last-child { border-bottom: none; }
  .combo-dropdown .combo-item:first-child { border-radius: 7px 7px 0 0; }
  .combo-dropdown .combo-item:last-child { border-radius: 0 0 7px 7px; }
  .combo-dropdown .combo-item:only-child { border-radius: 7px; }
  .combo-dropdown .combo-item:hover, .combo-dropdown .combo-item.active { background: #2e3744; color: #e2e6ec; }
  .combo-dropdown .combo-item .combo-current { font-size: 11px; color: #6199f5; margin-left: 6px; }
  .combo-dropdown .combo-item .combo-saved { font-size: 10px; color: #1b8a5a; background: rgba(27,138,90,0.12); padding: 1px 6px; border-radius: 3px; margin-left: 6px; }
  .combo-dropdown .combo-item.combo-create { color: #1b8a5a; font-weight: 500; }
  .combo-dropdown .combo-item.combo-create:hover { color: #23b06e; background: rgba(27,138,90,0.08); }
  .combo-dropdown .combo-empty { padding: 9px 14px; font-size: 13px; color: #525c6c; font-style: italic; }
  .sf-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 540px) { .sf-row { grid-template-columns: 1fr; } }
  .preview-box { margin-top: 12px; display: none; text-align: center; }
  .preview-box img { max-width: 100%; max-height: 200px; border-radius: 8px; border: 1px solid #252d3a; background: #0f1219; }
  .preview-box video { max-width: 100%; max-height: 160px; border-radius: 8px; border: 1px solid #252d3a; background: #0f1219; }
  .preview-box .no-preview { font-size: 12px; color: #525c6c; font-style: italic; }
  .style-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
  .style-card {
    background: #0E1117; border: 1px solid #1c2230; border-radius: 12px; overflow: hidden;
    transition: all .2s;
  }
  .style-card:hover { border-color: #313845; box-shadow: 0 4px 16px rgba(0,0,0,.2); }
  .style-card.disabled { opacity: .35; filter: grayscale(0.3); }
  .style-card-thumb {
    width: 100%; aspect-ratio: 5/7; background: #0f1219; display: flex;
    align-items: center; justify-content: center; overflow: hidden;
  }
  .style-card-thumb img { width: 100%; height: 100%; object-fit: cover; }
  .style-card-thumb .no-thumb { font-size: 11px; color: #2D3340; }
  .style-card-body { padding: 12px; }
  .style-card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px; }
  .style-card-header .sname { font-size: 14px; font-weight: 600; color: #b8c0cc; }
  .style-card-header input.sname-edit { font-size: 14px; font-weight: 600; color: #b8c0cc; background: transparent; border: 1px solid transparent; border-radius: 4px; padding: 1px 4px; font-family: inherit; width: 100%; transition: border-color .2s; }
  .style-card-header input.sname-edit:hover { border-color: #2e3744; }
  .style-card-header input.sname-edit:focus { outline: none; border-color: #6199f5; background: #0E1117; }
  .style-card-header .slabel { font-size: 11px; color: #525c6c; }
  .style-card-actions { display: flex; align-items: center; justify-content: space-between; margin-top: 6px; }
  .style-card-actions .prompt-link { font-size: 11px; color: #6199f5; cursor: pointer; background: none; border: none; padding: 0; font-family: inherit; }
  .style-card-actions .prompt-link:hover { text-decoration: underline; }
  .style-card-actions .remove-link { font-size: 11px; color: #F22F46; cursor: pointer; background: none; border: none; padding: 0; font-family: inherit; }
  .style-card-actions .remove-link:hover { text-decoration: underline; }
  .toggle-sw { position: relative; width: 38px; height: 22px; flex-shrink: 0; }
  .toggle-sw input { opacity: 0; width: 0; height: 0; }
  .toggle-sw .slider { position: absolute; inset: 0; border-radius: 11px; background: #364050; cursor: pointer; transition: background .25s; }
  .toggle-sw .slider::before { content: ''; position: absolute; left: 3px; top: 3px; width: 16px; height: 16px; border-radius: 50%; background: #6b7585; transition: transform .25s, background .25s; box-shadow: 0 1px 3px rgba(0,0,0,.3); }
  .toggle-sw input:checked + .slider { background: #3cc968; }
  .toggle-sw input:checked + .slider::before { background: #fff; transform: translateX(16px); }
  .delivery-switch { display: flex; gap: 0; border-radius: 12px; overflow: hidden; border: 1px solid #252d3a; }
  .delivery-switch button {
    flex: 1; padding: 12px 16px; border: none; cursor: pointer; font-size: 14px; font-weight: 600;
    font-family: inherit; transition: all .2s; display: flex; align-items: center; justify-content: center; gap: 8px;
  }
  .delivery-switch button.ds-print {
    background: #1c2230; color: #525c6c;
  }
  .delivery-switch button.ds-print.active {
    background: #3cc96822; color: #3cc968; box-shadow: inset 0 0 0 1px #3cc96866;
  }
  .delivery-switch button.ds-digital {
    background: #1c2230; color: #525c6c;
  }
  .delivery-switch button.ds-digital.active {
    background: #6199f522; color: #6199f5; box-shadow: inset 0 0 0 1px #6199f566;
  }
  .delivery-switch button svg { width: 16px; height: 16px; flex-shrink: 0; }
  .delivery-switch button.lc-btn { background: #1c2230; color: #525c6c; }
  .delivery-switch button.lc-btn.active { background: #a87fee22; color: #a87fee; box-shadow: inset 0 0 0 1px #a87fee66; }
  .delivery-status.mode-lead { background: #a87fee12; color: #a87fee; border: 1px solid #a87fee33; }
  .delivery-status { font-size: 12px; font-weight: 500; margin-top: 10px; padding: 8px 14px; border-radius: 8px; transition: all .2s; }
  .delivery-status.mode-both { background: #3cc96810; color: #3cc968; border: 1px solid #3cc96825; }
  .delivery-status.mode-digital { background: #6199f510; color: #6199f5; border: 1px solid #6199f525; }
  .phone-tags { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
  .phone-tag { display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; border-radius: 8px; background: #1c2230; color: #b8c0cc; font-size: 13px; font-family: monospace; border: 1px solid #252d3a; transition: border-color .15s; }
  .phone-tag:hover { border-color: #2e3744; }
  .phone-tag .remove { cursor: pointer; color: #525c6c; font-weight: bold; font-size: 13px; line-height: 1; transition: color .15s; }
  .phone-tag .remove:hover { color: #F22F46; }
  .phone-add { display: flex; gap: 8px; }
  .phone-add input { flex: 1; }
  .brand-ref-tags { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
  .brand-ref-tag { display: inline-flex; align-items: center; gap: 8px; padding: 5px 12px; border-radius: 8px; background: #1c2230; color: #6b7585; font-size: 13px; border: 1px solid #252d3a; transition: border-color .15s, opacity .15s; cursor: pointer; opacity: 0.6; }
  .brand-ref-tag.selected { color: #b8c0cc; border-color: #4b8bf5; opacity: 1; }
  .brand-ref-tag:hover { border-color: #2e3744; }
  .brand-ref-tag.selected:hover { border-color: #6199f5; }
  .brand-ref-tag input[type="checkbox"] { accent-color: #4b8bf5; margin: 0; cursor: pointer; }
  .brand-ref-tag img { width: 32px; height: 32px; object-fit: cover; border-radius: 6px; }
  .brand-ref-tag .brand-ref-delete { cursor: pointer; color: #525c6c; font-weight: bold; font-size: 13px; line-height: 1; transition: color .15s; margin-left: 2px; }
  .brand-ref-tag .brand-ref-delete:hover { color: #F22F46; }
  .btn { padding: 10px 20px; border-radius: 10px; border: 1px solid #2e3744; background: #1c2230; color: #b8c0cc; font-size: 14px; font-weight: 500; cursor: pointer; transition: all .2s; font-family: inherit; }
  .btn:hover { background: #2e3744; border-color: #313845; color: #e2e6ec; transform: translateY(-1px); }
  .btn:active { transform: translateY(0); }
  .btn-primary { background: linear-gradient(135deg, #F22F46, #e0283e); border-color: #F22F46; color: #fff; box-shadow: 0 2px 8px rgba(242,47,70,0.2); }
  .btn-primary:hover { background: linear-gradient(135deg, #ff3a52, #F22F46); border-color: #ff3a52; box-shadow: 0 6px 20px rgba(242,47,70,0.3); }
  .btn-danger { border-color: rgba(242,47,70,0.2); color: #F22F46; }
  .btn-danger:hover { background: rgba(242,47,70,0.06); }
  .settings-actions {
    display: none; gap: 12px; align-items: center;
    padding: 16px 24px; position: sticky; bottom: 16px;
    background: #171c25ee; backdrop-filter: blur(12px);
    border: 1px solid #2e3744; border-radius: 14px;
    margin-top: 16px; z-index: 10;
    box-shadow: 0 -4px 24px rgba(0,0,0,.3);
  }
  .custom-style-form { margin-top: 14px; padding: 20px; border-radius: 12px; background: #0f1219; border: 1px solid #252d3a; }
  .custom-style-form .sf { margin-bottom: 12px; }
  .tip {
    display: inline-flex; align-items: center; justify-content: center;
    width: 16px; height: 16px; border-radius: 50%; background: #252d3a; color: #525c6c;
    font-size: 10px; font-weight: 700; cursor: help; position: relative;
    margin-left: 5px; vertical-align: middle; flex-shrink: 0; transition: all .15s;
  }
  .tip:hover { background: #313845; color: #b8c0cc; }
  .tip:hover::after {
    content: attr(data-tip); position: absolute; bottom: calc(100% + 10px); left: 50%; transform: translateX(-50%);
    background: #1c2230; color: #b8c0cc; padding: 12px 16px; border-radius: 10px;
    font-size: 12px; font-weight: 400; line-height: 1.6; white-space: normal;
    width: max-content; max-width: 300px; z-index: 100; box-shadow: 0 12px 32px rgba(0,0,0,.6);
    pointer-events: none; border: 1px solid #2e3744;
  }
  .tip:hover::before {
    content: ''; position: absolute; bottom: calc(100% + 5px); left: 50%; transform: translateX(-50%);
    border: 5px solid transparent; border-top-color: #1c2230; z-index: 100;
  }
  .sg-help { display: inline; }
  .sg-help .tip { margin-left: 6px; }
  .file-upload-row { display: flex; gap: 10px; align-items: center; margin-top: 10px; flex-wrap: wrap; }
  .file-upload-row input[type="file"] { font-size: 12px; color: #525c6c; }
  .file-upload-row input[type="file"]::file-selector-button {
    padding: 7px 14px; border-radius: 8px; border: 1px solid #2e3744; background: #1c2230;
    color: #b8c0cc; font-size: 12px; cursor: pointer; font-family: inherit; transition: all .2s; margin-right: 4px;
  }
  .file-upload-row input[type="file"]::file-selector-button:hover { background: #2e3744; color: #e2e6ec; }
  .upload-status { font-size: 12px; color: #3cc968; font-weight: 500; }
  .upload-status.err { color: #F22F46; }
  .save-banner {
    position: fixed; top: 24px; left: 50%; transform: translateX(-50%) translateY(-20px);
    padding: 14px 28px; border-radius: 12px; font-size: 14px; font-weight: 600;
    text-align: center; z-index: 1000; pointer-events: none;
    display: none; animation: bannerSlide 3.5s ease forwards;
    box-shadow: 0 8px 32px rgba(0,0,0,.4);
  }
  .save-banner.success { display: block; background: #1a2e1f; color: #3cc968; border: 1px solid rgba(46,186,84,0.25); }
  .save-banner.reset-ok { display: block; background: #1a2230; color: #6199f5; border: 1px solid rgba(75,139,245,0.25); }
  @keyframes bannerSlide { 0% { opacity: 0; transform: translateX(-50%) translateY(-20px); } 8% { opacity: 1; transform: translateX(-50%) translateY(0); } 75% { opacity: 1; transform: translateX(-50%) translateY(0); } 100% { opacity: 0; transform: translateX(-50%) translateY(-10px); } }
  @keyframes spin { to { transform: rotate(360deg); } }
  .btn-sm { padding: 6px 12px; font-size: 12px; }
  .select-row { display: flex; gap: 8px; align-items: center; }
  .select-row select { flex: 1; }
  textarea.style-prompt { display: none; margin-top: 8px; padding: 8px 10px; border-radius: 6px; background: #0f1219; border: 1px solid #1c2230; font-size: 11px; color: #b8c0cc; line-height: 1.5; width: 100%; resize: vertical; font-family: inherit; min-height: 80px; transition: border-color .2s; }
  textarea.style-prompt:focus { outline: none; border-color: #6199f5; box-shadow: 0 0 0 3px rgba(75,139,245,0.1); }
  textarea.style-prompt.open { display: block; }
  .reset-link { font-size: 11px; color: #6b7585; cursor: pointer; background: none; border: none; padding: 2px 6px; font-family: inherit; border-radius: 3px; transition: color .15s, background .15s; }
  .reset-link:hover { color: #f0983a; background: rgba(240,152,58,0.08); }
  .style-card-actions .reset-link { display: none; padding: 0; }
  .style-card-actions .reset-link.visible { display: inline; }
</style>
</head>
<body>
<div class="wrap">

<div id="reviewNotify" style="display:none;background:linear-gradient(90deg,#f0983a,#F22F46);color:#fff;padding:12px 20px;border-radius:10px;margin-bottom:16px;font-size:14px;font-weight:600;display:none;align-items:center;justify-content:space-between;animation:rn-pulse 2s ease-in-out infinite">
  <span id="reviewNotifyText"></span>
  <a href="/dashboard/" style="color:#fff;background:rgba(0,0,0,.25);padding:6px 14px;border-radius:6px;text-decoration:none;font-size:12px;font-weight:700;white-space:nowrap">Go to Dashboard</a>
</div>
<style>
  @keyframes rn-pulse { 0%,100%{opacity:1} 50%{opacity:.85} }
</style>

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

<!-- How It Works -->
<div class="section">
  <div class="section-title">How It Works</div>
  <div class="steps">
    <div class="step"><div class="step-num">1</div><div class="step-text">Configure your event, styles, and printer in <a href="#" onclick="document.querySelector('.settings-toggle').click();return false">Settings</a> below</div></div>
    <div class="step"><div class="step-num">2</div><div class="step-text"><a href="/home/combo" target="_blank">Launch the Booth Display</a> on a monitor for attendees to see</div></div>
    <div class="step"><div class="step-num">3</div><div class="step-text">Attendees text a selfie to your Twilio number with a style name</div></div>
    <div class="step"><div class="step-num">4</div><div class="step-text">AI generates their portrait and it prints at your booth. Monitor progress in the <a href="/dashboard/" target="_blank">Dashboard</a></div></div>
    <div class="step"><div class="step-num">5</div><div class="step-text">They get an SMS with their portrait when it's ready to pick up</div></div>
    <div class="step"><div class="step-num">6</div><div class="step-text">Use <a href="/outreach/" target="_blank">Outreach</a> to send broadcasts, run raffles, download lead reports, and engage attendees</div></div>
  </div>
</div>

<!-- Settings -->
<div class="section">
  <div class="settings-toggle" id="settingsToggle" onclick="this.classList.toggle('open');document.getElementById('settingsPanel').classList.toggle('open');document.getElementById('settingsActions').style.display=this.classList.contains('open')?'flex':'none';if(this.classList.contains('open'))loadSettings()">
    <h3>Settings</h3>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
  </div>
  <div class="settings-panel" id="settingsPanel">

    <div class="sg-group">
    <div class="sg-group-header" onclick="this.parentElement.classList.toggle('open')">Event</div>
    <div class="sg-group-body">

    <div class="sg"><h4>Event <span class="tip" data-tip="Core event configuration — name, quotas, admin access, and generation throughput.">?</span></h4>
      <div class="sf-row">
        <div class="sf"><label>Event Name <span class="tip" data-tip="Identifies this event. Used in SMS messages and to separate download folders per event. Select an existing event or type a new name.">?</span></label>
          <div class="combo-box" id="eventCombo">
            <input type="text" id="sEventName" placeholder="e.g. SIGNAL2025" autocomplete="off" onfocus="openEventDropdown()" oninput="filterEventDropdown()">
            <button type="button" class="combo-arrow" onclick="toggleEventDropdown()" tabindex="-1"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>
            <div class="combo-dropdown" id="eventDropdown"></div>
          </div>
        </div>
        <div class="sf"><label>Max Prints Per User <span class="tip" data-tip="How many free prints each attendee gets. Admin numbers are unlimited.">?</span></label><input type="number" id="sMaxPrints" min="1"></div>
      </div>
      <div class="sf"><label>Admin Phone Numbers <span class="tip" data-tip="Phone numbers in E.164 format (e.g. +14155551234). Admins get unlimited prints and are excluded from dashboard metrics.">?</span></label>
        <div class="phone-tags" id="phoneTags"></div>
        <div class="phone-add"><input type="text" id="phoneInput" placeholder="+14155551234"><button class="btn" onclick="addPhone()">Add</button></div>
      </div>
    </div>

    </div></div><!-- /Event -->

    <div class="sg-group">
    <div class="sg-group-header" onclick="this.parentElement.classList.toggle('open')">Art &amp; Branding</div>
    <div class="sg-group-body">

    <div class="sg"><h4>Art &amp; Branding <span class="tip" data-tip="Configure AI art generation. The brand prompt is appended to every style for event-specific branding like clothing or logos. Toggle individual styles on/off below.">?</span></h4>
      <div class="sf"><label>Default Style <span class="tip" data-tip="The style used when someone sends a photo without specifying one.">?</span></label><select id="sDefaultStyle"></select></div>
      <div class="sf"><label>Brand Prompt <span class="tip" data-tip="Applied to all styles. Use for clothing, logos, or visual themes that should appear in every portrait. Leave blank to disable.">?</span></label><textarea id="sBrandPrompt" rows="3" placeholder="e.g. The subject should be wearing a bright red Twilio t-shirt with the Twilio logo clearly visible"></textarea></div>
      <div class="sf">
        <label>Brand Reference Files <span class="tip" data-tip="Upload images (PNG, JPG, GIF) as visual references for the AI — logos, color palettes, outfit designs, brand guidelines. These are sent alongside every portrait. Export PDFs as images before uploading.">?</span></label>
        <div class="brand-ref-tags" id="brandRefList"></div>
        <div class="file-upload-row"><input type="file" id="uploadBrandRef" accept=".png,.jpg,.jpeg,.gif" multiple><button class="btn btn-sm" onclick="uploadBrandRefs()">Upload</button><span class="upload-status" id="uploadBrandRefStatus"></span></div>
      </div>
      <div class="sf">
          <label>Template Frame <span class="tip" data-tip="A PNG overlay composited on top of every generated portrait. Use None for no frame.">?</span></label>
          <select id="sTemplate" onchange="updateTemplatePreview()"><option value="">None</option></select>
          <div class="file-upload-row"><input type="file" id="uploadTemplate" accept=".png,.jpg,.jpeg,.gif,.svg"><button class="btn btn-sm" onclick="uploadFile('template')">Upload</button><span class="upload-status" id="uploadTemplateStatus"></span></div>
          <div class="preview-box" id="templatePreview"></div>
          <div class="sf" id="frameBorderSection" style="margin-top:8px">
            <label style="display:flex;align-items:center;gap:8px">Frame Border <span class="tip" data-tip="Adds padding between the AI portrait and the template frame. Disable to have the portrait fill edge-to-edge with no gap.">?</span>
              <label class="toggle-sw" style="margin-left:auto"><input type="checkbox" id="frameBorderToggle" checked onchange="toggleFrameBorder(this.checked)"><span class="slider"></span></label>
            </label>
            <div id="frameBorderColorRow" style="display:flex;align-items:center;gap:8px;margin-top:6px">
              <input type="color" id="sFrameBorderColor" value="#000000" style="width:36px;height:28px;padding:0;border:1px solid #2e3744;border-radius:4px;background:transparent;cursor:pointer" oninput="document.getElementById('frameBorderColorLabel').textContent=this.value">
              <span style="font-size:13px;color:#6b7585" id="frameBorderColorLabel">#000000</span>
            </div>
          </div>
        </div>
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

    <div class="sg"><h4>Background <span class="tip" data-tip="Control the background of generated portraits. The default prompt is used when background selection is off. When enabled, users pick their background via SMS after choosing an art style.">?</span></h4>
      <div class="sf"><label>Default Background Prompt <span class="tip" data-tip="Background instruction appended to every generation. Used when background selection is disabled or as the fallback. Leave blank to let the AI decide freely.">?</span></label><textarea id="sPromptBackground" rows="2"></textarea><button class="reset-link visible" style="margin-top:4px" onclick="document.getElementById('sPromptBackground').value=_promptDefaults.background">reset</button></div>
      <input type="hidden" id="sEnableBackgroundMenu" value="false">
      <div class="sf">
        <label style="display:flex;align-items:center;gap:10px">
          Enable Background Selection
          <span class="tip" data-tip="When enabled, users pick a background from the list below via SMS after choosing their art style. When disabled, the default background prompt above is used for all portraits.">?</span>
          <label class="toggle-sw">
            <input type="checkbox" id="bgMenuToggle" onchange="toggleBackgroundMenu(this.checked)">
            <span class="slider"></span>
          </label>
        </label>
      </div>
      <div id="bgChoicesSection" style="display:none">
        <div id="bgChoicesList"></div>
        <div style="margin-top:8px">
          <button class="btn btn-sm" onclick="document.getElementById('addBgForm').style.display=document.getElementById('addBgForm').style.display==='none'?'block':'none'">+ Add Background Option</button>
          <div id="addBgForm" style="display:none;margin-top:8px">
            <div class="sf"><label>Name</label><input type="text" id="bgNewName" placeholder="e.g. City Skyline"></div>
            <div class="sf"><label>Prompt</label><textarea id="bgNewPrompt" rows="2" placeholder="Background: A dramatic city skyline at sunset..."></textarea></div>
            <button class="btn btn-primary btn-sm" onclick="addBackgroundChoice()">Add</button>
          </div>
        </div>
      </div>
    </div>

    </div></div><!-- /Art & Branding -->

    <div class="sg-group">
    <div class="sg-group-header" onclick="this.parentElement.classList.toggle('open')">AI Prompts</div>
    <div class="sg-group-body">

    <div class="sg"><h4>AI Prompts <span class="tip" data-tip="All AI prompts used in generation, vision analysis, and smart replies. Changes take effect immediately for new jobs.">?</span></h4>
      <p style="font-size:12px;color:#6b7585;margin-bottom:12px">These prompts control how the AI processes photos. Edit to customize behavior without restarting the server.</p>
      <div class="sf"><label>Preserve Line <span class="tip" data-tip="Tells the AI which features to preserve from the original photo. Used in all built-in style prompts.">?</span></label><textarea id="sPromptPreserve" rows="3"></textarea><button class="reset-link visible" style="margin-top:4px" onclick="document.getElementById('sPromptPreserve').value=_promptDefaults.preserve">reset</button></div>
      <div class="sf"><label>Composition Line <span class="tip" data-tip="Controls framing and positioning instructions. Used in all built-in style prompts.">?</span></label><textarea id="sPromptComposition" rows="2"></textarea><button class="reset-link visible" style="margin-top:4px" onclick="document.getElementById('sPromptComposition').value=_promptDefaults.composition">reset</button></div>
      <div class="sf"><label>Preserve Line (Brand Mode) <span class="tip" data-tip="Used instead of the full preserve line when brand references are active. Omits clothing since brands override it.">?</span></label><textarea id="sPromptPreserveBrand" rows="2"></textarea><button class="reset-link visible" style="margin-top:4px" onclick="document.getElementById('sPromptPreserveBrand').value=_promptDefaults.preserveBrand">reset</button></div>
      <div class="sf"><label>Brand Instruction <span class="tip" data-tip="Tells the AI to apply brand reference images to subjects and reproduce them exactly. Used when brand reference files are uploaded.">?</span></label><textarea id="sPromptBrandInstruction" rows="3"></textarea><button class="reset-link visible" style="margin-top:4px" onclick="document.getElementById('sPromptBrandInstruction').value=_promptDefaults.brandInstruction">reset</button></div>
      <div class="sf"><label>Face Detection <span class="tip" data-tip="Vision prompt to check if a photo contains a visible face. Must produce YES/NO output.">?</span></label><textarea id="sPromptFaceDetection" rows="3"></textarea><button class="reset-link visible" style="margin-top:4px" onclick="document.getElementById('sPromptFaceDetection').value=_promptDefaults.faceDetection">reset</button></div>
      <div class="sf"><label>Scene Analysis <span class="tip" data-tip="Vision prompt to detect number of subjects, pets, and positions. Output should follow the Subjects/Pets/Positions format.">?</span></label><textarea id="sPromptSceneAnalysis" rows="4"></textarea><button class="reset-link visible" style="margin-top:4px" onclick="document.getElementById('sPromptSceneAnalysis').value=_promptDefaults.sceneAnalysis">reset</button></div>
      <div class="sf"><label>Smart Reply System Prompt <span class="tip" data-tip="System prompt for conversational AI replies. Variables: {eventName}, {styleChoices}, {remainingLine}">?</span></label><textarea id="sPromptSmartReply" rows="5"></textarea><button class="reset-link visible" style="margin-top:4px" onclick="document.getElementById('sPromptSmartReply').value=_promptDefaults.smartReply">reset</button></div>
      <div class="sf"><label>User Directive <span class="tip" data-tip="Short directive sent in the user message alongside the images. The developer message contains all the style/brand rules; this is just the action command.">?</span></label><textarea id="sPromptUserDirective" rows="1"></textarea><button class="reset-link visible" style="margin-top:4px" onclick="document.getElementById('sPromptUserDirective').value=_promptDefaults.userDirective">reset</button></div>
    </div>

    </div></div><!-- /AI Prompts -->

    <div class="sg-group">
    <div class="sg-group-header" onclick="this.parentElement.classList.toggle('open')">Delivery</div>
    <div class="sg-group-body">

    <div class="sg"><h4>Delivery &amp; Printing <span class="tip" data-tip="Configure delivery mode and physical printer settings. Disable printing to run digital-only (no printer required).">?</span></h4>
      <input type="hidden" id="sEnablePrinting" value="true">
      <div class="sf">
        <label style="margin-bottom:8px">Delivery Mode</label>
        <div class="delivery-switch">
          <button type="button" class="ds-print active" onclick="setDeliveryMode(true)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg> Print + Digital</button>
          <button type="button" class="ds-digital" onclick="setDeliveryMode(false)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg> Digital Only</button>
        </div>
        <div class="delivery-status mode-both" id="deliveryStatus">Portraits are printed and sent via MMS</div>
      </div>
      <div id="printerSection">
        <div class="sf">
          <label>Active Printers <span class="tip" data-tip="Check the printers you want to use. Multiple printers print concurrently for faster throughput. Click Refresh if you just connected a new printer.">?</span></label>
          <div id="printerChecklist" style="margin-bottom:8px"><div style="display:flex;align-items:center;gap:8px;padding:8px 0"><svg width="16" height="16" viewBox="0 0 24 24" style="animation:spin 1s linear infinite;color:#525c6c"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" stroke-dasharray="30 70" stroke-linecap="round"/></svg><span style="color:#6b7585;font-size:13px">Detecting printers...</span></div></div>
          <div style="display:flex;align-items:center;gap:12px">
            <button class="btn btn-sm" onclick="refreshPrinters()">Refresh</button>
            <span id="printerCount" style="font-size:13px;color:#6b7585"></span>
          </div>
        </div>
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
        <label>Print Relay Key <span class="tip" data-tip="Shared secret for the remote print relay agent. Set this to enable cloud-to-local printing. Run on your event laptop: pnpm relay --url YOUR_APP_URL --key THIS_KEY. Leave blank to disable.">?</span></label>
        <input type="text" id="sPrintRelayKey" placeholder="Enter a secret key">
      </div>
    </div>

    </div></div><!-- /Delivery -->

    <div class="sg-group">
    <div class="sg-group-header" onclick="this.parentElement.classList.toggle('open')">Booth Display</div>
    <div class="sg-group-body">

    <div class="sg"><h4>Booth Display <span class="tip" data-tip="Configure what attendees see on the booth monitor — intro video and legal terms.">?</span></h4>
      <div class="sf">
        <label>Intro Video <span class="tip" data-tip="Looping video shown on the booth display to attract attendees.">?</span></label>
        <select id="sVideo" onchange="updateVideoPreview()"><option value="">Loading...</option></select>
        <div class="file-upload-row"><input type="file" id="uploadVideo" accept=".mp4,.webm,.mov"><button class="btn btn-sm" onclick="uploadFile('video')">Upload</button><span class="upload-status" id="uploadVideoStatus"></span></div>
        <div class="preview-box" id="videoPreview"></div>
      </div>
      <div class="sf"><label>Terms URL <span class="tip" data-tip="Displayed on booth screens (video, combo, photo gallery). Leave blank to hide.">?</span></label><input type="url" id="sTermsUrl" placeholder="https://example.com/terms"></div>
    </div>

    </div></div><!-- /Booth Display -->

    <div class="sg-group">
    <div class="sg-group-header" onclick="this.parentElement.classList.toggle('open')">Engagement</div>
    <div class="sg-group-body">

    <div class="sg"><h4>Lead Capture <span class="tip" data-tip="Capture attendee contact info via a quick SMS survey. Toggle on to enable, then choose whether the survey happens before or after their portrait is created.">?</span></h4>
      <input type="hidden" id="sLeadMode" value="disabled">
      <div class="sf">
        <label style="display:flex;align-items:center;gap:10px">
          Enable Lead Capture
          <label class="toggle-sw">
            <input type="checkbox" id="lcToggle" onchange="toggleLeadCapture(this.checked)">
            <span class="slider"></span>
          </label>
        </label>
      </div>
      <div id="lcTimingSection" style="display:none">
        <div class="sf">
          <label>Timing</label>
          <div class="delivery-switch" style="max-width:320px">
            <button type="button" class="lc-btn active" data-mode="before" onclick="setLeadTiming('before')">Before Portrait</button>
            <button type="button" class="lc-btn" data-mode="after" onclick="setLeadTiming('after')">After Portrait</button>
          </div>
          <div class="delivery-status mode-lead" id="leadStatus">Attendees complete a quick survey before their portrait is created</div>
        </div>
        <div style="margin-top:18px;padding-top:16px;border-top:1px solid #252d3a">
          <div class="sf-sub-label">Survey Messages</div>
          <div class="sf"><label>Intro (Before Mode) <span class="tip" data-tip="Sent before the first question in 'before' mode.">?</span></label><textarea id="msgLeadIntroBefore" rows="2"></textarea></div>
          <div class="sf"><label>Intro (After Mode) <span class="tip" data-tip="Sent before the first question in 'after' mode.">?</span></label><textarea id="msgLeadIntroAfter" rows="2"></textarea></div>
          <div class="sf"><label>Survey Complete <span class="tip" data-tip="Sent when done. Placeholder: {firstName}">?</span></label><textarea id="msgLeadComplete" rows="2"></textarea></div>
          <div class="sf"><label>Complete + Send Selfie <span class="tip" data-tip="Sent when done but no photo yet. Placeholder: {firstName}">?</span></label><textarea id="msgLeadCompleteWithCta" rows="2"></textarea></div>
        </div>
        <div style="margin-top:18px;padding-top:16px;border-top:1px solid #252d3a">
          <div class="sf-sub-label">Survey Questions</div>
          <div id="leadFieldsList"></div>
        </div>
      </div>
    </div>

    <div class="sg"><h4>Promotional <span class="tip" data-tip="Optional follow-up SMS sent after each portrait is delivered.">?</span></h4>
      <input type="hidden" id="sEnablePromo" value="false">
      <div class="sf">
        <label style="display:flex;align-items:center;gap:10px">
          Enable Promotional Message
          <label class="toggle-sw">
            <input type="checkbox" id="promoToggle" onchange="togglePromoMessage(this.checked)">
            <span class="slider"></span>
          </label>
        </label>
      </div>
      <div id="promoMessageSection" style="display:none">
        <div class="sf"><label>Promotional Message <span class="tip" data-tip="Sent as a standalone SMS after each portrait is delivered.">?</span></label><textarea id="sPromoMessage" rows="3" placeholder="e.g. Join us at SIGNAL 2025, June 25-26! Register free: https://signal.twilio.com"></textarea></div>
      </div>
    </div>

    <div class="sg"><h4>Social Sharing <span class="tip" data-tip="Include Twitter/X and LinkedIn share links in the delivery SMS so users can share their portrait with one tap.">?</span></h4>
      <input type="hidden" id="sEnableShare" value="false">
      <div class="sf">
        <label style="display:flex;align-items:center;gap:10px">
          Enable Share Links
          <label class="toggle-sw">
            <input type="checkbox" id="shareToggle" onchange="toggleShareLinks(this.checked)">
            <span class="slider"></span>
          </label>
        </label>
      </div>
      <div id="shareLinksSection" style="display:none">
        <div class="sf"><label style="display:flex;align-items:center;gap:10px">Twitter / X <label class="toggle-sw"><input type="checkbox" id="twitterShareToggle" checked onchange="toggleTwitterShare(this.checked)"><span class="slider"></span></label></label></div>
        <div class="sf" id="twitterHandleRow"><label>Handle <span class="tip" data-tip="Included in the tweet text, e.g. @twilio">?</span></label><input type="text" id="sTwitterHandle" placeholder="@twilio"></div>
        <div class="sf" style="margin-top:12px"><label style="display:flex;align-items:center;gap:10px">LinkedIn <label class="toggle-sw"><input type="checkbox" id="linkedInShareToggle" checked onchange="toggleLinkedInShare(this.checked)"><span class="slider"></span></label></label></div>
        <div class="sf" id="linkedInTextRow"><label>Share Text <span class="tip" data-tip="Template for LinkedIn shares. Use {eventName} as a placeholder.">?</span></label><input type="text" id="sLinkedInText" placeholder="Check out my AI portrait from {eventName}, powered by Twilio!"></div>
      </div>
    </div>

    <div class="sg"><h4>NPS Survey <span class="tip" data-tip="Send a satisfaction survey (1-5 rating) after a user's last portrait. Results appear on the Dashboard.">?</span></h4>
      <input type="hidden" id="sEnableNps" value="false">
      <div class="sf">
        <label style="display:flex;align-items:center;gap:10px">
          Enable NPS Survey
          <label class="toggle-sw">
            <input type="checkbox" id="npsToggle" onchange="toggleNps(this.checked)">
            <span class="slider"></span>
          </label>
        </label>
      </div>
      <div id="npsSection" style="display:none">
        <div class="sf"><label>Delay (seconds) <span class="tip" data-tip="How long after the last portrait delivery to send the NPS survey.">?</span></label><input type="number" id="sNpsDelay" min="5" value="30" style="width:100px"></div>
        <div style="margin-top:18px;padding-top:16px;border-top:1px solid #252d3a">
          <div class="sf-sub-label">NPS Messages</div>
          <div class="sf"><label>Rating Prompt <span class="tip" data-tip="Sent to request a rating after the user's last portrait.">?</span></label><textarea id="msgNpsPrompt" rows="2"></textarea></div>
          <div class="sf"><label>Thanks Reply <span class="tip" data-tip="Sent after the user replies with their rating.">?</span></label><textarea id="msgNpsThanks" rows="2"></textarea></div>
        </div>
      </div>
    </div>

    <div class="sg"><h4>SMS Messages <span class="tip" data-tip="Customize every text message sent to attendees. Use {placeholders} for dynamic values. Leave blank to use defaults.">?</span></h4>
      <div class="sf-sub-label">Welcome &amp; Onboarding</div>
      <div class="sf"><label>Welcome <span class="tip" data-tip="Sent when a user texts without a photo.">?</span></label><textarea id="msgWelcome" rows="2"></textarea></div>
      <div class="sf-row">
        <div class="sf"><label>First Visit Note <span class="tip" data-tip="Appended for first-time users. {maxPrints}, {unit}, {eventName}">?</span></label><textarea id="msgWelcomeCount" rows="2"></textarea></div>
        <div class="sf"><label>Remaining Note <span class="tip" data-tip="Shows remaining quota. {remaining}, {unit}">?</span></label><textarea id="msgRemainingCount" rows="2"></textarea></div>
      </div>
      <div class="sf-row">
        <div class="sf"><label>Quota Exceeded <span class="tip" data-tip="No prints left. {maxPrints}, {units}, {eventName}">?</span></label><textarea id="msgQuotaExceeded" rows="2"></textarea></div>
        <div class="sf"><label>Multiple Photos <span class="tip" data-tip="Sent when user sends more than one photo.">?</span></label><textarea id="msgMultiplePhotos" rows="2"></textarea></div>
      </div>

      <div class="sf-sub-label" style="margin-top:20px">Style Selection</div>
      <div class="sf"><label>Menu Intro <span class="tip" data-tip="Header before the numbered style list.">?</span></label><textarea id="msgStyleMenuIntro" rows="2"></textarea></div>
      <div class="sf-row">
        <div class="sf"><label>Menu Footer <span class="tip" data-tip="Instruction after the style list.">?</span></label><textarea id="msgStyleMenuFooter" rows="2"></textarea></div>
        <div class="sf"><label>Invalid Choice <span class="tip" data-tip="Sent when style choice doesn't match.">?</span></label><textarea id="msgStyleMenuRetry" rows="2"></textarea></div>
      </div>

      <div id="bgMessagesSection" style="display:none">
      <div class="sf-sub-label" style="margin-top:20px">Background Selection</div>
      <div class="sf"><label>Menu Intro <span class="tip" data-tip="Header before the numbered background list.">?</span></label><textarea id="msgBackgroundMenuIntro" rows="2"></textarea></div>
      <div class="sf-row">
        <div class="sf"><label>Menu Footer <span class="tip" data-tip="Instruction after the background list.">?</span></label><textarea id="msgBackgroundMenuFooter" rows="2"></textarea></div>
        <div class="sf"><label>Invalid Choice <span class="tip" data-tip="Sent when background choice doesn't match.">?</span></label><textarea id="msgBackgroundMenuRetry" rows="2"></textarea></div>
      </div>
      <div id="bgMessagesPreview" style="margin-top:8px"></div>
      </div>

      <div class="sf-sub-label" style="margin-top:20px">Processing &amp; Delivery</div>
      <div class="sf"><label>Enqueued <span class="tip" data-tip="Confirmation. {confirmLabel} = e.g. 'Your cartoon portrait'">?</span></label><textarea id="msgEnqueued" rows="2"></textarea></div>
      <div class="sf-row">
        <div class="sf"><label>Pickup (Print) <span class="tip" data-tip="When printing is enabled.">?</span></label><textarea id="msgPickupPrint" rows="2"></textarea></div>
        <div class="sf"><label>Pickup (Digital) <span class="tip" data-tip="When printing is disabled.">?</span></label><textarea id="msgPickupDigital" rows="2"></textarea></div>
      </div>
      <div class="sf-row">
        <div class="sf"><label>Print Delivery <span class="tip" data-tip="Portrait sent to printer. {styleName}">?</span></label><textarea id="msgDeliveryPrint" rows="2"></textarea></div>
        <div class="sf"><label>Digital Delivery <span class="tip" data-tip="Portrait sent via MMS. {styleName}">?</span></label><textarea id="msgDeliveryDigital" rows="2"></textarea></div>
      </div>
      <div class="sf-row">
        <div class="sf"><label>Last Portrait <span class="tip" data-tip="Appended when user's last print is used.">?</span></label><textarea id="msgLastPortrait" rows="2"></textarea></div>
        <div class="sf"><label>Twilio Blurb <span class="tip" data-tip="Fun fact appended after pickup. Blank to disable.">?</span></label><textarea id="msgTwilioBlurb" rows="2"></textarea></div>
      </div>

      <div class="sf-sub-label" style="margin-top:20px">Error Responses</div>
      <div class="sf-row">
        <div class="sf"><label>Moderation Fail <span class="tip" data-tip="Photo flagged by content moderation.">?</span></label><textarea id="msgModerationFail" rows="2"></textarea></div>
        <div class="sf"><label>No Face Detected <span class="tip" data-tip="No face found in the photo.">?</span></label><textarea id="msgNoFace" rows="2"></textarea></div>
      </div>

      <div class="sf-sub-label" style="margin-top:20px">Manual Review</div>
      <div class="sf-row">
        <div class="sf"><label>Review Reject + Notify <span class="tip" data-tip="Sent to user when admin clicks Reject + Notify in the review queue.">?</span></label><textarea id="msgReviewReject" rows="2"></textarea></div>
        <div class="sf"><label>Review Max Failures <span class="tip" data-tip="Sent after max rejections. Tells user to try a different photo.">?</span></label><textarea id="msgReviewFailed" rows="2"></textarea></div>
      </div>
    </div>

    </div></div><!-- /Engagement -->

    <div class="sg-group">
    <div class="sg-group-header" onclick="this.parentElement.classList.toggle('open')">Operations</div>
    <div class="sg-group-body">

    <div class="sg"><h4>Queue Control <span class="tip" data-tip="Pause the generation and print queues during breaks. Jobs will accumulate but won't be processed until resumed.">?</span></h4>
      <div class="sf"><label>Max Concurrent Generations <span class="tip" data-tip="How many AI image generations can run at the same time. Higher = faster throughput but more API usage.">?</span></label><input type="number" id="sMaxGen" min="1" max="20"></div>
      <div class="sf">
        <label style="display:flex;align-items:center;gap:10px">
          Pause Queue
          <label class="toggle-sw">
            <input type="checkbox" id="pauseToggle" onchange="document.getElementById('sPaused').value = this.checked">
            <span class="slider"></span>
          </label>
        </label>
        <input type="hidden" id="sPaused" value="false">
      </div>
      <div class="sf"><label>Break Screen Message <span class="tip" data-tip="Optional message shown on the /home/break screen.">?</span></label><input type="text" id="sBreakMessage" placeholder="e.g. Back in 10 minutes!"></div>
      <div class="sf">
        <label style="display:flex;align-items:center;gap:10px">
          Manual Review <span class="tip" data-tip="When enabled, AI-generated images are held for admin review in the dashboard before being delivered. Approve or reject each image to control quality.">?</span>
          <label class="toggle-sw">
            <input type="checkbox" id="reviewToggle" onchange="document.getElementById('sManualReview').value = this.checked">
            <span class="slider"></span>
          </label>
        </label>
        <input type="hidden" id="sManualReview" value="false">
      </div>
    </div>

    </div></div><!-- /Operations -->

    <div class="sg-group">
    <div class="sg-group-header" onclick="this.parentElement.classList.toggle('open')">API Keys</div>
    <div class="sg-group-body">

    <div class="sg"><h4>Twilio <span class="tip" data-tip="Twilio API credentials used for sending and receiving SMS/MMS. These override values from your .env file.">?</span></h4>
      <div class="sf"><label>Phone Number <span class="tip" data-tip="Your Twilio phone number in E.164 format. This is the number attendees text their selfies to.">?</span></label><input type="text" id="sTwilioPhone" placeholder="+14155551234"></div>
      <div class="sf-row">
        <div class="sf"><label>Account SID <span class="tip" data-tip="Found on your Twilio Console dashboard. Starts with AC.">?</span></label><input type="text" id="sTwilioSid" placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"></div>
        <div class="sf"><label>Auth Token <span class="tip" data-tip="Found on your Twilio Console dashboard. Keep this secret.">?</span></label><input type="password" id="sTwilioToken" placeholder="Your auth token"></div>
      </div>
    </div>

    <div class="sg"><h4>OpenAI <span class="tip" data-tip="OpenAI API key and model configuration. These override values from your .env file.">?</span></h4>
      <div class="sf"><label>API Key <span class="tip" data-tip="Your OpenAI API key. Found at platform.openai.com/api-keys.">?</span></label><input type="password" id="sOpenaiKey" placeholder="sk-..."></div>
      <div class="sf-row">
        <div class="sf"><label>Orchestrator Model <span class="tip" data-tip="Main model for understanding photos and coordinating image generation.">?</span></label><input type="text" id="sModelOrch" placeholder="gpt-5.4"></div>
        <div class="sf"><label>Vision Light Model <span class="tip" data-tip="Lightweight model for person detection and scene analysis.">?</span></label><input type="text" id="sModelVision" placeholder="gpt-5.4-nano"></div>
      </div>
      <div class="sf-row">
        <div class="sf"><label>Image Generation Model <span class="tip" data-tip="Model used to generate the transformed portrait.">?</span></label><input type="text" id="sModelImage" placeholder="gpt-image-1.5"></div>
        <div class="sf"><label>Smart Reply Model <span class="tip" data-tip="Model for generating conversational SMS replies to attendees.">?</span></label><input type="text" id="sModelReply" placeholder="gpt-5.4-nano"></div>
      </div>
    </div>

    </div></div><!-- /API Keys -->

  </div>
  <div class="settings-actions" id="settingsActions">
    <button class="btn btn-primary" onclick="saveSettings()">Save Settings</button>
    <button class="btn btn-danger" onclick="resetSettings()">Reset to Defaults</button>
  </div>
</div>

<div class="footer">Powered by <a href="https://www.twilio.com" target="_blank">Twilio</a> + <a href="https://openai.com" target="_blank">OpenAI</a></div>
<div id="saveBanner" class="save-banner"></div>

</div><!-- /.wrap -->

<script>
// ── Settings ──
var _settings = {};
var _files = {};
var _adminPhones = [];
var _brandRefFiles = [];
var _allBrandRefFiles = [];
var _customStyles = {};
var _stylePromptOverrides = {};
var _knownEvents = [];
var _eventProfiles = [];
var _messages = {};
var _leadCaptureFields = {};
var _backgroundChoices = [];
var _promptDefaults = ${JSON.stringify({
  preserve: require("./styles").DEFAULT_PRESERVE,
  composition: require("./styles").DEFAULT_COMPOSITION,
  preserveBrand: "Preserve accurately: skin tone, eye color, hair color and style, facial hair, glasses, facial structure.",
  brandInstruction: "All subjects should be wearing/using the branded items from the reference image(s). Reproduce brand logos, text, crests, and design details EXACTLY as shown in the references.",
  faceDetection: "Does this image clearly show a person's face? A face must be visible -- photos of only hands, feet, backs, or other body parts without a face do NOT count. Reply with only YES or NO.",
  sceneAnalysis: "Analyze this photo. Reply in EXACTLY this format:\nSubjects: [number of people]\nPets: [none OR animal type]\nPositions: [centered, left-right pair, or group]",
  smartReply: "You are an AI-powered photobooth assistant at an event called \"{eventName}\". Powered by Twilio and OpenAI.\nYour job is to respond to the user's message naturally and helpfully, then direct them to send a selfie so you can transform it into art.\nAvailable art styles: {styleChoices}.\n{remainingLine}\nKeep your response concise (2-4 sentences max). Always end by encouraging them to send a selfie. Be friendly and conversational. Do not use emojis.",
  userDirective: "Transform this photo into a stylized portrait.",
  background: "Background: Recreate the background from the original photo in the same art style. Keep it natural and consistent with the scene."
})};
var _msgDefaults = ${JSON.stringify(require("./settings").DEFAULTS.messages)};

// ── Event name combo-box ──
function buildEventDropdown(filter) {
  var dd = document.getElementById("eventDropdown");
  var current = _settings.eventName || "";
  var query = (filter || "").toLowerCase();
  var matches = _knownEvents.filter(function(e) {
    return !query || e.toLowerCase().indexOf(query) !== -1;
  });
  var exactMatch = query && _knownEvents.some(function(e) { return e.toLowerCase() === query; });
  var html = "";
  if (matches.length > 0) {
    html = matches.map(function(e) {
      var label = escHtml(e);
      if (e === current) label += '<span class="combo-current">current</span>';
      if (_eventProfiles.indexOf(e) !== -1) label += '<span class="combo-saved" title="Saved profile">saved</span>';
      return '<div class="combo-item" onmousedown="selectEvent(\\''+escAttr(e)+'\\')">'+label+'</div>';
    }).join("");
  }
  if (query && !exactMatch) {
    html += '<div class="combo-item combo-create" onmousedown="selectEvent(\\''+escAttr(filter)+'\\')">+ Create \\"'+escHtml(filter)+'\\"</div>';
  }
  if (!html) {
    html = '<div class="combo-empty">Type an event name to get started</div>';
  }
  dd.innerHTML = html;
}

function openEventDropdown() {
  var dd = document.getElementById("eventDropdown");
  buildEventDropdown(document.getElementById("sEventName").value);
  dd.classList.add("open");
}

function filterEventDropdown() {
  var dd = document.getElementById("eventDropdown");
  buildEventDropdown(document.getElementById("sEventName").value);
  dd.classList.add("open");
}

function toggleEventDropdown() {
  var dd = document.getElementById("eventDropdown");
  if (dd.classList.contains("open")) {
    dd.classList.remove("open");
  } else {
    openEventDropdown();
    document.getElementById("sEventName").focus();
  }
}

function selectEvent(name) {
  document.getElementById("sEventName").value = name;
  document.getElementById("eventDropdown").classList.remove("open");
  saveSettings();
}

// Close dropdown when clicking outside
document.addEventListener("click", function(e) {
  var combo = document.getElementById("eventCombo");
  if (combo && !combo.contains(e.target)) {
    document.getElementById("eventDropdown").classList.remove("open");
  }
});

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
    _messages = Object.assign({}, _settings.messages || {});
    _leadCaptureFields = Object.assign({}, _settings.leadCaptureFields || {});
    _eventProfiles = (_files.eventProfiles || []).slice();
    populateSettings();
  } catch(e) { console.error("Failed to load settings", e); }
}

function toggleFrameBorder(enabled) {
  document.getElementById("frameBorderColorRow").style.display = enabled ? "flex" : "none";
}

function setDeliveryMode(printing) {
  document.getElementById("sEnablePrinting").value = printing ? "true" : "false";
  var btnPrint = document.querySelector(".ds-print");
  var btnDigital = document.querySelector(".ds-digital");
  var status = document.getElementById("deliveryStatus");
  var printSection = document.getElementById("printSettingsSection");
  var printerSection = document.getElementById("printerSection");
  if (printing) {
    btnPrint.classList.add("active"); btnDigital.classList.remove("active");
    status.className = "delivery-status mode-both";
    status.textContent = "Portraits are printed and sent via MMS";
    if (printSection) printSection.style.display = "";
    if (printerSection) printerSection.style.display = "";
  } else {
    btnPrint.classList.remove("active"); btnDigital.classList.add("active");
    status.className = "delivery-status mode-digital";
    status.textContent = "Portraits are sent via MMS only (no printer needed)";
    if (printSection) printSection.style.display = "none";
    if (printerSection) printerSection.style.display = "none";
  }
}

function toggleLeadCapture(enabled) {
  var section = document.getElementById("lcTimingSection");
  if (enabled) {
    section.style.display = "";
    var current = document.getElementById("sLeadMode").value;
    if (current === "disabled") setLeadTiming("before");
  } else {
    section.style.display = "none";
    document.getElementById("sLeadMode").value = "disabled";
  }
}

function togglePromoMessage(enabled) {
  document.getElementById("sEnablePromo").value = enabled ? "true" : "false";
  document.getElementById("promoMessageSection").style.display = enabled ? "" : "none";
}

function toggleShareLinks(enabled) {
  document.getElementById("sEnableShare").value = enabled ? "true" : "false";
  document.getElementById("shareLinksSection").style.display = enabled ? "" : "none";
}
function toggleTwitterShare(enabled) {
  document.getElementById("twitterHandleRow").style.display = enabled ? "" : "none";
}
function toggleLinkedInShare(enabled) {
  document.getElementById("linkedInTextRow").style.display = enabled ? "" : "none";
}

function toggleNps(enabled) {
  document.getElementById("sEnableNps").value = enabled ? "true" : "false";
  document.getElementById("npsSection").style.display = enabled ? "" : "none";
}

function setLeadTiming(mode) {
  document.getElementById("sLeadMode").value = mode;
  document.querySelectorAll("#lcTimingSection .lc-btn").forEach(function(btn) {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });
  var status = document.getElementById("leadStatus");
  if (mode === "before") {
    status.textContent = "Attendees complete a quick survey before their portrait is created";
  } else {
    status.textContent = "Attendees complete a quick survey before receiving their portrait";
  }
}

function populateSettings() {
  document.getElementById("sEventName").value = _settings.eventName || "";
  _knownEvents = (_files.events || []).slice();
  document.getElementById("sMaxPrints").value = _settings.maxPrints || 2;
  document.getElementById("sMaxGen").value = _settings.maxConcurrentGeneration || 3;

  // Twilio
  document.getElementById("sTwilioPhone").value = _settings.twilioPhoneNumber || "";
  document.getElementById("sTwilioSid").value = _settings.twilioAccountSid || "";
  document.getElementById("sTwilioToken").value = _settings.twilioAuthToken || "";

  // OpenAI
  document.getElementById("sOpenaiKey").value = _settings.openaiApiKey || "";
  document.getElementById("sModelOrch").value = _settings.modelOrchestrator || "";
  document.getElementById("sModelVision").value = _settings.modelVisionLight || "";
  document.getElementById("sModelImage").value = _settings.modelImageGen || "";
  document.getElementById("sModelReply").value = _settings.modelSmartReply || "";

  document.getElementById("sTermsUrl").value = _settings.termsUrl || "";
  document.getElementById("sPromoMessage").value = _settings.promoMessage || "";
  var promoEnabled = _settings.enablePromoMessage === true;
  document.getElementById("promoToggle").checked = promoEnabled;
  document.getElementById("sEnablePromo").value = promoEnabled ? "true" : "false";
  document.getElementById("promoMessageSection").style.display = promoEnabled ? "" : "none";
  var shareEnabled = _settings.enableShareLinks === true;
  document.getElementById("shareToggle").checked = shareEnabled;
  document.getElementById("sEnableShare").value = shareEnabled ? "true" : "false";
  document.getElementById("shareLinksSection").style.display = shareEnabled ? "" : "none";
  var twitterOn = _settings.enableTwitterShare !== false;
  document.getElementById("twitterShareToggle").checked = twitterOn;
  document.getElementById("twitterHandleRow").style.display = twitterOn ? "" : "none";
  document.getElementById("sTwitterHandle").value = _settings.twitterHandle || "@twilio";
  var linkedInOn = _settings.enableLinkedInShare !== false;
  document.getElementById("linkedInShareToggle").checked = linkedInOn;
  document.getElementById("linkedInTextRow").style.display = linkedInOn ? "" : "none";
  document.getElementById("sLinkedInText").value = _settings.linkedInShareText || "";
  var npsEnabled = _settings.enableNps === true;
  document.getElementById("npsToggle").checked = npsEnabled;
  document.getElementById("sEnableNps").value = npsEnabled ? "true" : "false";
  document.getElementById("npsSection").style.display = npsEnabled ? "" : "none";
  document.getElementById("sNpsDelay").value = _settings.npsDelay || 30;
  document.getElementById("pauseToggle").checked = _settings.queuePaused === true;
  document.getElementById("sPaused").value = _settings.queuePaused ? "true" : "false";
  var reviewOn = _settings.enableManualReview === true;
  document.getElementById("reviewToggle").checked = reviewOn;
  document.getElementById("sManualReview").value = reviewOn ? "true" : "false";
  document.getElementById("sBreakMessage").value = _settings.breakMessage || "";
  setDeliveryMode(_settings.enablePrinting !== false);
  var lcMode = _settings.leadCaptureMode || "disabled";
  document.getElementById("lcToggle").checked = lcMode !== "disabled";
  if (lcMode !== "disabled") {
    document.getElementById("lcTimingSection").style.display = "";
    setLeadTiming(lcMode);
  } else {
    document.getElementById("lcTimingSection").style.display = "none";
    document.getElementById("sLeadMode").value = "disabled";
  }
  document.getElementById("sBrandPrompt").value = _settings.brandPrompt || "";

  // AI Prompts
  document.getElementById("sPromptPreserve").value = _settings.promptPreserve || _promptDefaults.preserve;
  document.getElementById("sPromptComposition").value = _settings.promptComposition || _promptDefaults.composition;
  document.getElementById("sPromptPreserveBrand").value = _settings.promptPreserveBrand || _promptDefaults.preserveBrand;
  document.getElementById("sPromptBrandInstruction").value = _settings.promptBrandInstruction || _promptDefaults.brandInstruction;
  document.getElementById("sPromptFaceDetection").value = _settings.promptFaceDetection || _promptDefaults.faceDetection;
  document.getElementById("sPromptSceneAnalysis").value = _settings.promptSceneAnalysis || _promptDefaults.sceneAnalysis;
  document.getElementById("sPromptSmartReply").value = _settings.promptSmartReply || _promptDefaults.smartReply;
  document.getElementById("sPromptUserDirective").value = _settings.promptUserDirective || _promptDefaults.userDirective;

  // Background
  document.getElementById("sPromptBackground").value = _settings.promptBackground !== undefined ? _settings.promptBackground : _promptDefaults.background;
  _backgroundChoices = _settings.backgroundChoices || [];
  var bgEnabled = !!_settings.enableBackgroundMenu;
  document.getElementById("bgMenuToggle").checked = bgEnabled;
  document.getElementById("sEnableBackgroundMenu").value = bgEnabled;
  document.getElementById("bgChoicesSection").style.display = bgEnabled ? "block" : "none";
  var bgMsgEl = document.getElementById("bgMessagesSection");
  if (bgMsgEl) bgMsgEl.style.display = bgEnabled ? "block" : "none";
  renderBackgroundChoices();

  // Frame border
  var fbEnabled = _settings.enableFrameBorder !== false;
  document.getElementById("frameBorderToggle").checked = fbEnabled;
  var fbColor = _settings.frameBorderColor || "#000000";
  document.getElementById("sFrameBorderColor").value = fbColor;
  document.getElementById("frameBorderColorLabel").textContent = fbColor;
  document.getElementById("frameBorderColorRow").style.display = fbEnabled ? "flex" : "none";

  // Print settings
  document.getElementById("sPrintSize").value = _settings.printSize || "5x7";
  document.getElementById("sPrintQuality").value = _settings.printQuality || "high";
  document.getElementById("sCustomPrintFlags").value = _settings.customPrintFlags || "";
  document.getElementById("sPrintRelayKey").value = _settings.printRelayKey || "";

  // Dropdowns
  renderPrinterChecklist(_files.printers || [], _settings.activePrinters || []);
  fillSelect("sTemplate", _files.templates || [], _settings.templateFile, "None (no frame)");
  fillSelect("sVideo", _files.videos || [], _settings.videoFile, "Select video...");
  updateTemplatePreview();
  updateVideoPreview();

  // Phone tags
  renderPhoneTags();

  // Brand reference files
  renderBrandRefs(_files.brandReferences || [], _settings.brandReferenceFiles || []);

  // Messages
  _messages = Object.assign({}, _settings.messages || {});
  var msgIds = ["welcome","welcomeCount","remainingCount","quotaExceeded","multiplePhotos",
    "enqueued","pickupPrint","pickupDigital","twilioBlurb",
    "deliveryDigital","deliveryPrint","lastPortrait",
    "styleMenuIntro","styleMenuFooter","styleMenuRetry",
    "backgroundMenuIntro","backgroundMenuFooter","backgroundMenuRetry",
    "moderationFail","noFace",
    "leadIntroBefore","leadIntroAfter","leadComplete","leadCompleteWithCta",
    "npsPrompt","npsThanks",
    "reviewReject","reviewFailed"];
  for (var mi = 0; mi < msgIds.length; mi++) {
    var el = document.getElementById("msg" + msgIds[mi].charAt(0).toUpperCase() + msgIds[mi].slice(1));
    if (el) el.value = _messages[msgIds[mi]] || _msgDefaults[msgIds[mi]] || "";
  }

  // Lead capture fields
  _leadCaptureFields = {};
  var lcfDefaults = _settings.leadCaptureFields || {};
  var lcfKeys = ["firstName","lastName","country","email","company","jobTitle"];
  for (var li = 0; li < lcfKeys.length; li++) {
    _leadCaptureFields[lcfKeys[li]] = Object.assign(
      { enabled: true, prompt: "", errorMsg: "" },
      lcfDefaults[lcfKeys[li]] || {}
    );
  }
  renderLeadFields();

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

// ── Brand Reference Files ──
function renderBrandRefs(allFiles, selected) {
  _allBrandRefFiles = allFiles || [];
  _brandRefFiles = (selected || []).filter(function(f) { return _allBrandRefFiles.indexOf(f) !== -1; });
  var container = document.getElementById("brandRefList");
  if (_allBrandRefFiles.length === 0) { container.innerHTML = ""; return; }
  container.innerHTML = _allBrandRefFiles.map(function(f) {
    var checked = _brandRefFiles.indexOf(f) !== -1 ? " checked" : "";
    var esc = f.replace(/'/g, "\\\\'");
    return '<label class="brand-ref-tag' + (checked ? ' selected' : '') + '"><input type="checkbox"' + checked + ' onchange="toggleBrandRef(\\''+esc+'\\', this.checked)"><img src="/brand-references/' + encodeURIComponent(f) + '"> ' + escHtml(f) + ' <span class="brand-ref-delete" title="Delete from library" onclick="event.preventDefault();deleteBrandRef(\\''+esc+'\\')">x</span></label>';
  }).join("");
}

function toggleBrandRef(filename, on) {
  var idx = _brandRefFiles.indexOf(filename);
  if (on && idx === -1) _brandRefFiles.push(filename);
  if (!on && idx !== -1) _brandRefFiles.splice(idx, 1);
  renderBrandRefs(_allBrandRefFiles, _brandRefFiles);
}

async function uploadBrandRefs() {
  var input = document.getElementById("uploadBrandRef");
  var status = document.getElementById("uploadBrandRefStatus");
  if (!input.files || input.files.length === 0) { status.textContent = "No files selected"; status.className = "upload-status err"; return; }
  status.textContent = "Uploading..."; status.className = "upload-status";
  var uploaded = [];
  for (var i = 0; i < input.files.length; i++) {
    var file = input.files[i];
    try {
      var url = "/dashboard/api/settings/upload?filename=" + encodeURIComponent(file.name) + "&type=brand-reference";
      var r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file });
      var result = await r.json();
      if (result.error) { status.textContent = result.error; status.className = "upload-status err"; return; }
      uploaded.push(result.filename);
      _allBrandRefFiles = result.files;
      if (_brandRefFiles.indexOf(result.filename) === -1) _brandRefFiles.push(result.filename);
    } catch(e) { status.textContent = "Upload failed"; status.className = "upload-status err"; return; }
  }
  renderBrandRefs(_allBrandRefFiles, _brandRefFiles);
  status.textContent = "Uploaded " + uploaded.length + " file(s)";
  status.className = "upload-status";
  input.value = "";
}

async function deleteBrandRef(filename) {
  if (!confirm("Delete \\"" + filename + "\\" from the library? This removes it for ALL events.")) return;
  try {
    var r = await fetch("/dashboard/api/settings/brand-reference?filename=" + encodeURIComponent(filename), { method: "DELETE" });
    var result = await r.json();
    _brandRefFiles = _brandRefFiles.filter(function(f) { return f !== filename; });
    renderBrandRefs(result.files, _brandRefFiles);
  } catch(e) { console.error("Failed to delete brand reference:", e); }
}

var _builtInStyles = ${JSON.stringify(Object.entries(require("./styles").STYLES).map(([k, v]) => ({ key: k, name: v.name, prompt: v.buildPrompt(require("./styles").DEFAULT_PRESERVE, require("./styles").DEFAULT_COMPOSITION), core: v.core, brandCore: v.brandCore })))};

function renderStyles() {
  var disabled = _settings.disabledStyles || [];
  var html = "";

  _builtInStyles.forEach(function(s, i) {
    var isDisabled = disabled.includes(s.key);
    var checked = !isDisabled ? "checked" : "";
    var hasOverride = !!_stylePromptOverrides[s.key];
    var promptText = _stylePromptOverrides[s.key] || s.prompt;
    html += '<div class="style-card' + (isDisabled ? ' disabled' : '') + '">'
      + '<div class="style-card-thumb" id="sp' + i + '"><svg width="20" height="20" viewBox="0 0 24 24" style="animation:spin 1s linear infinite;color:#2D3340"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" stroke-dasharray="30 70" stroke-linecap="round"/></svg></div>'
      + '<div class="style-card-body">'
      + '<div class="style-card-header"><span class="sname">' + escHtml(s.name) + '</span><span class="slabel">built-in</span></div>'
      + '<div class="style-card-actions">'
      + '<button class="prompt-link" onclick="togglePrompt(\\'bp' + i + '\\')">prompt</button>'
      + '<button class="reset-link' + (hasOverride ? ' visible' : '') + '" id="rst' + i + '" onclick="resetBuiltInPrompt(' + i + ')">reset</button>'
      + '<label class="toggle-sw"><input type="checkbox" data-style="' + s.key + '" ' + checked + ' onchange="this.closest(\\'.style-card\\').classList.toggle(\\'disabled\\',!this.checked);rebuildDefaultStyleDropdown()"><span class="slider"></span></label>'
      + '</div>'
      + '<textarea class="style-prompt" id="bp' + i + '" rows="6" oninput="onBuiltInPromptEdit(' + i + ',this.value)">' + escHtml(promptText) + '</textarea>'
      + '<div class="style-card-actions" style="margin-top:4px">'
      + '<button class="prompt-link" onclick="togglePrompt(\\'bc' + i + '\\')">core</button>'
      + '<button class="prompt-link" onclick="togglePrompt(\\'bbc' + i + '\\')">brand core</button>'
      + '</div>'
      + '<textarea class="style-prompt" id="bc' + i + '" rows="3" placeholder="Core style prompt (used with brand refs)" oninput="onBuiltInCoreEdit(' + i + ',this.value,\\'core\\')">' + escHtml(_stylePromptOverrides[s.key + '_core'] || s.core || '') + '</textarea>'
      + '<textarea class="style-prompt" id="bbc' + i + '" rows="2" placeholder="Brand core prompt (minimal style hint)" oninput="onBuiltInCoreEdit(' + i + ',this.value,\\'brandCore\\')">' + escHtml(_stylePromptOverrides[s.key + '_brandCore'] || s.brandCore || '') + '</textarea>'
      + '</div></div>';
  });

  Object.keys(_customStyles).forEach(function(k) {
    var isDisabled = disabled.includes(k);
    var checked = !isDisabled ? "checked" : "";
    html += '<div class="style-card' + (isDisabled ? ' disabled' : '') + '">'
      + '<div class="style-card-thumb" id="spc_' + k + '"><svg width="20" height="20" viewBox="0 0 24 24" style="animation:spin 1s linear infinite;color:#2D3340"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" stroke-dasharray="30 70" stroke-linecap="round"/></svg></div>'
      + '<div class="style-card-body">'
      + '<div class="style-card-header"><input class="sname-edit" value="' + escAttr(_customStyles[k].name) + '" oninput="onCustomNameEdit(\\''+k+'\\',this.value)"><span class="slabel">custom</span></div>'
      + '<div class="style-card-actions">'
      + '<button class="prompt-link" onclick="togglePrompt(\\'cp_' + k + '\\')">prompt</button>'
      + '<button class="remove-link" onclick="removeCustomStyle(\\''+k+'\\')">remove</button>'
      + '<label class="toggle-sw"><input type="checkbox" data-style="' + k + '" ' + checked + ' onchange="this.closest(\\'.style-card\\').classList.toggle(\\'disabled\\',!this.checked);rebuildDefaultStyleDropdown()"><span class="slider"></span></label>'
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
  // Custom styles (only if enabled)
  Object.keys(_customStyles).forEach(function(k) {
    var cb = document.querySelector('#stylesList input[data-style="' + k + '"]');
    if (cb && !cb.checked) return;
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

function onBuiltInCoreEdit(idx, value, suffix) {
  var s = _builtInStyles[idx];
  var overrideKey = s.key + '_' + suffix;
  var defaultVal = s[suffix] || '';
  if (value.trim() === defaultVal.trim()) {
    delete _stylePromptOverrides[overrideKey];
  } else {
    _stylePromptOverrides[overrideKey] = value;
  }
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

// ── Lead Capture Field Editor ──
var _leadFieldLabels = {
  firstName: "First Name", lastName: "Last Name", country: "Country",
  email: "Business Email", company: "Company", jobTitle: "Job Title"
};

function renderLeadFields() {
  var container = document.getElementById("leadFieldsList");
  if (!container) return;
  var keys = ["firstName","lastName","country","email","company","jobTitle"];
  var h = "";
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var f = _leadCaptureFields[k] || { enabled: true, prompt: "", errorMsg: "" };
    var checked = f.enabled !== false ? "checked" : "";
    h += '<div style="padding:16px;background:#0f1219;border:1px solid #252d3a;border-radius:10px;margin-bottom:10px">';
    h += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">';
    h += '<span style="font-size:14px;font-weight:600;color:#b8c0cc">' + _leadFieldLabels[k] + '</span>';
    h += '<label class="toggle-sw"><input type="checkbox" data-lcf="' + k + '" ' + checked + ' onchange="onLeadFieldToggle(this)"><span class="slider"></span></label>';
    h += '</div>';
    h += '<div class="sf" style="margin-bottom:8px"><label>Question Prompt</label><textarea class="lcf-prompt" data-lcf="' + k + '" rows="2" oninput="onLeadFieldEdit()">' + escHtml(f.prompt) + '</textarea></div>';
    h += '<div class="sf"><label>Error Message</label><textarea class="lcf-error" data-lcf="' + k + '" rows="2" oninput="onLeadFieldEdit()">' + escHtml(f.errorMsg) + '</textarea></div>';
    h += '</div>';
  }
  container.innerHTML = h;
}

function onLeadFieldToggle(cb) {
  var k = cb.dataset.lcf;
  if (_leadCaptureFields[k]) _leadCaptureFields[k].enabled = cb.checked;
}

function onLeadFieldEdit() {
  document.querySelectorAll(".lcf-prompt").forEach(function(ta) {
    var k = ta.dataset.lcf;
    if (_leadCaptureFields[k]) _leadCaptureFields[k].prompt = ta.value;
  });
  document.querySelectorAll(".lcf-error").forEach(function(ta) {
    var k = ta.dataset.lcf;
    if (_leadCaptureFields[k]) _leadCaptureFields[k].errorMsg = ta.value;
  });
}

function collectMessages() {
  var msgIds = ["welcome","welcomeCount","remainingCount","quotaExceeded","multiplePhotos",
    "enqueued","pickupPrint","pickupDigital","twilioBlurb",
    "deliveryDigital","deliveryPrint","lastPortrait",
    "styleMenuIntro","styleMenuFooter","styleMenuRetry",
    "backgroundMenuIntro","backgroundMenuFooter","backgroundMenuRetry",
    "moderationFail","noFace",
    "leadIntroBefore","leadIntroAfter","leadComplete","leadCompleteWithCta",
    "npsPrompt","npsThanks",
    "reviewReject","reviewFailed"];
  var msgs = {};
  for (var i = 0; i < msgIds.length; i++) {
    var el = document.getElementById("msg" + msgIds[i].charAt(0).toUpperCase() + msgIds[i].slice(1));
    if (el) msgs[msgIds[i]] = el.value;
  }
  return msgs;
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

// ── Background Menu ──
function toggleBackgroundMenu(enabled) {
  document.getElementById("sEnableBackgroundMenu").value = enabled;
  document.getElementById("bgChoicesSection").style.display = enabled ? "block" : "none";
  var bgMsgEl = document.getElementById("bgMessagesSection");
  if (bgMsgEl) bgMsgEl.style.display = enabled ? "block" : "none";
  if (enabled) renderBgMessagesPreview();
}

function renderBackgroundChoices() {
  var el = document.getElementById("bgChoicesList");
  renderBgMessagesPreview();
  if (!_backgroundChoices.length) { el.innerHTML = '<div style="font-size:13px;color:#6b7585;padding:4px 0">No background options configured.</div>'; return; }
  el.innerHTML = _backgroundChoices.map(function(c, i) {
    return '<div style="display:flex;align-items:flex-start;gap:8px;padding:8px 0;border-bottom:1px solid #252d3a">' +
      '<div style="flex:1">' +
        '<div class="sf"><label>Name</label><input type="text" value="' + (c.name || '').replace(/"/g, '&quot;') + '" onchange="_backgroundChoices[' + i + '].name=this.value"></div>' +
        '<div class="sf"><label>Prompt</label><textarea rows="2" onchange="_backgroundChoices[' + i + '].prompt=this.value">' + (c.prompt || '').replace(/</g, '&lt;') + '</textarea></div>' +
      '</div>' +
      '<button class="btn btn-sm" style="margin-top:20px;color:#e74c3c" onclick="removeBackgroundChoice(' + i + ')">Remove</button>' +
    '</div>';
  }).join("");
}

function addBackgroundChoice() {
  var name = document.getElementById("bgNewName").value.trim();
  var prompt = document.getElementById("bgNewPrompt").value.trim();
  if (!name || !prompt) return;
  var key = name.toLowerCase().replace(/\\s+/g, "-");
  _backgroundChoices.push({ key: key, name: name, prompt: prompt });
  document.getElementById("bgNewName").value = "";
  document.getElementById("bgNewPrompt").value = "";
  document.getElementById("addBgForm").style.display = "none";
  renderBackgroundChoices();
}

function removeBackgroundChoice(index) {
  _backgroundChoices.splice(index, 1);
  renderBackgroundChoices();
}

function renderBgMessagesPreview() {
  var el = document.getElementById("bgMessagesPreview");
  if (!el) return;
  if (!_backgroundChoices.length) { el.innerHTML = ""; return; }
  var lines = _backgroundChoices.map(function(c, i) { return (i + 1) + ". " + c.name; });
  el.innerHTML = '<div style="font-size:12px;color:#6b7585;margin-bottom:4px">Preview — what users will see:</div>' +
    '<div style="background:#0f1219;border:1px solid #1c2230;border-radius:6px;padding:10px 12px;font-size:12px;color:#8892a2;white-space:pre-line;line-height:1.6">' +
    (document.getElementById("msgBackgroundMenuIntro").value || _msgDefaults.backgroundMenuIntro || "") +
    "\\n\\n" + lines.join("\\n") + "\\n\\n" +
    (document.getElementById("msgBackgroundMenuFooter").value || _msgDefaults.backgroundMenuFooter || "") +
    '</div>';
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

// ── Printer Checklist ──
function renderPrinterChecklist(printers, active) {
  var container = document.getElementById("printerChecklist");
  if (!printers || printers.length === 0) {
    container.innerHTML = '<span style="color:#6b7585">No printers detected</span>';
    document.getElementById("printerCount").textContent = "";
    return;
  }
  var html = "";
  for (var i = 0; i < printers.length; i++) {
    var name = printers[i];
    var checked = active.length > 0 ? active.includes(name) : (i === 0);
    html += '<label style="display:flex;align-items:center;gap:8px;padding:6px 0;cursor:pointer"><input type="checkbox" class="printer-cb" data-printer="' + name + '"' + (checked ? ' checked' : '') + '> <span style="font-family:monospace;font-size:14px">' + name + '</span></label>';
  }
  container.innerHTML = html;
  updatePrinterCount();
}

function getSelectedPrinters() {
  var cbs = document.querySelectorAll(".printer-cb:checked");
  var result = [];
  cbs.forEach(function(cb) { result.push(cb.dataset.printer); });
  return result;
}

function updatePrinterCount() {
  var total = document.querySelectorAll(".printer-cb").length;
  var active = document.querySelectorAll(".printer-cb:checked").length;
  var el = document.getElementById("printerCount");
  if (total > 0) {
    el.textContent = active + " of " + total + " active";
  } else {
    el.textContent = "";
  }
}

document.addEventListener("change", function(e) {
  if (e.target.classList.contains("printer-cb")) updatePrinterCount();
});

async function refreshPrinters() {
  var container = document.getElementById("printerChecklist");
  container.innerHTML = '<div style="display:flex;align-items:center;gap:8px;padding:8px 0"><svg width="16" height="16" viewBox="0 0 24 24" style="animation:spin 1s linear infinite;color:#525c6c"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" stroke-dasharray="30 70" stroke-linecap="round"/></svg><span style="color:#6b7585;font-size:13px">Refreshing...</span></div>';
  try {
    var r = await fetch("/dashboard/api/settings/files");
    var files = await r.json();
    _files.printers = files.printers;
    renderPrinterChecklist(files.printers || [], getSelectedPrinters());
  } catch(e) {
    container.innerHTML = '<span style="color:#F22F46">Error loading printers</span>';
  }
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

var _saveInFlight = false;
async function saveSettings() {
  if (_saveInFlight) return;
  _saveInFlight = true;
  try { await _doSaveSettings(); } finally { _saveInFlight = false; }
}
async function _doSaveSettings() {
  var previousEventName = _settings.eventName || "";
  var newEventName = document.getElementById("sEventName").value;

  // If event name changed, only send the event name change — the server
  // saves the old event and loads the new one. Sending all form fields
  // would overwrite the new event with old event's values.
  if (newEventName !== previousEventName && previousEventName) {
    try {
      var r = await fetch("/dashboard/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventName: newEventName })
      });
      _settings = await r.json();
      var isExisting = _eventProfiles.indexOf(newEventName) !== -1;
      var msg = isExisting
        ? "Switched to \\"" + newEventName + "\\" -- settings loaded for this event."
        : "Created new event \\"" + newEventName + "\\" -- starting with defaults.";
      await loadSettings();
      showBanner(msg, "success");
    } catch (err) {
      showBanner("Save failed: " + err.message, "error");
    }
    return;
  }

  var disabledStyles = [];
  document.querySelectorAll('#stylesList input[type="checkbox"]').forEach(function(cb) {
    if (!cb.checked) disabledStyles.push(cb.dataset.style);
  });

  var body = {
    eventName: newEventName,
    maxPrints: parseInt(document.getElementById("sMaxPrints").value) || 2,
    maxConcurrentGeneration: parseInt(document.getElementById("sMaxGen").value) || 3,
    twilioPhoneNumber: document.getElementById("sTwilioPhone").value,
    twilioAccountSid: document.getElementById("sTwilioSid").value,
    twilioAuthToken: document.getElementById("sTwilioToken").value,
    openaiApiKey: document.getElementById("sOpenaiKey").value,
    modelOrchestrator: document.getElementById("sModelOrch").value,
    modelVisionLight: document.getElementById("sModelVision").value,
    modelImageGen: document.getElementById("sModelImage").value,
    modelSmartReply: document.getElementById("sModelReply").value,
    activePrinters: getSelectedPrinters(),
    templateFile: document.getElementById("sTemplate").value,
    videoFile: document.getElementById("sVideo").value,
    adminPhones: _adminPhones,
    termsUrl: document.getElementById("sTermsUrl").value,
    enablePromoMessage: document.getElementById("sEnablePromo").value === "true",
    promoMessage: document.getElementById("sPromoMessage").value,
    enableShareLinks: document.getElementById("sEnableShare").value === "true",
    enableTwitterShare: document.getElementById("twitterShareToggle").checked,
    enableLinkedInShare: document.getElementById("linkedInShareToggle").checked,
    twitterHandle: document.getElementById("sTwitterHandle").value,
    linkedInShareText: document.getElementById("sLinkedInText").value,
    enableNps: document.getElementById("sEnableNps").value === "true",
    npsDelay: parseInt(document.getElementById("sNpsDelay").value) || 30,
    queuePaused: document.getElementById("sPaused").value === "true",
    enableManualReview: document.getElementById("sManualReview").value === "true",
    breakMessage: document.getElementById("sBreakMessage").value,
    enablePrinting: document.getElementById("sEnablePrinting").value === "true",
    printSize: document.getElementById("sPrintSize").value,
    printQuality: document.getElementById("sPrintQuality").value,
    customPrintFlags: document.getElementById("sCustomPrintFlags").value,
    printRelayKey: document.getElementById("sPrintRelayKey").value,
    leadCaptureMode: document.getElementById("sLeadMode").value,
    brandPrompt: document.getElementById("sBrandPrompt").value,
    brandReferenceFiles: _brandRefFiles,
    enableFrameBorder: document.getElementById("frameBorderToggle").checked,
    frameBorderColor: document.getElementById("sFrameBorderColor").value,
    defaultStyle: document.getElementById("sDefaultStyle").value,
    disabledStyles: disabledStyles,
    stylePromptOverrides: _stylePromptOverrides,
    customStyles: _customStyles,
    messages: collectMessages(),
    leadCaptureFields: _leadCaptureFields,
    promptPreserve: document.getElementById("sPromptPreserve").value,
    promptComposition: document.getElementById("sPromptComposition").value,
    promptPreserveBrand: document.getElementById("sPromptPreserveBrand").value,
    promptBrandInstruction: document.getElementById("sPromptBrandInstruction").value,
    promptFaceDetection: document.getElementById("sPromptFaceDetection").value,
    promptSceneAnalysis: document.getElementById("sPromptSceneAnalysis").value,
    promptSmartReply: document.getElementById("sPromptSmartReply").value,
    promptUserDirective: document.getElementById("sPromptUserDirective").value,
    promptBackground: document.getElementById("sPromptBackground").value,
    enableBackgroundMenu: document.getElementById("sEnableBackgroundMenu").value === "true",
    backgroundChoices: _backgroundChoices,
  };

  try {
    var r = await fetch("/dashboard/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    _settings = await r.json();
    showBanner("Settings saved -- changes are active immediately.", "success");
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
    _messages = {};
    _leadCaptureFields = {};
    populateSettings();

    showBanner("Settings reset to defaults -- changes are active immediately.", "reset-ok");
  } catch(e) { alert("Failed to reset: " + e.message); }
}

// Review notification polling
(function() {
  var el = document.getElementById("reviewNotify");
  var txt = document.getElementById("reviewNotifyText");
  if (!el || !txt) return;
  function poll() {
    fetch("/dashboard/api/review-count").then(function(r){return r.json()}).then(function(d) {
      if (d.count > 0) {
        txt.textContent = d.count + " image" + (d.count === 1 ? "" : "s") + " pending review";
        el.style.display = "flex";
      } else {
        el.style.display = "none";
      }
    }).catch(function(){});
  }
  poll();
  setInterval(poll, 5000);
})();
</script>
${userBarSnippet()}
</body>
</html>`;
} // end buildHomeHtml

function buildVideoHtml() {
const videoFile = settings.get("videoFile");
const termsUrl = settings.get("termsUrl") || "";
return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/assets/icon-twilio-bug-red.svg">
<title>Get Started — Twilio Photobooth</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: #000; }
  .scene { display: flex; flex-direction: column; height: 100vh; }
  .top-bar {
    flex-shrink: 0; display: flex; justify-content: flex-end; align-items: center;
    padding: 10px 16px; gap: 6px; position: relative; z-index: 5;
    background: rgba(0,0,0,0.4);
  }
  .top-btn {
    background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
    border-radius: 8px; padding: 6px 14px; color: rgba(255,255,255,0.55);
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 12px; font-weight: 500; cursor: pointer; user-select: none;
    display: flex; align-items: center; gap: 6px; transition: all .2s;
  }
  .top-btn:hover { color: rgba(255,255,255,0.85); background: rgba(255,255,255,0.1); }
  .top-btn svg { width: 14px; height: 14px; }
  video {
    flex: 1; min-height: 0;
    width: 100%;
    object-fit: contain;
    display: block;
  }
  .terms-notice {
    flex-shrink: 0; padding: 6px 16px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 10px; color: rgba(255,255,255,0.2); text-align: center;
  }
  ${brb.BRB_OVERLAY_CSS}
</style>
</head>
<body>
<div class="scene">
  <div class="top-bar" id="topBar">
    <div class="top-btn" id="brbBtn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="10" y1="15" x2="10" y2="9"/><line x1="14" y1="15" x2="14" y2="9"/></svg><span>BRB</span></div>
    <div class="top-btn" id="playBtn"><svg id="pbIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg><span id="pbLabel">Pause</span></div>
    <div class="top-btn" id="fsBtn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg><span>Fullscreen</span></div>
  </div>
  <video id="vid" autoplay loop muted playsinline src="/assets/${videoFile}"></video>
  ${termsUrl ? `<div class="terms-notice">By participating, you agree to our terms of service: ${termsUrl}</div>` : ""}
</div>
` + brb.overlayHtml() + `
<script>
${brb.BRB_OVERLAY_SCRIPT}
var v = document.getElementById("vid");
v.play().catch(function() {});

// Hide controls when embedded in combo iframe
if (window.self !== window.top) {
  document.getElementById("topBar").style.display = "none";
}

// BRB overlay toggle
document.getElementById("brbBtn").addEventListener("click", function() { toggleBrb(); });

// Custom play/pause button only
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

function buildBreakHtml() {
    const eventName = settings.get("eventName") || "";
    const breakMsg = settings.get("breakMessage") || "";
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/assets/icon-twilio-bug-red.svg">
<title>Break - ${eventName}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: #0a0a12; }

  /* Animated gradient orbs */
  body::before, body::after {
    content: ''; position: fixed; border-radius: 50%; filter: blur(120px); opacity: .35;
    animation: brbFloat 8s ease-in-out infinite alternate;
  }
  body::before {
    width: 60vmax; height: 60vmax; top: -20%; left: -15%;
    background: radial-gradient(circle, #F22F46 0%, transparent 70%);
  }
  body::after {
    width: 50vmax; height: 50vmax; bottom: -20%; right: -15%;
    background: radial-gradient(circle, #6e56cf 0%, transparent 70%);
    animation-delay: -4s; animation-direction: alternate-reverse;
  }
  @keyframes brbFloat {
    0% { transform: translate(0, 0) scale(1); }
    100% { transform: translate(5vw, -5vh) scale(1.15); }
  }

  .wrap {
    position: relative; z-index: 1; width: 100%; height: 100%;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    text-align: center; padding: 40px;
    font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
    animation: fadeIn .6s ease-out;
  }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }

  .logo {
    width: 56px; height: 56px; margin-bottom: 36px; opacity: .6;
    animation: logoPulse 3s ease-in-out infinite;
  }
  @keyframes logoPulse { 0%,100% { opacity: .4; transform: scale(1); } 50% { opacity: .7; transform: scale(1.05); } }

  h1 {
    font-size: clamp(48px, 7vw, 96px); font-weight: 800; letter-spacing: -2px;
    line-height: 1; margin-bottom: 20px;
    background: linear-gradient(135deg, #fff 0%, rgba(255,255,255,.6) 100%);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    background-clip: text;
  }
  .event {
    font-size: clamp(16px, 2.5vw, 28px); font-weight: 500;
    color: rgba(255,255,255,.35); margin-bottom: 20px; letter-spacing: .5px;
  }
  .msg {
    font-size: clamp(15px, 1.8vw, 22px); color: rgba(255,255,255,.25);
    max-width: 520px; line-height: 1.6;
  }
  .dots { margin-top: 48px; display: flex; gap: 10px; }
  .dots span {
    width: 8px; height: 8px; border-radius: 50%; background: #F22F46;
    animation: dot 2s ease-in-out infinite;
  }
  .dots span:nth-child(2) { animation-delay: .3s; }
  .dots span:nth-child(3) { animation-delay: .6s; }
  @keyframes dot { 0%,100% { opacity: .15; transform: scale(.8); } 50% { opacity: .8; transform: scale(1.2); } }
</style>
</head>
<body>
  <div class="wrap">
    <img class="logo" src="/assets/icon-twilio-bug-red.svg" alt="">
    <h1>We'll Be Right Back</h1>
    ${eventName && eventName !== "default" ? `<div class="event">${eventName}</div>` : ""}
    ${breakMsg ? `<div class="msg">${breakMsg}</div>` : ""}
    <div class="dots"><span></span><span></span><span></span></div>
  </div>
</body>
</html>`;
} // end buildBreakHtml

function buildComboHtml() {
return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/assets/icon-twilio-bug-red.svg">
<title>Booth Display — Twilio Photobooth</title>
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
}

function mountHome(app) {
    app.use("/templates", express.static(path.join(__dirname, "..", "templates")));
    app.use("/brand-references", express.static(path.join(__dirname, "..", "brand-references")));
    app.use("/assets", express.static(ASSETS_DIR));
    app.use("/home", router);
    console.log("🏠 Home page mounted at /home");
}

module.exports = { mountHome };
