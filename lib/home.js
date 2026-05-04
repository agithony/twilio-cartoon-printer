const path = require("path");
const express = require("express");
const settings = require("./settings");
const brb = require("./brb");
const { userBarSnippet, magicHatSnippet } = require("./auth");

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

router.get("/panel", (req, res) => {
    res.type("html").send(buildStaticPanelHtml());
});

router.get("/combo", (req, res) => {
    res.type("html").send(buildComboHtml());
});

function buildHomeHtml() {
return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script>(function(){var t=localStorage.getItem('twilio-theme')||'dark';document.documentElement.setAttribute('data-theme',t)})()</script>
<link rel="icon" type="image/svg+xml" href="/assets/icon-twilio-bug-red.svg">
<link rel="stylesheet" href="/assets/twilio-brand.css">
<title>Home — Twilio Photobooth</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { font-size: 17px; }
  body {
    min-height: 100vh;
    padding: clamp(24px, 4vw, 56px) clamp(16px, 3vw, 40px);
  }
  .wrap { max-width: 920px; margin: 0 auto; }

  /* Header */
  .hero { text-align: center; margin-bottom: 48px; padding-top: 8px; position: relative; }
  .hero-brand { display: flex; align-items: center; justify-content: center; gap: 12px; margin-bottom: 12px; }
  .hero-brand svg { flex-shrink: 0; }
  .hero h1 { font-family: 'Twilio Sans Display', sans-serif; font-size: 30px; font-weight: 800; color: var(--th-text); letter-spacing: 0.02em; line-height: 1; }
  .hero .subtitle { font-size: 16px; color: var(--th-text-muted); font-weight: 400; margin-top: 8px; }

  /* Action cards */
  .actions { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 40px; }
  .action-card {
    background: var(--th-card-gradient);
    border: 1px solid var(--th-card-border);
    border-radius: 16px;
    padding: 26px;
    text-decoration: none;
    transition: all .25s ease;
    /* Flex column so the action button (sub-toggle / sub-options) always
       sits at the bottom of the card, even when other cards have longer
       descriptive text. The title + description grow from the top; the
       auto-top-margin on the action pushes it to the bottom. */
    display: flex; flex-direction: column;
    box-shadow: 0 2px 8px var(--th-card-shadow);
  }
  /* Push the action button / sub-options container to the bottom of the card
     so buttons align across tiles regardless of description length. Higher
     specificity (class + child selector twice) to beat .sub-options.open's
     margin-top: 16px rule defined earlier. */
  .action-card > .sub-toggle.sub-toggle,
  .action-card > .sub-options.sub-options { margin-top: auto; }
  .action-card > .sub-options.sub-options.open { margin-top: auto; }
  .action-card:hover { border-color: var(--th-raised); box-shadow: 0 12px 40px var(--th-card-shadow); transform: translateY(-3px); }
  .action-card .card-icon { width: 40px; height: 40px; border-radius: 10px; display: flex; align-items: center; justify-content: center; margin-bottom: 16px; }
  .action-card .card-icon svg { width: 20px; height: 20px; }
  .action-card.dashboard .card-icon { background: rgba(33,136,239,0.1); color: var(--blue-400); }
  .action-card.booth .card-icon { background: rgba(239,34,58,0.1); color: var(--brand-red); }
  .action-card.outreach .card-icon { background: rgba(25,171,243,0.1); color: var(--blue-300); }
  .action-card h2 { font-size: 17px; font-weight: 700; color: var(--th-text); margin-bottom: 8px; }
  .action-card p { font-size: 14px; color: var(--th-text-muted); line-height: 1.6; }

  /* Expandable sub-options */
  .sub-options { overflow: hidden; max-height: 0; transition: max-height .3s ease, margin .3s ease; margin-top: 0; }
  .sub-options.open { max-height: 200px; margin-top: 16px; }
  .sub-toggle {
    display: inline-flex; align-items: center; gap: 6px;
    margin-top: 16px; padding: 6px 12px; border-radius: 8px;
    border: 1px solid var(--th-raised); background: var(--th-border-subtle);
    font-size: 13px; color: var(--th-text-dim);
    cursor: pointer; font-family: inherit; transition: all .15s;
  }
  .sub-toggle:hover { color: var(--th-text-label); border-color: var(--th-text-muted); }
  .sub-toggle svg { width: 12px; height: 12px; transition: transform .25s; }
  .sub-toggle.open svg { transform: rotate(180deg); }
  .sub-links { display: flex; gap: 8px; flex-wrap: wrap; }
  .sub-link {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 8px 16px; border-radius: 8px;
    background: var(--th-border-subtle); border: 1px solid var(--th-raised);
    color: var(--th-text-dim); text-decoration: none;
    font-size: 13px; font-weight: 400; transition: all .15s;
  }
  .sub-link:hover { background: var(--th-raised); border-color: var(--th-card-border); color: var(--th-text); }

  /* Sections */
  .section { margin-bottom: 36px; }
  .section-title {
    font-family: 'Twilio Sans Mono', monospace;
    font-size: 12px; font-weight: 400; color: var(--th-text-muted);
    text-transform: uppercase; letter-spacing: 1px; margin-bottom: 16px;
    padding-bottom: 12px; border-bottom: 1px solid var(--th-border-subtle);
  }

  /* How it works */
  .steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  @media (max-width: 640px) { .steps { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 420px) { .steps { grid-template-columns: 1fr; } }
  .step {
    background: var(--th-card-gradient);
    border: 1px solid var(--th-card-border);
    border-radius: 14px;
    padding: 18px;
    display: flex;
    gap: 12px;
    align-items: flex-start;
    transition: border-color .2s, box-shadow .2s;
  }
  .step:hover { border-color: var(--th-raised); box-shadow: 0 2px 8px var(--th-card-shadow); }
  .step-num {
    display: inline-flex; align-items: center; justify-content: center;
    width: 24px; height: 24px; border-radius: 50%; flex-shrink: 0;
    background: rgba(239,34,58,0.08); color: var(--brand-red);
    font-size: 12px; font-weight: 700;
  }
  .step-text { font-size: 13px; color: var(--th-text-dim); line-height: 1.5; }
  .step-text a { color: var(--blue-400); text-decoration: none; font-weight: 700; transition: color .15s; }
  .step-text a:hover { color: var(--blue-300); text-decoration: underline; }

  .footer {
    text-align: center; color: var(--th-text-muted); font-size: 12px; font-weight: 400;
    margin-top: 48px; padding-top: 24px; border-top: 1px solid var(--th-border-subtle);
  }
  .footer a { color: var(--th-text-muted); text-decoration: none; }
  .footer a:hover { color: var(--th-text-dim); }

  /* Settings panel */
  @keyframes settings-pulse {
    0%, 100% { box-shadow: 0 4px 14px var(--th-card-shadow), 0 0 0 0 rgba(239,34,58,0); }
    50% { box-shadow: 0 4px 14px var(--th-card-shadow), 0 0 22px 2px rgba(239,34,58,0.22); }
  }
  .settings-toggle {
    display: flex; align-items: center; gap: 20px; cursor: pointer;
    padding: 24px 28px;
    background:
      linear-gradient(135deg, rgba(239,34,58,0.06) 0%, transparent 55%),
      var(--th-card-gradient);
    border: 1px solid var(--th-card-border);
    border-radius: 14px;
    margin-bottom: 20px;
    transition: border-color .2s ease, transform .15s ease, box-shadow .2s ease;
    user-select: none;
    box-shadow: 0 4px 14px var(--th-card-shadow);
    animation: settings-pulse 3.2s ease-in-out infinite;
    position: relative;
  }
  .settings-toggle::before {
    content: "";
    position: absolute; left: 0; top: 12px; bottom: 12px;
    width: 3px; border-radius: 3px;
    background: var(--brand-red);
  }
  .settings-toggle:hover { border-color: var(--th-raised); transform: translateY(-1px); box-shadow: 0 6px 20px var(--th-card-shadow); animation: none; }
  .settings-toggle.open { border-color: var(--th-raised); margin-bottom: 0; border-radius: 14px 14px 0 0; border-bottom-color: var(--th-card-border); transform: none; animation: none; box-shadow: 0 4px 14px var(--th-card-shadow); }
  .settings-toggle-body { flex: 1; min-width: 0; }
  .settings-toggle-eyebrow { font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--brand-red); margin-bottom: 6px; }
  .settings-toggle h3 { font-family: 'Twilio Sans Display', sans-serif; font-size: 20px; font-weight: 800; color: var(--th-text); margin-bottom: 4px; letter-spacing: 0.005em; line-height: 1.15; }
  .settings-toggle-sub { font-size: 13px; color: var(--th-text-muted); font-weight: 400; line-height: 1.5; margin: 0; }
  .settings-toggle-chev { width: 16px; height: 16px; color: var(--th-text-muted); flex-shrink: 0; transition: transform .3s ease, color .15s ease; }
  .settings-toggle:hover .settings-toggle-chev { color: var(--brand-red); }
  .settings-toggle.open .settings-toggle-chev { transform: rotate(180deg); color: var(--brand-red); }
  .settings-panel { overflow: hidden; max-height: 0; transition: max-height .4s ease, overflow 0s .4s; padding: 0 2px; }
  /* max-height acts purely as an animation cap. Real content can exceed
     15000px when many accordion sections (especially Messages) are open,
     and because overflow is visible, the overflowing content used to bleed
     downward and overlap the Prompt Lab + Magician cards that follow.
     Setting a very large cap keeps the animation smooth while letting the
     panel reserve real height in the normal flow. */
  .settings-panel.open { max-height: 999999px; overflow: visible; transition: max-height .5s ease, overflow 0s 0s; padding-top: 16px; }
  .sg { background: var(--th-card-gradient); border: 1px solid var(--th-card-border); border-radius: 16px; padding: 26px; margin-bottom: 14px; transition: all .2s ease; box-shadow: 0 2px 8px var(--th-card-shadow); }
  .sg:hover { border-color: var(--th-raised); box-shadow: 0 4px 16px var(--th-card-shadow); }
  .sg h4 { font-family: 'Twilio Sans Display', sans-serif; font-size: 15px; font-weight: 800; color: var(--th-text); margin-bottom: 18px; padding-left: 12px; border-left: 3px solid var(--brand-red); line-height: 1.1; padding-top: 2px; padding-bottom: 2px; letter-spacing: 0.02em; }
  .sg-group { margin-bottom: 8px; }
  .sg-group:last-of-type { margin-bottom: 0; }
  .sg-group-header {
    font-family: 'Twilio Sans Mono', monospace;
    font-size: 11px; font-weight: 700; color: var(--th-text-muted);
    text-transform: uppercase; letter-spacing: 2px;
    padding: 10px 0;
    display: flex; align-items: center; gap: 14px;
    cursor: pointer; user-select: none; transition: color .15s;
  }
  .sg-group-header:hover { color: var(--th-text-dim); }
  .sg-group-header::before {
    content: ''; display: inline-block; width: 6px; height: 6px;
    border-right: 2px solid currentColor; border-bottom: 2px solid currentColor;
    transform: rotate(-45deg); transition: transform .2s ease;
    flex-shrink: 0;
  }
  .sg-group.open .sg-group-header::before { transform: rotate(45deg); }
  .sg-group-header::after { content: ''; flex: 1; height: 1px; background: linear-gradient(to right, var(--th-card-border), transparent); }
  .sg-group-body { display: none; padding-top: 8px; padding-bottom: 12px; }
  .sg-group.open .sg-group-body { display: block; }
  .sg-group:nth-child(1) .sg h4 { border-left-color: var(--brand-red); }
  .sg-group:nth-child(2) .sg h4 { border-left-color: var(--blue-400); }
  .sg-group:nth-child(3) .sg h4 { border-left-color: var(--blue-500); }
  .sg-group:nth-child(4) .sg h4 { border-left-color: var(--blue-300); }
  .sg-group:nth-child(5) .sg h4 { border-left-color: var(--red-400); }
  .sg-group:nth-child(6) .sg h4 { border-left-color: var(--red-300); }
  .sg-group:nth-child(7) .sg h4 { border-left-color: var(--gray-500); }
  .sf-sub-label {
    font-family: 'Twilio Sans Mono', monospace;
    font-size: 11px; font-weight: 700; color: var(--th-text-muted);
    text-transform: uppercase; letter-spacing: 1.5px;
    margin-bottom: 14px; padding-bottom: 0;
  }
  .sf { margin-bottom: 18px; }
  .sf:last-child { margin-bottom: 0; }
  .sf label { display: block; font-size: 13px; color: var(--th-text-muted); margin-bottom: 8px; font-weight: 400; letter-spacing: 0.01em; }
  .sf input[type="text"], .sf input[type="number"], .sf input[type="url"], .sf input[type="password"], .sf select, .sf textarea {
    width: 100%; padding: 11px 14px; border-radius: 10px; border: 1px solid var(--th-card-border);
    background: var(--th-input); color: var(--th-text); font-size: 14px; font-family: inherit;
    transition: border-color .2s, box-shadow .2s, background-color .2s;
  }
  .sf input:focus, .sf select:focus, .sf textarea:focus { outline: none; border-color: var(--blue-400); box-shadow: 0 0 0 3px rgba(33,136,239,0.08); }
  .sf textarea { resize: vertical; min-height: 64px; line-height: 1.5; }
  .combo-box { position: relative; }
  .combo-box input { padding-right: 36px; }
  .combo-arrow {
    position: absolute; right: 1px; top: 1px; bottom: 1px; width: 34px;
    background: none; border: none; cursor: pointer; color: var(--th-text-muted);
    display: flex; align-items: center; justify-content: center;
    border-radius: 0 8px 8px 0; transition: color .15s;
  }
  .combo-arrow:hover { color: var(--th-text-dim); }
  .combo-dropdown {
    display: none; position: absolute; left: 0; right: 0; top: 100%; margin-top: 4px;
    background: var(--th-card); border: 1px solid var(--th-card-border); border-radius: 8px;
    max-height: 180px; overflow-y: auto; z-index: 50;
    box-shadow: 0 10px 32px var(--th-card-shadow), 0 0 0 1px rgba(33,136,239,0.08);
  }
  .combo-dropdown.open { display: block; }
  .combo-dropdown .combo-item {
    padding: 9px 14px; font-size: 14px; color: var(--th-text-dim); cursor: pointer;
    transition: background .1s, color .1s; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    border-bottom: 1px solid var(--th-raised);
  }
  .combo-dropdown .combo-item:last-child { border-bottom: none; }
  .combo-dropdown .combo-item:first-child { border-radius: 7px 7px 0 0; }
  .combo-dropdown .combo-item:last-child { border-radius: 0 0 7px 7px; }
  .combo-dropdown .combo-item:only-child { border-radius: 7px; }
  .combo-dropdown .combo-item:hover, .combo-dropdown .combo-item.active { background: var(--th-raised); color: var(--th-text); }
  .combo-dropdown .combo-item .combo-current { font-size: 11px; color: var(--blue-400); margin-left: 6px; }
  .combo-dropdown .combo-item .combo-saved { font-size: 10px; color: var(--blue-400); background: rgba(33,136,239,0.12); padding: 1px 6px; border-radius: 3px; margin-left: 6px; }
  .combo-dropdown .combo-item.combo-create { color: var(--blue-400); font-weight: 400; }
  .combo-dropdown .combo-item.combo-create:hover { color: var(--blue-300); background: rgba(33,136,239,0.08); }
  .combo-dropdown .combo-empty { padding: 9px 14px; font-size: 13px; color: var(--th-text-muted); font-style: italic; }
  .sf-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 540px) { .sf-row { grid-template-columns: 1fr; } }
  .preview-box { margin-top: 12px; display: none; text-align: center; }
  .preview-box img { max-width: 100%; max-height: 200px; border-radius: 8px; border: 1px solid var(--th-card-border); background: var(--th-bg); }
  .preview-box video { max-width: 100%; max-height: 160px; border-radius: 8px; border: 1px solid var(--th-card-border); background: var(--th-bg); }
  .preview-box .no-preview { font-size: 12px; color: var(--th-text-muted); font-style: italic; }
  .style-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
  .style-card {
    background: var(--th-bg); border: 1px solid var(--th-border-subtle); border-radius: 12px; overflow: hidden;
    transition: all .2s;
  }
  .style-card:hover { border-color: var(--th-card-border); box-shadow: 0 4px 16px var(--th-card-shadow); }
  .style-card.disabled { opacity: .35; filter: grayscale(0.3); }
  .style-card-thumb {
    width: 100%; aspect-ratio: 5/7; background: var(--th-bg); display: flex;
    align-items: center; justify-content: center; overflow: hidden;
  }
  .style-card-thumb img { width: 100%; height: 100%; object-fit: cover; }
  .style-card-thumb .no-thumb { font-size: 11px; color: var(--th-card-border); }
  .style-card-body { padding: 12px; }
  .style-card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px; }
  .style-card-header .sname { font-size: 14px; font-weight: 700; color: var(--th-text-dim); }
  .style-card-header input.sname-edit { font-size: 14px; font-weight: 700; color: var(--th-text-dim); background: transparent; border: 1px solid transparent; border-radius: 4px; padding: 1px 4px; font-family: inherit; width: 100%; transition: border-color .2s; }
  .style-card-header input.sname-edit:hover { border-color: var(--th-raised); }
  .style-card-header input.sname-edit:focus { outline: none; border-color: var(--blue-400); background: var(--th-bg); }
  .style-card-header .slabel { font-size: 11px; color: var(--th-text-muted); }
  .style-card-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; margin-top: 6px; }
  .prompt-link { font-size: 11px; color: var(--th-text-dim); cursor: pointer; background: var(--th-border-subtle); border: 1px solid var(--th-card-border); padding: 4px 10px; border-radius: 6px; font-family: inherit; white-space: nowrap; text-decoration: none; display: inline-block; transition: all .15s; font-weight: 700; }
  .prompt-link:hover { background: var(--th-raised); border-color: var(--th-text-muted); color: var(--th-text); }
  .style-card-actions .prompt-link { font-size: 11px; }
  .style-card-actions .remove-link { font-size: 11px; color: var(--brand-red); cursor: pointer; background: var(--th-border-subtle); border: 1px solid rgba(239,34,58,0.2); padding: 4px 10px; border-radius: 6px; font-family: inherit; white-space: nowrap; text-decoration: none; transition: all .15s; font-weight: 700; }
  .style-card-actions .remove-link:hover { background: rgba(239,34,58,0.08); border-color: rgba(239,34,58,0.4); }
  .style-card-actions .toggle-sw { margin-left: auto; }
  .toggle-sw { position: relative; width: 38px; height: 22px; flex-shrink: 0; }
  .toggle-sw input { opacity: 0; width: 0; height: 0; }
  .toggle-sw .slider { position: absolute; inset: 0; border-radius: 11px; background: var(--th-toggle-off); cursor: pointer; transition: background .25s; }
  .toggle-sw .slider::before { content: ''; position: absolute; left: 3px; top: 3px; width: 16px; height: 16px; border-radius: 50%; background: var(--th-text-muted); transition: transform .25s, background .25s; box-shadow: 0 1px 3px rgba(0,0,0,.3); }
  .toggle-sw input:checked + .slider { background: var(--brand-red); }
  .toggle-sw input:checked + .slider::before { background: #fff; transform: translateX(16px); }
  .delivery-switch { display: flex; gap: 0; border-radius: 12px; overflow: hidden; border: 1px solid var(--th-card-border); }
  .delivery-switch button {
    flex: 1; padding: 12px 16px; border: none; cursor: pointer; font-size: 14px; font-weight: 700;
    font-family: inherit; transition: all .2s; display: flex; align-items: center; justify-content: center; gap: 8px;
  }
  .delivery-switch button.ds-print {
    background: var(--th-border-subtle); color: var(--th-text-muted);
  }
  .delivery-switch button.ds-print.active {
    background: rgba(239,34,58,0.13); color: var(--brand-red); box-shadow: inset 0 0 0 1px rgba(239,34,58,0.4);
  }
  .delivery-switch button.ds-digital {
    background: var(--th-border-subtle); color: var(--th-text-muted);
  }
  .delivery-switch button.ds-digital.active {
    background: rgba(33,136,239,0.13); color: var(--blue-400); box-shadow: inset 0 0 0 1px rgba(33,136,239,0.4);
  }
  .delivery-switch button svg { width: 16px; height: 16px; flex-shrink: 0; }
  .delivery-switch button.lc-btn { background: var(--th-border-subtle); color: var(--th-text-muted); }
  .delivery-switch button.lc-btn.active { background: rgba(24,102,238,0.13); color: var(--blue-500); box-shadow: inset 0 0 0 1px rgba(24,102,238,0.4); }
  .delivery-status.mode-lead { background: rgba(24,102,238,0.07); color: var(--blue-500); border: 1px solid rgba(24,102,238,0.15); }
  .delivery-status { font-size: 12px; font-weight: 400; margin-top: 10px; padding: 8px 14px; border-radius: 8px; transition: all .2s; }
  .delivery-status.mode-both { background: rgba(239,34,58,0.07); color: var(--brand-red); border: 1px solid rgba(239,34,58,0.15); }
  .delivery-status.mode-digital { background: rgba(33,136,239,0.07); color: var(--blue-400); border: 1px solid rgba(33,136,239,0.15); }
  .phone-tags { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
  .phone-tag { display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; border-radius: 8px; background: var(--th-border-subtle); color: var(--th-text-dim); font-size: 13px; font-family: 'Twilio Sans Mono', monospace; border: 1px solid var(--th-card-border); transition: border-color .15s; }
  .phone-tag:hover { border-color: var(--th-raised); }
  .phone-tag .remove { cursor: pointer; color: var(--th-text-muted); font-weight: bold; font-size: 13px; line-height: 1; transition: color .15s; }
  .phone-tag .remove:hover { color: var(--brand-red); }
  .phone-add { display: flex; gap: 8px; }
  .phone-add input { flex: 1; }
  .brand-ref-tags { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
  .brand-ref-tag { display: inline-flex; align-items: center; gap: 8px; padding: 5px 12px; border-radius: 8px; background: var(--th-border-subtle); color: var(--th-text-muted); font-size: 13px; border: 1px solid var(--th-card-border); transition: border-color .15s, opacity .15s; cursor: pointer; opacity: 0.6; }
  .brand-ref-tag.selected { color: var(--th-text-dim); border-color: var(--brand-red); opacity: 1; }
  .brand-ref-tag:hover { border-color: var(--th-raised); }
  .brand-ref-tag.selected:hover { border-color: var(--brand-red); }
  .brand-ref-tag input[type="checkbox"] { accent-color: var(--brand-red); margin: 0; cursor: pointer; }
  .brand-ref-tag img { width: 32px; height: 32px; object-fit: cover; border-radius: 6px; }
  .brand-ref-tag .brand-ref-delete { cursor: pointer; color: var(--th-text-muted); font-weight: bold; font-size: 13px; line-height: 1; transition: color .15s; margin-left: 2px; }
  .brand-ref-tag .brand-ref-delete:hover { color: var(--brand-red); }
  .btn { padding: 10px 20px; border-radius: 10px; border: 1px solid var(--th-raised); background: var(--th-border-subtle); color: var(--th-text-dim); font-size: 14px; font-weight: 400; cursor: pointer; transition: all .2s; font-family: inherit; }
  .btn:hover { background: var(--th-raised); border-color: var(--th-card-border); color: var(--th-text); transform: translateY(-1px); }
  .btn:active { transform: translateY(0); }
  .btn-primary { background: linear-gradient(135deg, var(--brand-red), var(--brand-red-hover)); border-color: var(--brand-red); color: #fff; font-weight: 700; box-shadow: 0 2px 8px rgba(239,34,58,0.2); }
  .btn-primary:hover { background: linear-gradient(135deg, var(--red-400), var(--brand-red)); border-color: var(--red-400); box-shadow: 0 6px 20px rgba(239,34,58,0.3); }
  .btn-danger { border-color: rgba(239,34,58,0.2); color: var(--brand-red); }
  .btn-danger:hover { background: rgba(239,34,58,0.06); }
  .btn-success { background: var(--blue-600); font-weight: 700; color: #fff; }
  .btn-success:hover { background: var(--blue-700); }
  .btn-secondary { background: var(--gray-600); color: #fff; }
  .btn-secondary:hover { background: var(--gray-700); }
  .settings-actions {
    display: none; gap: 12px; align-items: center;
    padding: 16px 24px; position: sticky; bottom: 16px;
    background: var(--th-bg); backdrop-filter: blur(12px);
    border: 1px solid var(--th-raised); border-radius: 14px;
    margin-top: 16px; z-index: 10;
    box-shadow: 0 -4px 24px var(--th-card-shadow);
  }
  .custom-style-form { margin-top: 14px; padding: 20px; border-radius: 12px; background: var(--th-bg); border: 1px solid var(--th-card-border); }
  .custom-style-form .sf { margin-bottom: 12px; }
  .tip {
    display: inline-flex; align-items: center; justify-content: center;
    width: 16px; height: 16px; border-radius: 50%; background: var(--th-card-border); color: var(--th-text-muted);
    font-size: 10px; font-weight: 700; cursor: help; position: relative;
    margin-left: 5px; vertical-align: middle; flex-shrink: 0; transition: all .15s;
  }
  .tip:hover { background: var(--th-raised); color: var(--th-text-dim); }
  .tip:hover::after {
    content: attr(data-tip); position: absolute; bottom: calc(100% + 10px); left: 50%; transform: translateX(-50%);
    background: var(--th-card); color: var(--th-text-dim); padding: 12px 16px; border-radius: 10px;
    font-size: 12px; font-weight: 400; line-height: 1.6; white-space: normal;
    width: max-content; max-width: 300px; z-index: 100; box-shadow: 0 12px 32px var(--th-card-shadow);
    pointer-events: none; border: 1px solid var(--th-raised);
  }
  .tip:hover::before {
    content: ''; position: absolute; bottom: calc(100% + 5px); left: 50%; transform: translateX(-50%);
    border: 5px solid transparent; border-top-color: var(--th-card); z-index: 100;
  }
  .sg-help { display: inline; }
  .sg-help .tip { margin-left: 6px; }
  .file-upload-row { display: flex; gap: 10px; align-items: center; margin-top: 10px; flex-wrap: wrap; }
  .file-upload-row input[type="file"] { font-size: 12px; color: var(--th-text-muted); }
  .file-upload-row input[type="file"]::file-selector-button {
    padding: 7px 14px; border-radius: 8px; border: 1px solid var(--th-raised); background: var(--th-border-subtle);
    color: var(--th-text-dim); font-size: 12px; cursor: pointer; font-family: inherit; transition: all .2s; margin-right: 4px;
  }
  .file-upload-row input[type="file"]::file-selector-button:hover { background: var(--th-raised); color: var(--th-text); }
  .upload-status { font-size: 12px; color: var(--blue-400); font-weight: 400; }
  .upload-status.err { color: var(--brand-red); }
  .save-banner {
    position: fixed; top: 24px; left: 50%; transform: translateX(-50%) translateY(-20px);
    padding: 14px 28px; border-radius: 12px; font-size: 14px; font-weight: 700;
    text-align: center; z-index: 1000; pointer-events: none;
    display: none; animation: bannerSlide 3.5s ease forwards;
    box-shadow: 0 8px 32px rgba(0,0,0,.4);
  }
  .save-banner.success { display: block; background: var(--blue-850); color: var(--blue-400); border: 1px solid rgba(33,136,239,0.25); }
  .save-banner.reset-ok { display: block; background: var(--blue-850); color: var(--blue-400); border: 1px solid rgba(33,136,239,0.25); }
  @keyframes bannerSlide { 0% { opacity: 0; transform: translateX(-50%) translateY(-20px); } 8% { opacity: 1; transform: translateX(-50%) translateY(0); } 75% { opacity: 1; transform: translateX(-50%) translateY(0); } 100% { opacity: 0; transform: translateX(-50%) translateY(-10px); } }
  @keyframes spin { to { transform: rotate(360deg); } }
  .btn-sm { padding: 6px 12px; font-size: 12px; }
  .select-row { display: flex; gap: 8px; align-items: center; }
  .select-row select { flex: 1; }
  textarea.style-prompt { display: none; margin-top: 8px; padding: 8px 10px; border-radius: 6px; background: var(--th-bg); border: 1px solid var(--th-border-subtle); font-size: 11px; color: var(--th-text-dim); line-height: 1.5; width: 100%; resize: vertical; font-family: inherit; min-height: 80px; transition: border-color .2s; }
  textarea.style-prompt:focus { outline: none; border-color: var(--blue-400); box-shadow: 0 0 0 3px rgba(33,136,239,0.1); }
  textarea.style-prompt.open { display: block; }
  div.style-prompt[id^="srf_"], div.style-prompt[id^="brf"], div.style-prompt[id^="bgf"] { display: none; }
  div.style-prompt[id^="srf_"].open, div.style-prompt[id^="brf"].open, div.style-prompt[id^="bgf"].open { display: block; }
  .reset-link { font-size: 11px; color: var(--th-text-muted); cursor: pointer; background: none; border: none; padding: 2px 6px; font-family: inherit; border-radius: 3px; transition: color .15s, background .15s; }
  .reset-link:hover { color: var(--blue-300); background: rgba(25,171,243,0.08); }
  .style-card-actions .reset-link { display: none; padding: 0; }
  .style-card-actions .reset-link.visible { display: inline; }

  /* Brand/style advanced config panels (category, wardrobe, palette, scenes) */
  .adv-panel {
    margin-top: 10px; padding: 14px; border-radius: 10px;
    background: var(--th-bg); border: 1px solid var(--th-border-subtle);
    display: flex; flex-direction: column; gap: 12px;
  }
  .adv-row { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
  .adv-field { display: flex; flex-direction: column; gap: 6px; }
  .adv-field-label {
    font-family: 'Twilio Sans Mono', monospace;
    font-size: 10px; font-weight: 700; color: var(--th-text-muted);
    text-transform: uppercase; letter-spacing: 1.2px;
  }
  .adv-select {
    padding: 7px 28px 7px 10px; border-radius: 8px; border: 1px solid var(--th-card-border);
    background: var(--th-input); color: var(--th-text-dim); font-size: 12px; font-family: inherit;
    cursor: pointer; transition: border-color .15s, box-shadow .15s;
    appearance: none; -webkit-appearance: none;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path d='M1 1l4 4 4-4' fill='none' stroke='%238893A7' stroke-width='1.5' stroke-linecap='round'/></svg>");
    background-repeat: no-repeat; background-position: right 10px center;
  }
  .adv-select:focus { outline: none; border-color: var(--blue-400); box-shadow: 0 0 0 3px rgba(33,136,239,0.1); }
  .adv-checkbox {
    display: inline-flex; align-items: center; gap: 8px;
    font-size: 12px; color: var(--th-text-dim); cursor: pointer; user-select: none;
  }
  .adv-checkbox input[type="checkbox"] { accent-color: var(--brand-red); margin: 0; cursor: pointer; width: 14px; height: 14px; }
  .adv-textarea {
    width: 100%; padding: 9px 12px; border-radius: 8px; border: 1px solid var(--th-card-border);
    background: var(--th-input); color: var(--th-text); font-size: 12px; font-family: inherit;
    line-height: 1.5; resize: vertical; min-height: 54px;
    transition: border-color .15s, box-shadow .15s;
  }
  .adv-textarea:focus { outline: none; border-color: var(--blue-400); box-shadow: 0 0 0 3px rgba(33,136,239,0.08); }
  .adv-textarea::placeholder { color: var(--th-text-muted); }

  /* Scenes repeater */
  .scenes-header { display: flex; justify-content: space-between; align-items: center; }
  .scene-list { display: flex; flex-direction: column; gap: 8px; }
  .scene-row {
    padding: 10px 12px; border-radius: 10px;
    background: var(--th-card-gradient); border: 1px solid var(--th-border-subtle);
    display: flex; flex-direction: column; gap: 8px;
    transition: border-color .15s;
  }
  .scene-row:hover { border-color: var(--th-card-border); }
  .scene-row-top { display: flex; align-items: center; gap: 8px; }
  .scene-key {
    font-family: 'Twilio Sans Mono', monospace; font-size: 10px;
    color: var(--th-text-muted); padding: 3px 8px; border-radius: 4px;
    background: var(--th-border-subtle); white-space: nowrap;
  }
  .scene-name-input {
    flex: 1; padding: 7px 10px; border-radius: 7px; border: 1px solid transparent;
    background: var(--th-input); color: var(--th-text-dim); font-size: 13px;
    font-family: inherit; font-weight: 700; transition: border-color .15s, background .15s;
  }
  .scene-name-input:focus { outline: none; border-color: var(--blue-400); background: var(--th-bg); }
  .scene-remove {
    background: transparent; border: 1px solid transparent; border-radius: 6px;
    width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center;
    color: var(--th-text-muted); cursor: pointer; font-size: 14px; line-height: 1;
    transition: all .15s; padding: 0;
  }
  .scene-remove:hover { color: var(--brand-red); background: rgba(239,34,58,0.08); border-color: rgba(239,34,58,0.2); }
  .scenes-empty {
    padding: 14px; border-radius: 8px; text-align: center;
    background: var(--th-border-subtle); border: 1px dashed var(--th-card-border);
    font-size: 12px; color: var(--th-text-muted); font-style: italic;
  }

  /* Soft config warning banner */
  .config-warning {
    margin-top: 10px; padding: 10px 12px; border-radius: 8px;
    background: rgba(245,166,35,0.08); border: 1px solid rgba(245,166,35,0.28);
    font-size: 12px; color: var(--th-text-dim); line-height: 1.5;
    display: flex; flex-direction: column; gap: 3px;
  }
  .config-warning::before {
    content: ''; display: block; width: 14px; height: 14px;
    background: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23F5A623' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'><path d='M8 1.5L14.5 13.5H1.5L8 1.5z'/><path d='M8 6v3.5M8 11.5v.01'/></svg>") no-repeat center/contain;
    flex-shrink: 0;
  }
  .config-warning-line { display: flex; gap: 6px; }
  .config-warning-line::before { content: '·'; color: rgba(245,166,35,0.8); font-weight: 700; }

  /* Themed prompt/confirm modal */
  .tw-modal-backdrop {
    position: fixed; inset: 0; z-index: 10000;
    background: rgba(0,0,0,0.55); backdrop-filter: blur(4px);
    display: flex; align-items: center; justify-content: center;
    padding: 24px; animation: tw-modal-fade .15s ease;
  }
  @keyframes tw-modal-fade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes tw-modal-rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  .tw-modal {
    width: 100%; max-width: 420px;
    background: var(--th-card); border: 1px solid var(--th-card-border); border-radius: 14px;
    padding: 22px; box-shadow: 0 20px 60px var(--th-card-shadow);
    animation: tw-modal-rise .18s ease;
  }
  .tw-modal-title { font-family: 'Twilio Sans Display', sans-serif; font-size: 16px; font-weight: 800; color: var(--th-text); margin-bottom: 6px; }
  .tw-modal-msg { font-size: 13px; color: var(--th-text-muted); line-height: 1.5; margin-bottom: 14px; }
  .tw-modal input.tw-modal-input {
    width: 100%; padding: 10px 13px; border-radius: 9px;
    border: 1px solid var(--th-card-border); background: var(--th-input);
    color: var(--th-text); font-size: 14px; font-family: inherit;
    transition: border-color .15s, box-shadow .15s;
  }
  .tw-modal input.tw-modal-input:focus { outline: none; border-color: var(--blue-400); box-shadow: 0 0 0 3px rgba(33,136,239,0.1); }
  .tw-modal-error { font-size: 12px; color: var(--brand-red); margin-top: 8px; min-height: 16px; }
  .tw-modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px; }

  /* ── Magician accents ─────────────────────────────────────────────── */
  /* Corner hat badge styles live in auth.js (magicHatSnippet). The --magic-* */
  /* tokens declared there are also used by the footer card below. */

  /* Footer card (shared destination block — Twilio bug + wand emblem) */
  @keyframes fc-bug-float {
    0%, 100% { transform: translateY(0) rotate(0deg); }
    50% { transform: translateY(-4px) rotate(3deg); }
  }
  @keyframes fc-aura-pulse {
    0%, 100% { opacity: 0.4; transform: scale(1); }
    50% { opacity: 0.65; transform: scale(1.15); }
  }
  @keyframes fc-orbit { to { transform: rotate(360deg); } }
  @keyframes fc-orbit-reverse { to { transform: rotate(-360deg); } }
  @keyframes fc-tip-glow {
    0%, 100% { filter: drop-shadow(0 0 5px rgba(233,196,106,0.7)); }
    50% { filter: drop-shadow(0 0 14px rgba(233,196,106,1)) drop-shadow(0 0 24px rgba(233,196,106,0.55)); }
  }
  @keyframes fc-wand-sway {
    0%, 100% { transform: rotate(-14deg); }
    50% { transform: rotate(-22deg); }
  }
  @keyframes fc-wand-cast {
    0% { transform: rotate(-14deg); }
    25% { transform: rotate(-40deg); }
    55% { transform: rotate(12deg); }
    100% { transform: rotate(-14deg); }
  }
  @keyframes fc-hover-burst {
    0% { opacity: 0; transform: translate(0, 0) scale(0); }
    30% { opacity: 1; }
    100% { opacity: 0; transform: translate(var(--bx, 0), var(--by, 0)) scale(1.3) rotate(180deg); }
  }
  @keyframes fc-bug-surprise {
    0% { transform: scale(1) rotate(0deg); }
    20% { transform: scale(1.25) rotate(-8deg); }
    45% { transform: scale(1.15) rotate(6deg); }
    70% { transform: scale(1.2) rotate(-3deg); }
    100% { transform: scale(1) rotate(0deg); }
  }
  @keyframes fc-aura-flash {
    0%, 100% { opacity: 0.65; transform: scale(1.15); }
    50% { opacity: 1; transform: scale(1.5); background: radial-gradient(circle, rgba(233,196,106,0.7) 0%, rgba(239,34,58,0.3) 40%, transparent 70%); }
  }
  .lab-card {
    display: flex;
    align-items: center;
    gap: 20px;
    margin-top: 20px;
    padding: 20px 24px;
    background: var(--th-card-gradient);
    border: 1px solid var(--th-card-border);
    border-radius: 14px;
    text-decoration: none;
    color: inherit;
    transition: border-color .2s ease, transform .15s ease, box-shadow .2s ease;
  }
  .lab-card:hover { border-color: var(--th-raised); transform: translateY(-1px); box-shadow: 0 4px 16px var(--th-card-shadow); }
  .lab-card-body { flex: 1; min-width: 0; }
  .lab-card-eyebrow { font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--th-text-muted); margin-bottom: 6px; }
  .lab-card h3 { font-family: 'Twilio Sans Display', sans-serif; font-size: 18px; font-weight: 700; color: var(--th-text); margin-bottom: 4px; letter-spacing: 0.005em; }
  .lab-card p { font-size: 13px; color: var(--th-text-muted); line-height: 1.5; margin: 0; }
  .lab-card-arrow { font-size: 22px; color: var(--th-text-muted); flex-shrink: 0; transition: transform .15s ease, color .15s ease; }
  .lab-card:hover .lab-card-arrow { transform: translateX(3px); color: var(--brand-red); }
  @media (max-width: 640px) { .lab-card { padding: 16px 18px; gap: 14px; } .lab-card h3 { font-size: 16px; } }
  .footer-card {
    position: relative;
    margin-top: 48px;
    padding: 22px 28px;
    background:
      radial-gradient(circle at 15% 20%, rgba(107,63,160,0.15) 0%, transparent 50%),
      radial-gradient(circle at 85% 80%, rgba(233,196,106,0.08) 0%, transparent 50%),
      var(--th-card-gradient);
    border: 1px solid var(--th-card-border);
    border-radius: 16px;
    overflow: hidden;
    box-shadow: 0 4px 20px var(--th-card-shadow);
    display: flex;
    align-items: center;
    gap: 28px;
    justify-content: flex-start;
  }
  @media (max-width: 640px) {
    .footer-card { flex-direction: column; align-items: flex-start; gap: 14px; padding: 20px; }
  }
  .fc-emblem {
    position: relative;
    width: 110px; height: 110px;
    flex-shrink: 0;
    display: block;
    text-decoration: none;
    color: inherit;
    cursor: pointer;
    order: 2;
    margin-right: 24px;
  }
  @media (max-width: 640px) { .fc-emblem { margin-right: 0; order: 0; } }
  .fc-emblem:focus-visible { outline: 2px solid var(--magic-gold); outline-offset: 6px; border-radius: 50%; }
  .fc-emblem-aura {
    position: absolute;
    top: 22px; left: 22px;
    width: 66px; height: 66px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(239,34,58,0.5) 0%, rgba(239,34,58,0.18) 40%, transparent 70%);
    animation: fc-aura-pulse 2.8s ease-in-out infinite;
  }
  .fc-emblem-bug {
    position: absolute;
    top: 32px; left: 32px;
    width: 46px; height: 46px;
    animation: fc-bug-float 3.2s ease-in-out infinite;
    filter: drop-shadow(0 0 10px rgba(239,34,58,0.65));
  }
  .fc-emblem-bug svg { width: 100%; height: 100%; }
  .fc-orbit {
    position: absolute; inset: 0;
    border-radius: 50%;
    pointer-events: none;
  }
  .fc-orbit.cw { animation: fc-orbit 10s linear infinite; }
  .fc-orbit.ccw { animation: fc-orbit-reverse 14s linear infinite; }
  .fc-orbit-star {
    position: absolute;
    color: var(--magic-gold);
    font-size: 12px;
    text-shadow: 0 0 8px rgba(233,196,106,0.9);
  }
  .fc-orbit-star.n { top: 4px; left: 50%; transform: translateX(-50%); }
  .fc-orbit-star.e { top: 50%; right: 4px; transform: translateY(-50%); }
  .fc-orbit-star.s { bottom: 4px; left: 50%; transform: translateX(-50%); }
  .fc-orbit-star.w { top: 50%; left: 4px; transform: translateY(-50%); }
  .fc-orbit-star.ne { top: 14px; right: 14px; font-size: 9px; }
  .fc-orbit-star.sw { bottom: 14px; left: 14px; font-size: 9px; }
  .fc-wand {
    position: absolute;
    top: -4px; left: -4px;
    width: 72px; height: 72px;
    transform-origin: 70% 70%;
    animation: fc-wand-sway 4s ease-in-out infinite;
    z-index: 3;
  }
  .fc-wand svg { width: 100%; height: 100%; overflow: visible; }
  .fc-wand-stick { stroke: #0A0A0A; stroke-width: 3.5; stroke-linecap: round; }
  .fc-wand-accent { stroke: #FFFFFF; stroke-width: 2; stroke-linecap: round; }
  .fc-wand-tip { fill: var(--magic-gold); animation: fc-tip-glow 2s ease-in-out infinite; }
  .fc-burst {
    position: absolute;
    top: 55px; left: 55px;
    color: var(--magic-gold);
    font-size: 14px;
    pointer-events: none;
    opacity: 0;
    z-index: 4;
    text-shadow: 0 0 8px rgba(233,196,106,1);
  }
  .fc-emblem:hover .fc-burst { animation: fc-hover-burst 1s ease-out forwards; }
  .fc-burst.b1 { --bx: -44px; --by: -40px; animation-delay: .05s; }
  .fc-burst.b2 { --bx: 42px; --by: -38px; animation-delay: .12s; }
  .fc-burst.b3 { --bx: -48px; --by: 40px; animation-delay: .2s; }
  .fc-burst.b4 { --bx: 46px; --by: 42px; animation-delay: .08s; }
  .fc-burst.b5 { --bx: 0; --by: -56px; animation-delay: .15s; }
  .fc-burst.b6 { --bx: 0; --by: 56px; animation-delay: .25s; }
  .fc-emblem:hover .fc-emblem-bug { animation: fc-bug-surprise .8s ease-in-out; }
  .fc-emblem:hover .fc-emblem-aura { animation: fc-aura-flash .8s ease-in-out; }
  .fc-emblem:hover .fc-wand { animation: fc-wand-cast .8s cubic-bezier(.3,.9,.3,1.1); }
  .fc-emblem:hover .fc-orbit.cw { animation-duration: 2.5s; }
  .fc-emblem:hover .fc-orbit.ccw { animation-duration: 3s; }
  .fc-content { flex: 1; min-width: 0; order: 1; }
  .fc-eyebrow {
    font-family: 'Twilio Sans Mono', ui-monospace, monospace;
    font-size: 11px; color: var(--magic-gold); font-weight: 700;
    text-transform: uppercase; letter-spacing: 2px;
    margin-bottom: 8px;
  }
  .fc-title {
    font-family: 'Twilio Sans Display', sans-serif;
    font-size: 20px; font-weight: 800; color: var(--th-text); margin-bottom: 4px;
    letter-spacing: 0.01em;
    background: linear-gradient(135deg, var(--th-text) 0%, var(--magic-purple) 60%, var(--magic-gold) 100%);
    -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
  }
  .fc-tag {
    font-family: 'Twilio Sans Text', sans-serif;
    font-size: 13px; color: var(--th-text-muted); margin-bottom: 12px;
  }
  .fc-links { display: flex; gap: 12px; flex-wrap: wrap; }
  .fc-link {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 10px 16px; border-radius: 10px;
    background: rgba(107,63,160,0.12);
    border: 1px solid rgba(107,63,160,0.35);
    color: var(--th-text); text-decoration: none;
    font-family: 'Twilio Sans Text', sans-serif;
    font-size: 13px; font-weight: 700;
    transition: all .2s;
  }
  .fc-link:hover { background: rgba(107,63,160,0.22); border-color: var(--magic-purple); transform: translateY(-1px); }
  .fc-slack {
    margin-top: 10px;
    font-family: 'Twilio Sans Text', sans-serif;
    font-size: 12px;
    color: var(--th-text-dim);
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .fc-slack strong { color: var(--th-text); font-weight: 700; }
</style>
</head>
<body>
${magicHatSnippet()}
<div class="wrap">

<div id="reviewNotify" style="display:none;background:linear-gradient(90deg,var(--blue-300),var(--brand-red));color:#fff;padding:12px 20px;border-radius:10px;margin-bottom:16px;font-size:14px;font-weight:700;align-items:center;justify-content:space-between;animation:rn-pulse 2s ease-in-out infinite">
  <span id="reviewNotifyText"></span>
  <a href="/dashboard/" style="color:#fff;background:rgba(0,0,0,.25);padding:6px 14px;border-radius:6px;text-decoration:none;font-size:12px;font-weight:700;white-space:nowrap">Go to Dashboard</a>
</div>
<style>
  @keyframes rn-pulse { 0%,100%{opacity:1} 50%{opacity:.85} }
</style>

<div class="hero">
  <svg style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:420px;height:420px;pointer-events:none;opacity:0.10" viewBox="0 0 420 420" fill="none">
    <path d="M60,20 Q20,20 20,60 L20,200 Q20,260 60,300 L180,360 Q220,380 280,340 L360,240 Q400,200 400,140 L400,60 Q400,20 360,20 Z" stroke="var(--brand-red)" stroke-width="3.5" fill="none"/>
  </svg>
  <div class="hero-brand">
    <svg class="brand-logo" width="36" height="36" viewBox="0 0 46 46" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M17.25 33.17C19.69 33.17 21.67 31.19 21.67 28.75C21.67 26.31 19.69 24.33 17.25 24.33C14.81 24.33 12.83 26.31 12.83 28.75C12.83 31.19 14.81 33.17 17.25 33.17ZM17.25 21.67C19.69 21.67 21.67 19.69 21.67 17.25C21.67 14.81 19.69 12.83 17.25 12.83C14.81 12.83 12.83 14.81 12.83 17.25C12.83 19.69 14.81 21.67 17.25 21.67ZM28.75 33.17C31.19 33.17 33.17 31.19 33.17 28.75C33.17 26.31 31.19 24.33 28.75 24.33C26.31 24.33 24.33 26.31 24.33 28.75C24.33 31.19 26.31 33.17 28.75 33.17ZM28.75 21.67C31.19 21.67 33.17 19.69 33.17 17.25C33.17 14.81 31.19 12.83 28.75 12.83C26.31 12.83 24.33 14.81 24.33 17.25C24.33 19.69 26.31 21.67 28.75 21.67ZM23 0C35.46 0 46 10.54 46 23C46 35.46 35.46 46 23 46C10.54 46 0 35.46 0 23C0 10.54 10.54 0 23 0ZM23 6.19C13.74 6.19 6.19 13.48 6.19 22.69C6.19 31.9 13.74 39.81 23 39.81C32.26 39.81 39.81 31.9 39.81 22.69C39.81 13.48 32.26 6.19 23 6.19Z" fill="#F3F4F7"/>
    </svg>
    <h1>Twilio + AI Photo Generator</h1>
  </div>
  <div class="subtitle">Admin Console</div>
  <div style="margin-top:16px">
    <button class="theme-toggle" onclick="toggleTheme()">
      <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"/></svg>
      <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/></svg>
      <span id="themeLabel">Light mode</span>
    </button>
  </div>
</div>

<!-- Quick Actions -->
<div class="actions">
  <div class="action-card booth">
    <a href="/home/combo" onclick="event.preventDefault();window.open('/home/combo','booth_display','popup')" style="text-decoration:none;color:inherit;display:block">
      <div class="card-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg></div>
      <h2>Launch Booth Display</h2>
      <p>Split-screen with intro video and photo book. Drag the divider to resize. Ideal for a single booth monitor.</p>
    </a>
    <button class="sub-toggle" id="subToggle" onclick="event.stopPropagation();this.classList.toggle('open');document.getElementById('subOpts').classList.toggle('open')">
      Open left pane or book separately <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
    </button>
    <div class="sub-options" id="subOpts">
      <div class="sub-links">
        ${(settings.get("boothDisplayMode") || "video") === "static"
          ? `<a href="/home/panel" target="_blank" class="sub-link">&#x1F4CB; Static Page Only</a>`
          : `<a href="/home/video" target="_blank" class="sub-link">&#x1F3AC; Intro Video Only</a>`}
        <a href="/photogallery/" target="_blank" class="sub-link">&#x1F4D6; Photo Book Only</a>
      </div>
    </div>
  </div>
  <div class="action-card dashboard">
    <a href="/dashboard/" style="text-decoration:none;color:inherit;display:block">
      <div class="card-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg></div>
      <h2>Open Dashboard</h2>
      <p>Monitor live prints, manage the queue, and generate event reports.</p>
    </a>
    <div class="sub-options open" style="max-height:none;">
      <div class="sub-links">
        <a href="/dashboard/logs/" target="_blank" class="sub-link"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px;vertical-align:-1px;margin-right:6px;"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>Logs</a>
      </div>
    </div>
  </div>
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
    <div class="step"><div class="step-num">2</div><div class="step-text"><a href="/home/combo" onclick="event.preventDefault();window.open('/home/combo','booth_display','popup')">Launch the Booth Display</a> on a monitor for attendees to see</div></div>
    <div class="step"><div class="step-num">3</div><div class="step-text">Attendees text a selfie to your Twilio number with a style name</div></div>
    <div class="step"><div class="step-num">4</div><div class="step-text">AI generates their portrait and it prints at your booth. Monitor progress in the <a href="/dashboard/" target="_blank">Dashboard</a></div></div>
    <div class="step"><div class="step-num">5</div><div class="step-text">They get an SMS with their portrait when it's ready to pick up</div></div>
    <div class="step"><div class="step-num">6</div><div class="step-text">Use <a href="/outreach/" target="_blank">Outreach</a> to send broadcasts, run raffles, download lead reports, and engage attendees</div></div>
  </div>
</div>

<!-- Settings -->
<div class="section">
  <div class="settings-toggle" id="settingsToggle" onclick="this.classList.toggle('open');document.getElementById('settingsPanel').classList.toggle('open');document.getElementById('settingsActions').style.display=this.classList.contains('open')?'flex':'none';if(this.classList.contains('open'))loadSettings()">
    <div class="settings-toggle-body">
      <div class="settings-toggle-eyebrow">Configure</div>
      <h3>Settings</h3>
      <p class="settings-toggle-sub">Event config, styles, brands, prompts, messaging, delivery, and API keys.</p>
    </div>
    <svg class="settings-toggle-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
  </div>
  <div class="settings-panel" id="settingsPanel">


    <div class="sg-group">
    <div class="sg-group-header" onclick="this.parentElement.classList.toggle('open')">Event &amp; Operations</div>
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
        <div class="sf">
          <label>Max Prints Per User <span class="tip" data-tip="How many free prints each attendee gets. Admin numbers are unlimited.">?</span></label>
          <input type="number" id="sMaxPrints" min="1" max="100">
          <div style="font-size:11px;color:var(--th-text-muted);margin-top:6px">Set to <strong>100</strong> for unlimited — disables quota enforcement and hides remaining-count messages in SMS.</div>
        </div>
      </div>
      <div class="sf"><label>Admin Phone Numbers <span class="tip" data-tip="Phone numbers in E.164 format (e.g. +14155551234). Admins get unlimited prints and are excluded from dashboard metrics.">?</span></label>
        <div class="phone-tags" id="phoneTags"></div>
        <div class="phone-add"><input type="text" id="phoneInput" placeholder="+14155551234"><button class="btn" onclick="addPhone()">Add</button></div>
      </div>
    </div>

    <div class="sg"><h4>Queue &amp; Operations <span class="tip" data-tip="Control generation throughput and pause the queue during breaks.">?</span></h4>
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
    </div>

    <div class="sg"><h4>Staff Mobile Access <span class="tip" data-tip="Let event staff manage settings and review images from their phone. Scan the QR code or visit /review.">?</span></h4>
      <div class="sf">
        <label>Staff PIN <span class="tip" data-tip="Set a 4–6 digit PIN so staff can log in at /review on their phone without needing a Google admin account.">?</span></label>
        <input type="text" id="sReviewPin" maxlength="6" placeholder="e.g. 1234" inputmode="numeric" pattern="[0-9]*" style="max-width:140px">
      </div>
      <div class="sf" id="staffQrRow">
        <label>Scan to open on phone</label>
        <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
          <img id="staffQrImg" width="160" height="160" style="border-radius:8px;background:#fff" alt="QR code">
          <div style="font-size:12px;color:var(--th-text-muted,#656E87);max-width:240px">
            Staff scan this QR code to access <strong>mobile settings</strong> and the <strong>review queue</strong> from their phone using the PIN above.
            <div id="staffQrUrl" style="margin-top:8px"><code style="background:var(--th-raised,#38425E);padding:3px 8px;border-radius:4px;font-size:11px;word-break:break-all"></code></div>
          </div>
        </div>
      </div>
    </div>

    </div></div><!-- /Event & Operations -->

    <div class="sg-group">
    <div class="sg-group-header" onclick="this.parentElement.classList.toggle('open')">Styles &amp; Art</div>
    <div class="sg-group-body">

    <div class="sg"><h4>Art Styles <span class="tip" data-tip="Configure AI art styles. Toggle individual styles on/off, customize prompts, and add custom styles.">?</span></h4>
      <div class="sf"><label>Default Style <span class="tip" data-tip="The style used when someone sends a photo without specifying one.">?</span></label><select id="sDefaultStyle"></select></div>
      <div id="stylesList"></div>
      <div style="margin-top:12px">
        <button class="btn" onclick="document.getElementById('customStyleForm').style.display=document.getElementById('customStyleForm').style.display==='none'?'block':'none'">+ Add Custom Style</button>
        <div id="customStyleForm" class="custom-style-form" style="display:none">
          <div class="sf"><label>Style Name <span class="tip" data-tip="The name attendees will type to select this style.">?</span></label><input type="text" id="csName" placeholder="e.g. oil painting"></div>
          <div class="sf"><label>Prompt <span class="tip" data-tip="The AI prompt used to transform the selfie. Be specific about the artistic style you want.">?</span></label><textarea id="csPrompt" placeholder="Transform this photo into an oil painting with visible brushstrokes..."></textarea></div>
          <button class="btn btn-primary" onclick="addCustomStyle()">Add Style</button>
        </div>
      </div>
      <div style="margin-top:8px">
        <button class="btn" onclick="showImportStylePrompts()">Import from another event</button>
        <div id="importStylePanel" style="display:none;margin-top:10px;padding:12px;background:var(--th-card-bg);border:1px solid var(--th-card-border);border-radius:8px">
          <label style="font-weight:600;font-size:13px">Source Event</label>
          <select id="importEventSelect" onchange="fetchEventStyleOverrides(this.value)" style="margin-top:4px;width:100%"><option value="">— select an event —</option></select>
          <div id="importOverridesList" style="margin-top:8px"></div>
        </div>
      </div>
      <div class="sf-row" style="margin-top:12px">
        <div class="sf">
          <label>Multi-Subject Photos <span class="tip" data-tip="How to handle photos with 2+ people. Normal: generate as usual. Caricature: add exaggerated, playful features for better multi-subject results. Reject: send a configurable message asking for a solo selfie.">?</span></label>
          <select id="sMultiSubjectMode" onchange="toggleMultiSubjectReject()">
            <option value="normal">Normal (generate as usual)</option>
            <option value="caricature">Caricature (exaggerated style for better results)</option>
            <option value="reject">Reject (ask for solo selfie)</option>
          </select>
        </div>
      </div>
      <div id="multiSubjectRejectSection" style="display:none">
        <div class="sf">
          <label>Rejection Message <span class="tip" data-tip="SMS sent when a multi-subject photo is rejected. Customize to match your event tone.">?</span></label>
          <textarea id="msgMultiSubjectReject" rows="2"></textarea>
        </div>
      </div>
    </div>

    <div class="sg"><h4>Template Frame <span class="tip" data-tip="A PNG overlay composited on top of every generated portrait. Use None for no frame.">?</span></h4>
      <div class="sf">
          <label>Template <span class="tip" data-tip="Select a PNG frame to composite on top of every portrait.">?</span></label>
          <select id="sTemplate" onchange="updateTemplatePreview()"><option value="">None</option></select>
          <div class="file-upload-row"><input type="file" id="uploadTemplate" accept=".png,.jpg,.jpeg,.gif,.svg"><button class="btn btn-sm" onclick="uploadFile('template')">Upload</button><span class="upload-status" id="uploadTemplateStatus"></span></div>
          <div class="preview-box" id="templatePreview"></div>
          <div class="sf" id="frameBorderSection" style="margin-top:8px">
            <label style="display:flex;align-items:center;gap:8px">Frame Border <span class="tip" data-tip="Adds padding between the AI portrait and the template frame. Disable to have the portrait fill edge-to-edge with no gap.">?</span>
              <label class="toggle-sw" style="margin-left:auto"><input type="checkbox" id="frameBorderToggle" checked onchange="toggleFrameBorder(this.checked)"><span class="slider"></span></label>
            </label>
            <div id="frameBorderColorRow" style="display:flex;align-items:center;gap:8px;margin-top:6px">
              <input type="color" id="sFrameBorderColor" value="#000000" style="width:36px;height:28px;padding:0;border:1px solid var(--th-card-border);border-radius:4px;background:transparent;cursor:pointer" oninput="document.getElementById('frameBorderColorLabel').textContent=this.value">
              <span style="font-size:13px;color:var(--th-text-muted)" id="frameBorderColorLabel">#000000</span>
            </div>
          </div>
        </div>
    </div>

    <div class="sg"><h4>AI Prompts <span class="tip" data-tip="Control how the AI processes photos. Changes take effect immediately for new jobs.">?</span></h4>
      <p style="font-size:12px;color:var(--th-text-muted);margin-bottom:12px">These prompts control how the AI processes photos. Edit to customize behavior without restarting the server.</p>
      <div class="sf"><label>Preserve Line <span class="tip" data-tip="Tells the AI which features to preserve from the original photo. Used in all built-in style prompts.">?</span></label><textarea id="sPromptPreserve" rows="3"></textarea><button class="reset-link visible" style="margin-top:4px" onclick="document.getElementById('sPromptPreserve').value=_promptDefaults.preserve">reset</button></div>
      <div class="sf"><label>Composition Line <span class="tip" data-tip="Controls framing and positioning instructions. Used in all built-in style prompts.">?</span></label><textarea id="sPromptComposition" rows="2"></textarea><button class="reset-link visible" style="margin-top:4px" onclick="document.getElementById('sPromptComposition').value=_promptDefaults.composition">reset</button></div>
      <div class="sf"><label>Face Detection <span class="tip" data-tip="Vision prompt to check if a photo contains a visible face. Must produce YES/NO output.">?</span></label><textarea id="sPromptFaceDetection" rows="3"></textarea><button class="reset-link visible" style="margin-top:4px" onclick="document.getElementById('sPromptFaceDetection').value=_promptDefaults.faceDetection">reset</button></div>
      <div class="sf"><label>Scene Analysis <span class="tip" data-tip="Vision prompt to detect number of subjects, pets, and positions. Output should follow the Subjects/Pets/Positions format.">?</span></label><textarea id="sPromptSceneAnalysis" rows="4"></textarea><button class="reset-link visible" style="margin-top:4px" onclick="document.getElementById('sPromptSceneAnalysis').value=_promptDefaults.sceneAnalysis">reset</button></div>
      <div class="sf"><label>Smart Reply System Prompt <span class="tip" data-tip="System prompt for conversational AI replies. Variables: {eventName}, {styleChoices}, {remainingLine}">?</span></label><textarea id="sPromptSmartReply" rows="5"></textarea><button class="reset-link visible" style="margin-top:4px" onclick="document.getElementById('sPromptSmartReply').value=_promptDefaults.smartReply">reset</button></div>
      <div class="sf"><label>User Directive <span class="tip" data-tip="Short directive sent in the user message alongside the images. The developer message contains all the style/brand rules; this is just the action command.">?</span></label><textarea id="sPromptUserDirective" rows="1"></textarea><button class="reset-link visible" style="margin-top:4px" onclick="document.getElementById('sPromptUserDirective').value=_promptDefaults.userDirective">reset</button></div>
    </div>

    </div></div><!-- /Styles & Art -->

    <div class="sg-group">
    <div class="sg-group-header" onclick="this.parentElement.classList.toggle('open')">Branding</div>
    <div class="sg-group-body">

    <div class="sg"><h4>Branding <span class="tip" data-tip="Configure branding for generated portraits. Use a single brand for all portraits, or let users choose from multiple brands via SMS.">?</span></h4>
      <input type="hidden" id="sEnableBrandMenu" value="false">
      <div class="sf">
        <label style="display:flex;align-items:center;gap:10px">
          Let Users Choose Brand
          <span class="tip" data-tip="OFF: one brand applied to all portraits (set prompt and reference files below). ON: users pick from multiple brands via SMS after choosing their art style.">?</span>
          <label class="toggle-sw">
            <input type="checkbox" id="brandMenuToggle" onchange="toggleBrandMenu(this.checked)">
            <span class="slider"></span>
          </label>
        </label>
      </div>

      <div id="singleBrandSection">
        <div class="sf"><label>Brand Prompt <span class="tip" data-tip="Applied to all styles. Use for clothing, logos, or visual themes that should appear in every portrait. Leave blank to disable.">?</span></label><textarea id="sBrandPrompt" rows="3" placeholder="e.g. The subject should be wearing a bright red Twilio t-shirt with the Twilio logo clearly visible"></textarea></div>
        <div class="sf">
          <label>Reference Files <span class="tip" data-tip="Upload images (PNG, JPG, GIF) as visual references for the AI — logos, color palettes, outfit designs, brand guidelines. These are sent alongside every portrait.">?</span></label>
          <div class="brand-ref-tags" id="brandRefList"></div>
          <div class="file-upload-row"><input type="file" id="uploadBrandRef" accept=".png,.jpg,.jpeg,.gif" multiple><button class="btn btn-sm" onclick="uploadBrandRefs()">Upload</button><span class="upload-status" id="uploadBrandRefStatus"></span></div>
        </div>
      </div>

      <div id="brandChoicesSection" style="display:none">
        <div class="sf" style="margin-bottom:4px">
          <label>Reference File Library <span class="tip" data-tip="Upload brand reference images here. Then assign them to individual brands below.">?</span></label>
          <div class="brand-ref-tags" id="brandRefLibrary"></div>
          <div class="file-upload-row"><input type="file" id="uploadBrandRefMulti" accept=".png,.jpg,.jpeg,.gif" multiple><button class="btn btn-sm" onclick="uploadBrandRefsMulti()">Upload</button><span class="upload-status" id="uploadBrandRefMultiStatus"></span></div>
        </div>
        <div id="brandsList"></div>
        <div style="margin-top:8px">
          <button class="btn btn-sm" onclick="document.getElementById('addBrandForm').style.display=document.getElementById('addBrandForm').style.display==='none'?'block':'none'">+ Add Brand</button>
          <div id="addBrandForm" style="display:none;margin-top:8px">
            <div class="sf"><label>Brand Name</label><input type="text" id="brandNewName" placeholder="e.g. LA Kings"></div>
            <div class="sf"><label>Brand Prompt</label><textarea id="brandNewPrompt" rows="2" placeholder="Dress the subject in LA Kings hockey gear with the crown logo visible..."></textarea></div>
            <div class="sf"><label>Reference Files</label><div class="brand-ref-tags" id="brandNewFiles"></div></div>
            <button class="btn btn-primary btn-sm" onclick="addBrand()">Add Brand</button>
          </div>
        </div>
      </div>
    </div>

    <div class="sg"><h4>Brand AI Prompts <span class="tip" data-tip="Prompts used specifically when brand reference images are active.">?</span></h4>
      <div class="sf"><label>Preserve Line (Brand Mode) <span class="tip" data-tip="Used instead of the full preserve line when brand references are active. Omits clothing since brands override it.">?</span></label><textarea id="sPromptPreserveBrand" rows="2"></textarea><button class="reset-link visible" style="margin-top:4px" onclick="document.getElementById('sPromptPreserveBrand').value=_promptDefaults.preserveBrand">reset</button></div>
      <div class="sf"><label>Brand Instruction <span class="tip" data-tip="Tells the AI to apply brand reference images to subjects and reproduce them exactly. Used when brand reference files are uploaded.">?</span></label><textarea id="sPromptBrandInstruction" rows="3"></textarea><button class="reset-link visible" style="margin-top:4px" onclick="document.getElementById('sPromptBrandInstruction').value=_promptDefaults.brandInstruction">reset</button></div>
    </div>

    </div></div><!-- /Branding -->

    <div class="sg-group">
    <div class="sg-group-header" onclick="this.parentElement.classList.toggle('open')">Backgrounds</div>
    <div class="sg-group-body">

    <div class="sg"><h4>Backgrounds <span class="tip" data-tip="Control the background of generated portraits. The default prompt is used when background selection is off. When enabled, users pick their background via SMS.">?</span></h4>
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
            <div class="sf"><label>Prompt <span style="font-weight:400;color:var(--th-text-muted)">(optional — use ref images instead)</span></label><textarea id="bgNewPrompt" rows="2" placeholder="Background: A dramatic city skyline at sunset..."></textarea></div>
            <button class="btn btn-primary btn-sm" onclick="addBackgroundChoice()">Add</button>
          </div>
        </div>
      </div>
    </div>

    </div></div><!-- /Backgrounds -->

    <div class="sg-group">
    <div class="sg-group-header" onclick="this.parentElement.classList.toggle('open')">Delivery &amp; Display</div>
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
      <div id="printSettingsImmediateDelivery" class="sf" style="margin-top:8px">
        <label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="sImmediateDigitalDelivery" checked> Send digital copy immediately <span class="tip" data-tip="Send the portrait via SMS right after generation — don't wait for the print to finish. Ensures users always get their digital image even if the printer is having issues.">?</span></label>
      </div>
      <div id="printerSection">
        <div class="sf">
          <label>Active Printers <span class="tip" data-tip="Check the printers you want to use. Multiple printers print concurrently for faster throughput. Click Refresh if you just connected a new printer.">?</span></label>
          <div id="printerChecklist" style="margin-bottom:8px"><div style="display:flex;align-items:center;gap:8px;padding:8px 0"><svg width="16" height="16" viewBox="0 0 24 24" style="animation:spin 1s linear infinite;color:var(--th-text-muted)"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" stroke-dasharray="30 70" stroke-linecap="round"/></svg><span style="color:var(--th-text-muted);font-size:13px">Detecting printers...</span></div></div>
          <div style="display:flex;align-items:center;gap:12px">
            <button class="btn btn-sm" onclick="refreshPrinters()">Refresh</button>
            <span id="printerCount" style="font-size:13px;color:var(--th-text-muted)"></span>
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

    <div class="sg"><h4>Image Review <span class="tip" data-tip="Control how AI-generated portraits are reviewed before delivery. Off: deliver immediately. Human: hold for manual admin review. AI: automated quality check that rejects bad images and notifies the user to try again.">?</span></h4>
      <input type="hidden" id="sReviewMode" value="off">
      <div class="sf">
        <label>Review Mode</label>
        <select id="reviewModeSelect" onchange="setReviewMode(this.value)">
          <option value="off">Off</option>
          <option value="human">Human</option>
          <option value="ai">AI</option>
        </select>
      </div>
      <div id="multiVariantSection" style="display:none">
        <div class="sf">
          <label>Variants per Photo <span class="tip" data-tip="Generate N variants per user photo. Human review: reviewer sees all N and picks the best. AI review: the AI picks the best automatically. Default 1 = single-variant (legacy behavior).">?</span></label>
          <select id="sVariantsPerReview">
            <option value="1">1 (standard)</option>
            <option value="2">2</option>
            <option value="3">3 (pick best of 3)</option>
          </select>
        </div>
        <div class="sf">
          <label>Per-Variant Regeneration Limit <span class="tip" data-tip="Maximum times a reviewer can regenerate a single variant before the button locks (safety cap against runaway API usage).">?</span></label>
          <select id="sRegenerationLimit">
            <option value="1">1</option>
            <option value="2">2 (default)</option>
            <option value="3">3</option>
            <option value="4">4</option>
            <option value="5">5</option>
          </select>
        </div>
      </div>
      <div id="aiReviewSection" style="display:none">
        <div class="sf">
          <label>AI Review Checks <span class="tip" data-tip="Toggle which quality checks the AI performs. Disable checks you don't care about to reduce false positives. Images that fail any enabled check are auto-rejected and the user is notified to try again.">?</span></label>
          <div style="display:flex;flex-direction:column;gap:8px;margin-top:6px">
            <label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="aiCheckLikeness" checked> Subject likeness</label>
            <label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="aiCheckSubjectCount" checked> Subject count</label>
            <label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="aiCheckGender" checked> Gender accuracy</label>
            <label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="aiCheckBranding" checked> Branding &amp; logos</label>
            <label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="aiCheckAccessories" checked> Accessories preserved</label>
            <label style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="aiCheckAnatomy" checked> Anatomical quality</label>
          </div>
        </div>
      </div>
    </div>

    <div class="sg"><h4>Booth Display <span class="tip" data-tip="Configure what attendees see on the booth monitor. Choose a looping video, a static instruction page with QR code, or nothing (photo book only).">?</span></h4>
      <div class="sf">
        <label>Display Mode <span class="tip" data-tip="What shows on the left side of the split-screen booth display. Video: looping intro video. Static Page: instruction panel with QR code and steps. None: photo book only, no split.">?</span></label>
        <select id="sBoothMode" onchange="toggleBoothMode(this.value)">
          <option value="video">Video</option>
          <option value="static">Static Page</option>
          <option value="none">None (photo book only)</option>
        </select>
      </div>
      <div id="boothVideoSection">
        <div class="sf">
          <label>Intro Video <span class="tip" data-tip="Looping video shown on the booth display to attract attendees.">?</span></label>
          <select id="sVideo" onchange="updateVideoPreview()"><option value="">Loading...</option></select>
          <div class="file-upload-row"><input type="file" id="uploadVideo" accept=".mp4,.webm,.mov"><button class="btn btn-sm" onclick="uploadFile('video')">Upload</button><span class="upload-status" id="uploadVideoStatus"></span></div>
          <div class="preview-box" id="videoPreview"></div>
        </div>
      </div>
      <div id="boothStaticSection" style="display:none">
        <div class="sf"><label>Headline <span class="tip" data-tip="Large title text at the top of the instruction page.">?</span></label><input type="text" id="sBoothHeadline" placeholder="Get Your AI Portrait"></div>
        <div class="sf"><label>Subline <span class="tip" data-tip="Smaller text below the headline, e.g. event name.">?</span></label><input type="text" id="sBoothSubline" placeholder="e.g. SIGNAL 2025"></div>
        <div class="sf">
          <label>QR Code Image <span class="tip" data-tip="Upload a QR code image that attendees scan to start the experience.">?</span></label>
          <div class="file-upload-row"><input type="file" id="uploadBoothQr" accept=".png,.jpg,.jpeg,.svg,.webp"><button class="btn btn-sm" onclick="uploadBoothQr()">Upload</button><span class="upload-status" id="uploadBoothQrStatus"></span></div>
          <div class="preview-box" id="boothQrPreview"></div>
        </div>
        <div class="sf">
          <label>Steps <span class="tip" data-tip="Instruction steps shown below the QR code. Add or remove as needed.">?</span></label>
          <div id="boothStepsContainer"></div>
          <div style="margin-top:8px"><button type="button" class="btn btn-sm" onclick="addBoothStep()">+ Add Step</button></div>
        </div>
        <div class="sf"><label>Legal Text <span class="tip" data-tip="Small compliance/legal text shown at the bottom of the instruction page. Leave blank to hide.">?</span></label><textarea id="sBoothLegalText" rows="2" placeholder="By participating, you consent to..."></textarea></div>
        <div class="sf">
          <label>Show SMS Fallback <span class="tip" data-tip="Display the phone number and a message below the QR code so attendees who can't scan can text manually instead. Uses the Twilio phone number from your settings.">?</span></label>
          <select id="sBoothShowSms" onchange="toggleSmsFallbackPreview(this.value)">
            <option value="true">On</option>
            <option value="false">Off</option>
          </select>
        </div>
        <div id="boothSmsFallbackSection">
          <div class="sf"><label>Display Phone Number <span class="tip" data-tip="The phone number shown on the panel for attendees to text. Defaults to your Twilio number if left blank.">?</span></label><input type="text" id="sBoothSmsPhone" placeholder="e.g. (206) 555-1234 or +14155551234"></div>
          <div class="sf"><label>SMS Instruction Text <span class="tip" data-tip="The message attendees should text to start. Shown as: Text (206) 555-1234 with the message &quot;[this text]&quot;">?</span></label><input type="text" id="sBoothSmsText" placeholder="Hit send to start"></div>
        </div>
      </div>
      <div class="sf"><label>Terms URL <span class="tip" data-tip="Displayed on booth screens (video, combo, photo gallery). Leave blank to hide.">?</span></label><input type="url" id="sTermsUrl" placeholder="https://example.com/terms"></div>
    </div>

    <div class="sg"><h4>Photo Book &amp; Gallery <span class="tip" data-tip="Configure the photo book slideshow, reveal animations, and BRB screen.">?</span></h4>
      <div class="sf-row">
        <div class="sf">
          <label>Slideshow Autoplay <span class="tip" data-tip="Automatically advance pages in the photo book and cycle images in the gallery.">?</span></label>
          <select id="sPhotoBookAutoplay">
            <option value="true">On</option>
            <option value="false">Off</option>
          </select>
        </div>
        <div class="sf">
          <label>Slideshow Interval <span class="tip" data-tip="Seconds between automatic page turns / image transitions (3–120).">?</span></label>
          <input type="number" id="sPhotoBookInterval" min="3" max="120" value="10">
        </div>
      </div>
      <div class="sf">
        <label>Reveal Animation <span class="tip" data-tip="Effect when a new portrait appears for the first time. Applies to both the photo book and the fullscreen gallery.">?</span></label>
        <select id="sRevealAnimation">
          <option value="off">Off</option>
          <option value="pixel">Pixel (blur-in)</option>
          <option value="brush">Brush (wipe)</option>
          <option value="sketch-to-color">Sketch to Color</option>
        </select>
      </div>
      <div class="sf-row">
        <div class="sf">
          <label>Milestone Celebrations <span class="tip" data-tip="Show confetti and a banner when the portrait count hits milestones (e.g. 100th Portrait!).">?</span></label>
          <select id="sMilestonesEnabled">
            <option value="true">On</option>
            <option value="false">Off</option>
          </select>
        </div>
        <div class="sf">
          <label>Milestone Every <span class="tip" data-tip="Celebrate every N portraits (e.g. 50 = celebrate at 50, 100, 150...). Range: 10–1000.">?</span></label>
          <input type="number" id="sMilestoneInterval" min="10" max="1000" value="100">
        </div>
      </div>
      <div class="sf"><label>BRB Screen Message <span class="tip" data-tip="Message shown when the BRB overlay is activated on the booth display. Leave blank for default.">?</span></label><input type="text" id="sBreakMessage" placeholder="e.g. Back in 10 minutes!"></div>
    </div>

    </div></div><!-- /Delivery & Display -->

    <div class="sg-group">
    <div class="sg-group-header" onclick="this.parentElement.classList.toggle('open')">Engagement &amp; Messages</div>
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
        <div style="margin-top:18px;padding-top:16px;border-top:1px solid var(--th-card-border)">
          <div class="sf-sub-label">Survey Messages</div>
          <div class="sf"><label>Intro (Before Mode) <span class="tip" data-tip="Sent before the first question in 'before' mode.">?</span></label><textarea id="msgLeadIntroBefore" rows="2"></textarea></div>
          <div class="sf"><label>Intro (After Mode) <span class="tip" data-tip="Sent before the first question in 'after' mode.">?</span></label><textarea id="msgLeadIntroAfter" rows="2"></textarea></div>
          <div class="sf"><label>Survey Complete <span class="tip" data-tip="Sent when done. Placeholder: {firstName}">?</span></label><textarea id="msgLeadComplete" rows="2"></textarea></div>
          <div class="sf"><label>Complete + Send Selfie <span class="tip" data-tip="Sent when done but no photo yet. Placeholder: {firstName}">?</span></label><textarea id="msgLeadCompleteWithCta" rows="2"></textarea></div>
        </div>
        <div style="margin-top:18px;padding-top:16px;border-top:1px solid var(--th-card-border)">
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

    <div class="sg"><h4>Social Sharing <span class="tip" data-tip="Adds a short link to the delivery SMS that opens a branded share page with platform-specific share buttons.">?</span></h4>
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
        <div class="sf"><label style="display:flex;align-items:center;gap:10px">Share Page Only (no MMS image) <span class="tip" data-tip="Send a text-only SMS with the share link instead of an MMS with the image attached. Users view and download their portrait from the share page. Saves MMS costs.">?</span> <label class="toggle-sw"><input type="checkbox" id="sharePageOnlyToggle" onchange="document.getElementById('sSharePageOnly').value=this.checked?'true':'false'"><span class="slider"></span></label></label></div>
        <input type="hidden" id="sSharePageOnly" value="false">
        <div class="sf"><label>dub.co API Key <span class="tip" data-tip="API key for dub.co URL shortening. Leave blank to use full share page URL instead.">?</span></label><input type="password" id="sDubApiKey" placeholder="dub_xxxxxxxx" autocomplete="off"></div>
        <div class="sf"><label>Short Domain <span class="tip" data-tip="Custom short domain on dub.co (e.g. twil.io). Falls back to dub.sh if not set.">?</span></label><input type="text" id="sDubDomain" placeholder="twil.io"></div>
        <div class="sf"><label>Slug Prefix <span class="tip" data-tip="Prefix for short link slugs. With prefix 'signal', links look like twil.io/signal-1, twil.io/signal-2, etc. Letters, numbers, and hyphens only.">?</span></label><input type="text" id="sDubSlugPrefix" placeholder="p" oninput="validateSlugPrefix()"><div id="slugPrefixStatus" style="margin-top:4px;font-size:12px"></div></div>
        <div class="sf"><label>Folder ID <span class="tip" data-tip="dub.co folder ID to organize short links. Create a folder in dub.co dashboard and paste its ID here.">?</span></label><input type="text" id="sDubFolderId" placeholder=""></div>
        <hr style="border:none;border-top:1px solid var(--th-card-border,#38425E);margin:12px 0">
        <div class="sf"><label style="display:flex;align-items:center;gap:10px">X / Twitter <label class="toggle-sw"><input type="checkbox" id="twitterShareToggle" checked onchange="toggleTwitterShare(this.checked)"><span class="slider"></span></label></label></div>
        <div id="twitterSection" style="display:none">
          <div class="sf"><label>Handle <span class="tip" data-tip="X/Twitter handle, e.g. @twilio">?</span></label><input type="text" id="sTwitterHandle" placeholder="@twilio"></div>
          <div class="sf"><label>Share Text <span class="tip" data-tip="Pre-filled tweet text. Use {eventName} as a placeholder.">?</span></label><input type="text" id="sTwitterShareText" placeholder="Check out my AI portrait from {eventName}! Made with @twilio on X"></div>
        </div>
        <div class="sf" style="margin-top:12px"><label style="display:flex;align-items:center;gap:10px">LinkedIn <label class="toggle-sw"><input type="checkbox" id="linkedInShareToggle" checked onchange="toggleLinkedInShare(this.checked)"><span class="slider"></span></label></label></div>
        <div id="linkedInSection" style="display:none">
          <div class="sf"><label>Share Text <span class="tip" data-tip="Text shown in the LinkedIn post preview (via og:description). Use {eventName} as a placeholder. LinkedIn caches this per URL for ~7 days — changes affect future portraits, not links already shared.">?</span></label><input type="text" id="sLinkedInText" placeholder="Check out my AI portrait from {eventName}, powered by Twilio!"></div>
          <div class="sf"><label>Company URL <span class="tip" data-tip="LinkedIn company page URL. Appended to the share text so it surfaces as a clickable link in the LinkedIn unfurl. LinkedIn does not support @mentions via share links.">?</span></label><input type="text" id="sLinkedInCompanyUrl" placeholder="https://www.linkedin.com/company/twilio-inc-"></div>
        </div>
        <div class="sf" style="margin-top:12px"><label style="display:flex;align-items:center;gap:10px">Instagram <label class="toggle-sw"><input type="checkbox" id="instagramShareToggle" checked onchange="toggleInstagramShare(this.checked)"><span class="slider"></span></label></label></div>
        <div id="instagramSection" style="display:none">
          <div class="sf"><label>Handle <span class="tip" data-tip="Instagram handle, e.g. @twilio">?</span></label><input type="text" id="sInstagramHandle" placeholder="@twilio"></div>
        </div>
        <hr style="border:none;border-top:1px solid var(--th-card-border,#38425E);margin:12px 0">
        <div class="sf"><label>SMS Share Text <span class="tip" data-tip="Text sent in the SMS with the share link. Use {url} as placeholder for the link.">?</span></label><input type="text" id="sShareMessageText" placeholder="Share your portrait: {url}"></div>
        <div class="sf"><label>Share Page Title <span class="tip" data-tip="Default page heading and og:title when the user's name is not available.">?</span></label><input type="text" id="sSharePageTitle" placeholder="My AI Portrait"></div>
        <div class="sf"><label>Share Page Title (Personalized) <span class="tip" data-tip="Used when lead capture has the user's name. Use {firstName} as a placeholder.">?</span></label><input type="text" id="sSharePageTitlePersonalized" placeholder="{firstName}'s AI Portrait"></div>
        <div class="sf"><label>Share Page Description <span class="tip" data-tip="og:description for the share page (used in social media previews).">?</span></label><input type="text" id="sSharePageDesc" placeholder="Check out my AI portrait, powered by Twilio!"></div>
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
        <div style="margin-top:18px;padding-top:16px;border-top:1px solid var(--th-card-border)">
          <div class="sf-sub-label">NPS Messages</div>
          <div class="sf"><label>Rating Prompt <span class="tip" data-tip="Sent to request a rating after the user's last portrait.">?</span></label><textarea id="msgNpsPrompt" rows="2"></textarea></div>
          <div class="sf"><label>Thanks Reply <span class="tip" data-tip="Sent after the user replies with their rating.">?</span></label><textarea id="msgNpsThanks" rows="2"></textarea></div>
        </div>
      </div>
    </div>

    <div class="sg"><h4>Still-Working Follow-up <span class="tip" data-tip="If enabled, users get a reassurance SMS 30-60 seconds after the pickup message, in case generation is running slow. Automatically cancelled if the real delivery arrives first.">?</span></h4>
      <input type="hidden" id="sStillWorkingEnabled" value="true">
      <div class="sf">
        <label style="display:flex;align-items:center;gap:10px">
          Send still-working follow-up
          <label class="toggle-sw">
            <input type="checkbox" id="stillWorkingToggle" onchange="toggleStillWorking(this.checked)" checked>
            <span class="slider"></span>
          </label>
        </label>
      </div>
      <div id="stillWorkingSection">
        <div class="sf"><label>Delay (seconds) <span class="tip" data-tip="Seconds to wait after the pickup SMS before sending the reassurance ping. Range: 15-600.">?</span></label><input type="number" id="sStillWorkingDelay" min="15" max="600" value="60" style="width:100px"></div>
        <div class="sf"><label>Message Text <span class="tip" data-tip="What the reassurance SMS says.">?</span></label><textarea id="msgStillWorking" rows="2" placeholder="Still working on your portrait — hang tight!"></textarea></div>
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

      <div id="brandMessagesSection" style="display:none">
      <div class="sf-sub-label" style="margin-top:20px">Brand Selection</div>
      <div class="sf"><label>Menu Intro <span class="tip" data-tip="Header before the numbered brand list.">?</span></label><textarea id="msgBrandMenuIntro" rows="2"></textarea></div>
      <div class="sf-row">
        <div class="sf"><label>Menu Footer <span class="tip" data-tip="Instruction after the brand list.">?</span></label><textarea id="msgBrandMenuFooter" rows="2"></textarea></div>
        <div class="sf"><label>Invalid Choice <span class="tip" data-tip="Sent when brand choice doesn't match.">?</span></label><textarea id="msgBrandMenuRetry" rows="2"></textarea></div>
      </div>
      <div id="brandMessagesPreview" style="margin-top:8px"></div>
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

      <div class="sf-sub-label" style="margin-top:20px">Image Review</div>
      <div class="sf-row">
        <div class="sf"><label>Review Reject + Notify <span class="tip" data-tip="Sent to user when admin clicks Reject + Notify in the review queue, or when AI review flags an image.">?</span></label><textarea id="msgReviewReject" rows="2"></textarea></div>
        <div class="sf"><label>Review Failed <span class="tip" data-tip="Sent after max rejections or when AI review rejects an image. Tells user to try a different photo.">?</span></label><textarea id="msgReviewFailed" rows="2"></textarea></div>
      </div>

      <div class="sf-sub-label" style="margin-top:20px">Outreach</div>
      <div class="sf-row">
        <div class="sf"><label>Nudge Drop-off <span class="tip" data-tip="Sent to users who texted in but never completed a portrait. Supports {eventName}.">?</span></label><textarea id="msgNudgeDropoff" rows="2"></textarea></div>
      </div>
    </div>

    </div></div><!-- /Engagement & Messages -->

    <div class="sg-group">
    <div class="sg-group-header" onclick="this.parentElement.classList.toggle('open')">API Keys</div>
    <div class="sg-group-body">

    <div class="sg"><h4>Twilio <span class="tip" data-tip="Twilio API credentials used for sending and receiving SMS/MMS. These override values from your .env file.">?</span></h4>
      <div class="sf"><label>Phone Number <span class="tip" data-tip="Your Twilio phone number in E.164 format. This is the number attendees text their selfies to. Used as the From address when no Messaging Service is set.">?</span></label><input type="text" id="sTwilioPhone" placeholder="+14155551234"></div>
      <div class="sf"><label>Messaging Service SID <span class="tip" data-tip="Optional. When set, outbound messages route through this Messaging Service instead of using the Phone Number directly. Twilio picks the optimal sender from the service's pool (e.g. 10DLC for US, toll-free for international). Starts with MG. Leave blank to use the Phone Number directly.">?</span></label><input type="text" id="sTwilioMssid" placeholder="MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"></div>
      <div class="sf-row">
        <div class="sf"><label>Account SID <span class="tip" data-tip="Found on your Twilio Console dashboard. Starts with AC.">?</span></label><input type="text" id="sTwilioSid" placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"></div>
        <div class="sf"><label>Auth Token <span class="tip" data-tip="Found on your Twilio Console dashboard. Keep this secret.">?</span></label><input type="password" id="sTwilioToken" placeholder="Your auth token"></div>
      </div>
    </div>

    <div class="sg"><h4>OpenAI <span class="tip" data-tip="OpenAI API key and model configuration. These override values from your .env file.">?</span></h4>
      <div class="sf"><label>API Key <span class="tip" data-tip="Your OpenAI API key. Found at platform.openai.com/api-keys.">?</span></label><input type="password" id="sOpenaiKey" placeholder="sk-..."></div>
      <div class="sf-row">
        <div class="sf"><label>Orchestrator Model <span class="tip" data-tip="Main model for understanding photos and coordinating image generation.">?</span></label><select id="sModelOrch"><option value="gpt-5.5">gpt-5.5</option><option value="gpt-5.4">gpt-5.4</option><option value="gpt-5.4-mini">gpt-5.4-mini</option><option value="gpt-5.4-nano">gpt-5.4-nano</option></select></div>
        <div class="sf"><label>Vision Light Model <span class="tip" data-tip="Lightweight model for person detection and scene analysis.">?</span></label><select id="sModelVision"><option value="gpt-5.5">gpt-5.5</option><option value="gpt-5.4">gpt-5.4</option><option value="gpt-5.4-mini">gpt-5.4-mini</option><option value="gpt-5.4-nano">gpt-5.4-nano</option></select></div>
      </div>
      <div class="sf-row">
        <div class="sf"><label>Image Generation Model <span class="tip" data-tip="Model used to generate the transformed portrait.">?</span></label><select id="sModelImage"><option value="gpt-image-2-2026-04-21">gpt-image-2 (2026-04-21)</option><option value="gpt-image-1.5">gpt-image-1.5</option></select></div>
        <div class="sf"><label>Smart Reply Model <span class="tip" data-tip="Model for generating conversational SMS replies to attendees.">?</span></label><select id="sModelReply"><option value="gpt-5.5">gpt-5.5</option><option value="gpt-5.4">gpt-5.4</option><option value="gpt-5.4-mini">gpt-5.4-mini</option><option value="gpt-5.4-nano">gpt-5.4-nano</option></select></div>
        <div class="sf"><label>Ref Analysis Model <span class="tip" data-tip="Vision model used to analyze style, brand, and background reference images. Runs once per reference set and caches the result.">?</span></label><select id="sModelRefAnalysis"><option value="gpt-5.5">gpt-5.5</option><option value="gpt-5.4">gpt-5.4</option><option value="gpt-5.4-mini">gpt-5.4-mini</option><option value="gpt-5.4-nano">gpt-5.4-nano</option></select></div>
      </div>
    </div>

    </div></div><!-- /API Keys -->

  </div>
  <div class="settings-actions" id="settingsActions">
    <button class="btn btn-primary" onclick="saveSettings()">Save</button>
    <button class="btn btn-danger" onclick="resetSettings()">Reset to Defaults</button>
  </div>
</div>

<a href="/eval" class="lab-card">
  <div class="lab-card-body">
    <div class="lab-card-eyebrow">Prompt Lab</div>
    <h3>Experiment with prompts</h3>
    <p>Queue image-generation runs across styles, brands, and variants. Compare results side-by-side and mark winners.</p>
  </div>
  <div class="lab-card-arrow" aria-hidden="true">&rarr;</div>
</a>

<div class="footer-card">
  <div class="fc-content">
    <div class="fc-eyebrow">&#10022;&nbsp;&nbsp;Built by&nbsp;&nbsp;&#10022;</div>
    <div class="fc-title">The Twilio Magician</div>
    <div class="fc-tag">Anthony, Developer Evangelist (and Twilio Magician) &mdash; made this.</div>
    <div class="fc-links">
      <a class="fc-link" href="https://twil.io/magic" target="_blank" rel="noopener">
        <span>&#10022;</span> Learn more
      </a>
    </div>
    <div class="fc-slack">
      <span>&#128172;</span> Find me on Slack &mdash; <strong>Anthony Dellavecchia</strong>
    </div>
  </div>
  <a class="fc-emblem" href="https://twil.io/magic" target="_blank" rel="noopener" aria-label="Learn more at twil.io/magic">
    <div class="fc-emblem-aura"></div>
    <div class="fc-orbit cw">
      <span class="fc-orbit-star n">&#10022;</span>
      <span class="fc-orbit-star s">&#10023;</span>
      <span class="fc-orbit-star ne">&#10022;</span>
    </div>
    <div class="fc-orbit ccw">
      <span class="fc-orbit-star e">&#10023;</span>
      <span class="fc-orbit-star w">&#10022;</span>
      <span class="fc-orbit-star sw">&#10023;</span>
    </div>
    <div class="fc-emblem-bug">
      <svg viewBox="0 0 46 46" fill="none">
        <path d="M17.25 33.17C19.69 33.17 21.67 31.19 21.67 28.75C21.67 26.31 19.69 24.33 17.25 24.33C14.81 24.33 12.83 26.31 12.83 28.75C12.83 31.19 14.81 33.17 17.25 33.17ZM17.25 21.67C19.69 21.67 21.67 19.69 21.67 17.25C21.67 14.81 19.69 12.83 17.25 12.83C14.81 12.83 12.83 14.81 12.83 17.25C12.83 19.69 14.81 21.67 17.25 21.67ZM28.75 33.17C31.19 33.17 33.17 31.19 33.17 28.75C33.17 26.31 31.19 24.33 28.75 24.33C26.31 24.33 24.33 26.31 24.33 28.75C24.33 31.19 26.31 33.17 28.75 33.17ZM28.75 21.67C31.19 21.67 33.17 19.69 33.17 17.25C33.17 14.81 31.19 12.83 28.75 12.83C26.31 12.83 24.33 14.81 24.33 17.25C24.33 19.69 26.31 21.67 28.75 21.67ZM23 0C35.46 0 46 10.54 46 23C46 35.46 35.46 46 23 46C10.54 46 0 35.46 0 23C0 10.54 10.54 0 23 0ZM23 6.19C13.74 6.19 6.19 13.48 6.19 22.69C6.19 31.9 13.74 39.81 23 39.81C32.26 39.81 39.81 31.9 39.81 22.69C39.81 13.48 32.26 6.19 23 6.19Z" fill="#EF223A"/>
      </svg>
    </div>
    <div class="fc-wand">
      <svg viewBox="0 0 90 90" fill="none">
        <line class="fc-wand-stick" x1="8" y1="82" x2="58" y2="32"/>
        <line class="fc-wand-accent" x1="10" y1="80" x2="18" y2="72"/>
        <line class="fc-wand-accent" x1="48" y1="42" x2="56" y2="34"/>
        <g class="fc-wand-tip" transform="translate(60 30)">
          <path d="M0 -7 L2 -2 L7 -1 L3 2 L4 7 L0 4 L-4 7 L-3 2 L-7 -1 L-2 -2 Z"/>
        </g>
      </svg>
    </div>
    <span class="fc-burst b1">&#10022;</span>
    <span class="fc-burst b2">&#10023;</span>
    <span class="fc-burst b3">&#10022;</span>
    <span class="fc-burst b4">&#10023;</span>
    <span class="fc-burst b5">&#10022;</span>
    <span class="fc-burst b6">&#10023;</span>
  </a>
</div>
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
var _allStyleRefFiles = [];
var _allBgRefFiles = [];
var _knownEvents = [];
var _eventProfiles = [];
var _messages = {};
var _leadCaptureFields = {};
var _backgroundChoices = [];
var _customBrands = {};
var _disabledBrands = [];
var _brandPromptOverrides = {};
var _enableBrandMenu = false;
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
    _allStyleRefFiles = (_files.styleReferences || []);
    _allBgRefFiles = (_files.backgroundReferences || []);
    _customBrands = Object.assign({}, _settings.customBrands || {});
    _disabledBrands = (_settings.disabledBrands || []).slice();
    _brandPromptOverrides = Object.assign({}, _settings.brandPromptOverrides || {});
    _messages = Object.assign({}, _settings.messages || {});
    _leadCaptureFields = Object.assign({}, _settings.leadCaptureFields || {});
    _eventProfiles = (_files.eventProfiles || []).slice();
    populateSettings();
  } catch(e) { console.error("Failed to load settings", e); }
}

function toggleFrameBorder(enabled) {
  document.getElementById("frameBorderColorRow").style.display = enabled ? "flex" : "none";
}

function setReviewMode(mode) {
  document.getElementById("sReviewMode").value = mode;
  document.getElementById("aiReviewSection").style.display = mode === "ai" ? "" : "none";
  var mv = document.getElementById("multiVariantSection");
  if (mv) mv.style.display = (mode === "human" || mode === "ai") ? "" : "none";
}

// ── Staff QR code ─────────────────────────────────────────────────────────
function renderStaffQr() {
  var url = window.location.origin + "/review";
  document.querySelector("#staffQrUrl code").textContent = url;
  var img = document.getElementById("staffQrImg");
  img.src = "/dashboard/api/staff-qr?url=" + encodeURIComponent(url);
}

function setDeliveryMode(printing) {
  document.getElementById("sEnablePrinting").value = printing ? "true" : "false";
  var btnPrint = document.querySelector(".ds-print");
  var btnDigital = document.querySelector(".ds-digital");
  var status = document.getElementById("deliveryStatus");
  var printSection = document.getElementById("printSettingsSection");
  var printerSection = document.getElementById("printerSection");
  var immediateSection = document.getElementById("printSettingsImmediateDelivery");
  if (printing) {
    btnPrint.classList.add("active"); btnDigital.classList.remove("active");
    status.className = "delivery-status mode-both";
    status.textContent = "Portraits are printed and sent via MMS";
    if (printSection) printSection.style.display = "";
    if (printerSection) printerSection.style.display = "";
    if (immediateSection) immediateSection.style.display = "";
  } else {
    btnPrint.classList.remove("active"); btnDigital.classList.add("active");
    status.className = "delivery-status mode-digital";
    status.textContent = "Portraits are sent via MMS only (no printer needed)";
    if (printSection) printSection.style.display = "none";
    if (printerSection) printerSection.style.display = "none";
    if (immediateSection) immediateSection.style.display = "none";
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
  document.getElementById("twitterSection").style.display = enabled ? "" : "none";
}
function toggleLinkedInShare(enabled) {
  document.getElementById("linkedInSection").style.display = enabled ? "" : "none";
}
function toggleInstagramShare(enabled) {
  document.getElementById("instagramSection").style.display = enabled ? "" : "none";
}
function validateSlugPrefix() {
  var val = document.getElementById("sDubSlugPrefix").value.trim();
  var domain = document.getElementById("sDubDomain").value.trim() || "twil.io";
  var el = document.getElementById("slugPrefixStatus");
  if (!val) {
    el.style.color = "#F83D53";
    el.textContent = "Prefix is required (min 1 character). Slug must be at least 3 characters for dub.co.";
    return;
  }
  if (/[^a-zA-Z0-9\-]/.test(val)) {
    el.style.color = "#F83D53";
    el.textContent = "Only letters, numbers, and hyphens allowed.";
    return;
  }
  var example = val + "-1";
  if (example.length < 3) {
    el.style.color = "#F83D53";
    el.textContent = "Slug too short — dub.co requires at least 3 characters. Current: " + domain + "/" + example;
    return;
  }
  el.style.color = "#656E87";
  el.textContent = "Preview: " + domain + "/" + example + ", " + domain + "/" + val + "-2, ...";
}

function toggleNps(enabled) {
  document.getElementById("sEnableNps").value = enabled ? "true" : "false";
  document.getElementById("npsSection").style.display = enabled ? "" : "none";
}

function toggleStillWorking(enabled) {
  document.getElementById("sStillWorkingEnabled").value = enabled ? "true" : "false";
  document.getElementById("stillWorkingSection").style.display = enabled ? "" : "none";
}

function setModelSelect(id, value) {
  var el = document.getElementById(id);
  if (!el) return;
  if (!value) { el.selectedIndex = 0; return; }
  var known = Array.prototype.some.call(el.options, function (o) { return o.value === value; });
  if (!known) {
    var opt = document.createElement("option");
    opt.value = value;
    opt.textContent = value + " (legacy)";
    el.appendChild(opt);
  }
  el.value = value;
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
  document.getElementById("sTwilioMssid").value = _settings.twilioMessagingServiceSid || "";
  document.getElementById("sTwilioSid").value = _settings.twilioAccountSid || "";
  document.getElementById("sTwilioToken").value = _settings.twilioAuthToken || "";

  // OpenAI
  document.getElementById("sOpenaiKey").value = _settings.openaiApiKey || "";
  setModelSelect("sModelOrch", _settings.modelOrchestrator);
  setModelSelect("sModelVision", _settings.modelVisionLight);
  setModelSelect("sModelImage", _settings.modelImageGen);
  setModelSelect("sModelReply", _settings.modelSmartReply);
  setModelSelect("sModelRefAnalysis", _settings.modelRefAnalysis);

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
  var sharePageOnly = _settings.sharePageOnly === true;
  document.getElementById("sharePageOnlyToggle").checked = sharePageOnly;
  document.getElementById("sSharePageOnly").value = sharePageOnly ? "true" : "false";
  document.getElementById("sDubApiKey").value = _settings.dubApiKey || "";
  document.getElementById("sDubDomain").value = _settings.dubDomain || "twil.io";
  document.getElementById("sDubSlugPrefix").value = _settings.dubSlugPrefix || "p";
  validateSlugPrefix();
  document.getElementById("sDubFolderId").value = _settings.dubFolderId || "";
  var twitterOn = _settings.enableTwitterShare !== false;
  document.getElementById("twitterShareToggle").checked = twitterOn;
  document.getElementById("twitterSection").style.display = twitterOn ? "" : "none";
  document.getElementById("sTwitterHandle").value = _settings.twitterHandle || "@twilio";
  document.getElementById("sTwitterShareText").value = _settings.twitterShareText || "";
  var linkedInOn = _settings.enableLinkedInShare !== false;
  document.getElementById("linkedInShareToggle").checked = linkedInOn;
  document.getElementById("linkedInSection").style.display = linkedInOn ? "" : "none";
  document.getElementById("sLinkedInText").value = _settings.linkedInShareText || "";
  document.getElementById("sLinkedInCompanyUrl").value = _settings.linkedInCompanyUrl || "";
  var instagramOn = _settings.enableInstagramShare !== false;
  document.getElementById("instagramShareToggle").checked = instagramOn;
  document.getElementById("instagramSection").style.display = instagramOn ? "" : "none";
  document.getElementById("sInstagramHandle").value = _settings.instagramHandle || "@twilio";
  document.getElementById("sShareMessageText").value = _settings.shareMessageText || "";
  document.getElementById("sSharePageTitle").value = _settings.sharePageTitle || "";
  document.getElementById("sSharePageTitlePersonalized").value = _settings.sharePageTitlePersonalized || "";
  document.getElementById("sSharePageDesc").value = _settings.sharePageDescription || "";
  var npsEnabled = _settings.enableNps === true;
  document.getElementById("npsToggle").checked = npsEnabled;
  document.getElementById("sEnableNps").value = npsEnabled ? "true" : "false";
  document.getElementById("npsSection").style.display = npsEnabled ? "" : "none";
  document.getElementById("sNpsDelay").value = _settings.npsDelay || 30;
  var swEnabled = _settings.stillWorkingEnabled !== false;
  var swToggle = document.getElementById("stillWorkingToggle");
  if (swToggle) swToggle.checked = swEnabled;
  var swHidden = document.getElementById("sStillWorkingEnabled");
  if (swHidden) swHidden.value = swEnabled ? "true" : "false";
  var swSection = document.getElementById("stillWorkingSection");
  if (swSection) swSection.style.display = swEnabled ? "" : "none";
  var swDelayEl = document.getElementById("sStillWorkingDelay");
  if (swDelayEl) swDelayEl.value = _settings.stillWorkingDelay || 60;
  document.getElementById("pauseToggle").checked = _settings.queuePaused === true;
  document.getElementById("sPaused").value = _settings.queuePaused ? "true" : "false";
  var reviewMode = _settings.reviewMode || (_settings.enableManualReview ? "human" : "off");
  document.getElementById("reviewModeSelect").value = reviewMode;
  document.getElementById("sReviewMode").value = reviewMode;
  document.getElementById("sReviewPin").value = _settings.reviewPin || "";
  document.getElementById("sVariantsPerReview").value = String(_settings.variantsPerReview || 1);
  document.getElementById("sRegenerationLimit").value = String(_settings.regenerationLimit || 2);
  renderStaffQr();
  setReviewMode(reviewMode);
  var aiChecks = _settings.aiReviewChecks || {};
  document.getElementById("aiCheckLikeness").checked = aiChecks.likeness !== false;
  document.getElementById("aiCheckSubjectCount").checked = aiChecks.subjectCount !== false;
  document.getElementById("aiCheckGender").checked = aiChecks.gender !== false;
  document.getElementById("aiCheckBranding").checked = aiChecks.branding !== false;
  document.getElementById("aiCheckAccessories").checked = aiChecks.accessories !== false;
  document.getElementById("aiCheckAnatomy").checked = aiChecks.anatomy !== false;
  document.getElementById("sBreakMessage").value = _settings.breakMessage || "";
  document.getElementById("sPhotoBookAutoplay").value = _settings.photoBookAutoplay !== false ? "true" : "false";
  document.getElementById("sPhotoBookInterval").value = _settings.photoBookInterval || 10;
  document.getElementById("sRevealAnimation").value = _settings.revealAnimation || "off";
  document.getElementById("sMilestonesEnabled").value = _settings.milestonesEnabled !== false ? "true" : "false";
  document.getElementById("sMilestoneInterval").value = _settings.milestoneInterval || 100;
  setDeliveryMode(_settings.enablePrinting !== false);
  document.getElementById("sImmediateDigitalDelivery").checked = _settings.immediateDigitalDelivery !== false;
  var lcMode = _settings.leadCaptureMode || "disabled";
  document.getElementById("lcToggle").checked = lcMode !== "disabled";
  if (lcMode !== "disabled") {
    document.getElementById("lcTimingSection").style.display = "";
    setLeadTiming(lcMode);
  } else {
    document.getElementById("lcTimingSection").style.display = "none";
    document.getElementById("sLeadMode").value = "disabled";
  }
  // AI Prompts
  document.getElementById("sPromptPreserve").value = _settings.promptPreserve || _promptDefaults.preserve;
  document.getElementById("sPromptComposition").value = _settings.promptComposition || _promptDefaults.composition;
  document.getElementById("sPromptPreserveBrand").value = _settings.promptPreserveBrand || _promptDefaults.preserveBrand;
  document.getElementById("sPromptBrandInstruction").value = _settings.promptBrandInstruction || _promptDefaults.brandInstruction;
  document.getElementById("sPromptFaceDetection").value = _settings.promptFaceDetection || _promptDefaults.faceDetection;
  document.getElementById("sPromptSceneAnalysis").value = _settings.promptSceneAnalysis || _promptDefaults.sceneAnalysis;
  document.getElementById("sPromptSmartReply").value = _settings.promptSmartReply || _promptDefaults.smartReply;
  document.getElementById("sPromptUserDirective").value = _settings.promptUserDirective || _promptDefaults.userDirective;

  // Multi-subject mode
  document.getElementById("sMultiSubjectMode").value = _settings.multiSubjectMode || "reject";
  toggleMultiSubjectReject();

  // Branding (load _allBrandRefFiles first so brand cards can reference them)
  _allBrandRefFiles = (_files.brandReferences || []).slice();
  document.getElementById("sBrandPrompt").value = _settings.brandPrompt || "";
  _enableBrandMenu = !!_settings.enableBrandMenu;
  _customBrands = Object.assign({}, _settings.customBrands || {});
  _disabledBrands = (_settings.disabledBrands || []).slice();
  _brandPromptOverrides = Object.assign({}, _settings.brandPromptOverrides || {});
  document.getElementById("brandMenuToggle").checked = _enableBrandMenu;
  document.getElementById("sEnableBrandMenu").value = _enableBrandMenu;
  document.getElementById("singleBrandSection").style.display = _enableBrandMenu ? "none" : "block";
  document.getElementById("brandChoicesSection").style.display = _enableBrandMenu ? "block" : "none";
  var brMsgEl = document.getElementById("brandMessagesSection");
  if (brMsgEl) brMsgEl.style.display = _enableBrandMenu ? "block" : "none";
  if (_enableBrandMenu) renderBrandRefLibrary();
  renderBrands();

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
  fillSelect("sVideo", _files.videos || [], _settings.videoFile, "None");
  updateTemplatePreview();
  updateVideoPreview();

  // Booth display mode
  document.getElementById("sBoothMode").value = _settings.boothDisplayMode || "video";
  toggleBoothMode(_settings.boothDisplayMode || "video");
  document.getElementById("sBoothHeadline").value = _settings.boothHeadline || "";
  document.getElementById("sBoothSubline").value = _settings.boothSubline || "";
  var loadedSteps = _settings.boothSteps && _settings.boothSteps.length
    ? _settings.boothSteps
    : [_settings.boothStep1 || "", _settings.boothStep2 || "", _settings.boothStep3 || ""].filter(Boolean);
  if (!loadedSteps.length) loadedSteps = ["Scan the QR code with your phone camera", "Send the pre-filled text message", "Take a selfie and reply with your photo"];
  renderBoothSteps(loadedSteps);
  document.getElementById("sBoothLegalText").value = _settings.boothLegalText || "";
  document.getElementById("sBoothShowSms").value = _settings.boothShowSmsInstructions !== false ? "true" : "false";
  toggleSmsFallbackPreview(_settings.boothShowSmsInstructions !== false ? "true" : "false");
  document.getElementById("sBoothSmsPhone").value = _settings.boothSmsPhone || "";
  document.getElementById("sBoothSmsText").value = _settings.boothSmsInstructionText || "Hit send to start";
  updateBoothQrPreview();

  // Phone tags
  renderPhoneTags();

  // Brand reference files
  renderBrandRefs(_files.brandReferences || [], _settings.brandReferenceFiles || []);

  // Messages
  _messages = Object.assign({}, _settings.messages || {});
  var msgIds = ["welcome","welcomeCount","remainingCount","quotaExceeded","multiplePhotos",
    "enqueued","pickupPrint","pickupDigital","twilioBlurb","stillWorking",
    "deliveryDigital","deliveryPrint","lastPortrait",
    "styleMenuIntro","styleMenuFooter","styleMenuRetry",
    "brandMenuIntro","brandMenuFooter","brandMenuRetry",
    "backgroundMenuIntro","backgroundMenuFooter","backgroundMenuRetry",
    "moderationFail","noFace","multiSubjectReject",
    "leadIntroBefore","leadIntroAfter","leadComplete","leadCompleteWithCta",
    "npsPrompt","npsThanks",
    "reviewReject","reviewFailed",
    "nudgeDropoff"];
  for (var mi = 0; mi < msgIds.length; mi++) {
    var el = document.getElementById("msg" + msgIds[mi].charAt(0).toUpperCase() + msgIds[mi].slice(1));
    if (el) el.value = _messages[msgIds[mi]] || _msgDefaults[msgIds[mi]] || "";
  }
  // Re-render menu previews now that message fields are populated
  renderBgMessagesPreview();
  renderBrandMessagesPreview();

  // Lead capture fields
  _leadCaptureFields = {};
  var lcfDefaults = _settings.leadCaptureFields || {};
  var lcfKeys = ["firstName","lastName","country","email","personalEmail","company","jobTitle"];
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
  box.textContent = "";
  if (val) {
    var v = document.createElement("video");
    v.src = "/booth-uploads/" + encodeURIComponent(val);
    v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = true;
    box.appendChild(v);
    box.style.display = "block";
  } else { box.style.display = "none"; }
}

function toggleBoothMode(mode) {
  document.getElementById("boothVideoSection").style.display = mode === "video" ? "" : "none";
  document.getElementById("boothStaticSection").style.display = mode === "static" ? "" : "none";
}
function toggleSmsFallbackPreview(val) {
  document.getElementById("boothSmsFallbackSection").style.display = val === "true" ? "" : "none";
}



function renderBoothSteps(steps) {
  var c = document.getElementById("boothStepsContainer");
  c.innerHTML = "";
  steps.forEach(function(text, i) {
    var row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;align-items:center;margin-bottom:6px";
    row.innerHTML = '<span style="min-width:28px;color:var(--th-text-muted);font-size:13px;font-weight:700">Step ' + (i+1) + '</span>'
      + '<input type="text" class="booth-step-input" value="' + escAttr(text) + '" placeholder="Step description" style="flex:1">'
      + '<button type="button" class="btn btn-sm" onclick="removeBoothStep('+i+')" title="Remove step" style="padding:4px 8px;color:var(--brand-red)">&#x2715;</button>';
    c.appendChild(row);
  });
}

function getBoothStepsRaw() {
  var inputs = document.querySelectorAll(".booth-step-input");
  var steps = [];
  inputs.forEach(function(el) { steps.push(el.value); });
  return steps;
}

function getBoothSteps() {
  return getBoothStepsRaw().map(function(s) { return s.trim(); }).filter(Boolean);
}

function addBoothStep() {
  var steps = getBoothStepsRaw();
  steps.push("");
  renderBoothSteps(steps);
  var inputs = document.querySelectorAll(".booth-step-input");
  if (inputs.length) inputs[inputs.length - 1].focus();
}

function removeBoothStep(idx) {
  var steps = getBoothStepsRaw();
  steps.splice(idx, 1);
  renderBoothSteps(steps);
}

function updateBoothQrPreview() {
  var val = _settings.boothQrImage;
  var box = document.getElementById("boothQrPreview");
  box.textContent = "";
  if (val) {
    var img = document.createElement("img");
    img.src = "/booth-uploads/" + encodeURIComponent(val);
    img.style.maxWidth = "120px"; img.style.maxHeight = "120px";
    box.appendChild(img);
    box.style.display = "block";
  } else { box.style.display = "none"; }
}

async function uploadBoothQr() {
  var input = document.getElementById("uploadBoothQr");
  var status = document.getElementById("uploadBoothQrStatus");
  if (!input.files || !input.files[0]) { status.textContent = "No file selected"; status.className = "upload-status err"; return; }
  var file = input.files[0];
  status.textContent = "Uploading..."; status.className = "upload-status";
  try {
    var url = "/dashboard/api/settings/upload?filename=" + encodeURIComponent(file.name) + "&type=booth-image";
    var r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file });
    var result = await r.json();
    if (result.error) { status.textContent = result.error; status.className = "upload-status err"; return; }
    status.textContent = "Uploaded " + result.filename; status.className = "upload-status";
    input.value = "";
    _settings.boothQrImage = result.filename;
    updateBoothQrPreview();
  } catch(e) { status.textContent = "Upload failed"; status.className = "upload-status err"; }
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
    _allBrandRefFiles = result.files;
    // Remove deleted file from all brand file lists
    Object.keys(_customBrands).forEach(function(k) {
      if (_customBrands[k].files) {
        var before = _customBrands[k].files.length;
        _customBrands[k].files = _customBrands[k].files.filter(function(f) { return f !== filename; });
        if (_customBrands[k].files.length !== before) _customBrands[k].analysis = "";
      }
    });
    renderBrandRefs(result.files, _brandRefFiles);
    if (_enableBrandMenu) { renderBrandRefLibrary(); renderBrands(); renderNewBrandFiles(); }
  } catch(e) { console.error("Failed to delete brand reference:", e); }
}

var _builtInStyles = ${JSON.stringify(Object.entries(require("./styles").STYLES).map(([k, v]) => ({ key: k, name: v.name, prompt: v.buildPrompt(require("./styles").DEFAULT_PRESERVE, require("./styles").DEFAULT_COMPOSITION), core: v.core, brandCore: v.brandCore })))};

// Client-side mirrors of lib/config-warnings.js — kept in sync by eye.
// Pure functions: take a brand/style object, return string[] of hints.
function _brandWarnings(brand) {
  if (!brand) return [];
  var out = [];
  var scenes = Array.isArray(brand.scenes) ? brand.scenes : [];
  if (brand.category === "wardrobe-plus-scene" && scenes.length === 0) {
    out.push('Category is "wardrobe-plus-scene" but no scenes are configured — the background menu will be empty.');
  }
  if (brand.category === "wardrobe-plus-scene" && brand.allowOriginal !== false) {
    out.push('"Allow original scene" has no effect for wardrobe-plus-scene brands — Original is always hidden.');
  }
  if (typeof brand.wardrobe === "string" && brand.wardrobe.trim()
      && typeof brand.brandPrompt === "string" && brand.brandPrompt.trim()) {
    out.push('Both wardrobe and legacy brandPrompt are set — brandPrompt will be ignored (wardrobe wins).');
  }
  for (var i = 0; i < scenes.length; i++) {
    var s = scenes[i];
    if (s && s.name && s.mode !== "exact" && (!s.prompt || !s.prompt.trim())) {
      out.push('Scene "' + s.name + '" has an empty prompt.');
    }
  }
  return out;
}
function _styleWarnings(style) {
  if (!style) return [];
  var out = [];
  var hasDesc = typeof style.containerDescription === "string" && style.containerDescription.trim();
  if (style.behavior === "themed-container" && !hasDesc) {
    out.push('Behavior is "themed-container" but container description is empty — nothing will be injected.');
  }
  if (style.behavior && style.behavior !== "themed-container" && hasDesc) {
    out.push("Container description is only used by themed-container styles — currently unused.");
  }
  return out;
}
function renderWarningsBlock(warnings) {
  if (!warnings || !warnings.length) return "";
  return '<div class="config-warning">'
    + warnings.map(function(w) { return '<div class="config-warning-line">' + escHtml(w) + '</div>'; }).join("")
    + '</div>';
}

function renderStyles() {
  var disabled = _settings.disabledStyles || [];
  var html = "";

  _builtInStyles.forEach(function(s, i) {
    var isDisabled = disabled.includes(s.key);
    var checked = !isDisabled ? "checked" : "";
    var hasOverride = !!_stylePromptOverrides[s.key];
    var promptText = _stylePromptOverrides[s.key] || s.prompt;
    html += '<div class="style-card' + (isDisabled ? ' disabled' : '') + '">'
      + '<div class="style-card-thumb" id="sp' + i + '"><svg width="20" height="20" viewBox="0 0 24 24" style="animation:spin 1s linear infinite;color:var(--th-text-muted)"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" stroke-dasharray="30 70" stroke-linecap="round"/></svg></div>'
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
    var styleFiles = _customStyles[k].files || [];
    var fileCount = styleFiles.length;
    var filesHtml = (_allStyleRefFiles || []).map(function(f) {
      var fChecked = styleFiles.indexOf(f) !== -1 ? " checked" : "";
      var esc = f.replace(/'/g, "\\\\'");
      return '<label class="brand-ref-tag' + (fChecked ? ' selected' : '') + '" style="font-size:12px"><input type="checkbox"' + fChecked + ' onchange="toggleStyleRefFile(\\'' + escAttr(k) + '\\',\\'' + esc + '\\',this.checked)"><img src="/style-references/' + encodeURIComponent(f) + '" style="width:24px;height:24px"> ' + escHtml(f) + ' <span class="brand-ref-delete" title="Delete from library" onclick="event.preventDefault();deleteStyleRef(\\'' + esc + '\\')">x</span></label>';
    }).join("");
    html += '<div class="style-card' + (isDisabled ? ' disabled' : '') + '">'
      + '<div class="style-card-thumb" id="spc_' + k + '"><svg width="20" height="20" viewBox="0 0 24 24" style="animation:spin 1s linear infinite;color:var(--th-text-muted)"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" stroke-dasharray="30 70" stroke-linecap="round"/></svg></div>'
      + '<div class="style-card-body">'
      + '<div class="style-card-header"><input class="sname-edit" value="' + escAttr(_customStyles[k].name) + '" oninput="onCustomNameEdit(\\''+k+'\\',this.value)"><span class="slabel">custom</span></div>'
      + '<div class="style-card-actions">'
      + '<button class="prompt-link" onclick="togglePrompt(\\'cp_' + k + '\\')">prompt</button>'
      + '<button class="prompt-link" onclick="togglePrompt(\\'cc_' + k + '\\')">core</button>'
      + '<button class="prompt-link" onclick="togglePrompt(\\'srf_' + k + '\\')">ref images (' + fileCount + ')</button>'
      + '<button class="remove-link" onclick="removeCustomStyle(\\''+k+'\\')">remove</button>'
      + '<label class="toggle-sw"><input type="checkbox" data-style="' + k + '" ' + checked + ' onchange="this.closest(\\'.style-card\\').classList.toggle(\\'disabled\\',!this.checked);rebuildDefaultStyleDropdown()"><span class="slider"></span></label>'
      + '</div>'
      + '<textarea class="style-prompt" id="cp_' + k + '" rows="6" oninput="onCustomPromptEdit(\\''+k+'\\',this.value)">' + escHtml(_customStyles[k].prompt || "") + '</textarea>'
      + '<textarea class="style-prompt" id="cc_' + k + '" rows="2" placeholder="One-sentence summary of the style. Used as a final reminder at the bottom of the generation prompt so it can\\'t be overridden by brand or background wording. Example: \\'Photo-realistic magazine cover portrait with bold typography and editorial lighting.\\'" oninput="onCustomCoreEdit(\\''+k+'\\',this.value)">' + escHtml(_customStyles[k].core || "") + '</textarea>'
      + '<div class="style-prompt" id="srf_' + k + '" style="padding:8px 0">'
      + '<div class="brand-ref-tags" style="margin:0">' + (filesHtml || '<span style="font-size:12px;color:var(--th-text-muted)">No style reference files uploaded yet.</span>') + '</div>'
      + '<div class="file-upload-row" style="margin-top:8px"><input type="file" id="uploadStyleRef_' + k + '" accept=".png,.jpg,.jpeg,.gif" multiple><button class="btn btn-sm" onclick="uploadStyleRefs(\\''+escAttr(k)+'\\')">Upload</button><span class="upload-status" id="uploadStyleRefStatus_' + k + '"></span></div>'
      + '</div>'
      + '<div class="adv-panel">'
      +   '<div class="adv-row">'
      +     '<div class="adv-field">'
      +       '<span class="adv-field-label">Behavior</span>'
      +       '<select class="adv-select" onchange="onCustomBehaviorEdit(\\''+k+'\\',this.value)">'
      +         '<option value="normal"' + ((_customStyles[k].behavior || "normal") === "normal" ? " selected" : "") + '>Normal</option>'
      +         '<option value="themed-container"' + (_customStyles[k].behavior === "themed-container" ? " selected" : "") + '>Themed container</option>'
      +       '</select>'
      +     '</div>'
      +     '<label class="adv-checkbox"><input type="checkbox"' + (_customStyles[k].acceptsColorPalette !== false ? " checked" : "") + ' onchange="onCustomAcceptsPaletteEdit(\\''+k+'\\',this.checked)"> Accepts color palette</label>'
      +   '</div>'
      +   (_customStyles[k].behavior === "themed-container"
          ? '<div class="adv-field">'
            + '<span class="adv-field-label">Container description <span style="text-transform:none;font-weight:400;letter-spacing:0;opacity:.7">(required for themed-container)</span></span>'
            + '<textarea class="adv-textarea" rows="2" oninput="onCustomContainerDescEdit(\\''+k+'\\',this.value)">' + escHtml(_customStyles[k].containerDescription || "") + '</textarea>'
            + '</div>'
          : '')
      + '</div>'
      + renderWarningsBlock(_styleWarnings(_customStyles[k]))
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

function onCustomBehaviorEdit(key, value) {
  if (!_customStyles[key]) return;
  if (value === "normal" || value === "themed-container") {
    _customStyles[key].behavior = value;
  } else {
    delete _customStyles[key].behavior;
  }
  renderStyles();
}

function onCustomAcceptsPaletteEdit(key, value) {
  if (!_customStyles[key]) return;
  _customStyles[key].acceptsColorPalette = !!value;
}

function onCustomContainerDescEdit(key, value) {
  if (!_customStyles[key]) return;
  var trimmed = (value || "").trim();
  if (trimmed) {
    _customStyles[key].containerDescription = value;
  } else {
    delete _customStyles[key].containerDescription;
  }
}

function onCustomCoreEdit(key, value) {
  if (!_customStyles[key]) return;
  var trimmed = (value || "").trim();
  if (trimmed) {
    _customStyles[key].core = value;
  } else {
    delete _customStyles[key].core;
  }
}

// ── Import Style Prompts from Another Event ──

function showImportStylePrompts() {
  var panel = document.getElementById("importStylePanel");
  if (panel.style.display !== "none") { panel.style.display = "none"; return; }
  panel.style.display = "block";
  var sel = document.getElementById("importEventSelect");
  sel.innerHTML = '<option value="">— select an event —</option>';
  var current = document.getElementById("sEventName").value;
  _eventProfiles.forEach(function(ev) {
    if (ev === current) return;
    sel.innerHTML += '<option value="' + escAttr(ev) + '">' + escHtml(ev) + '</option>';
  });
  if (_eventProfiles.length <= 1 || (_eventProfiles.length === 1 && _eventProfiles[0] === current)) {
    document.getElementById("importOverridesList").innerHTML = '<p style="color:var(--th-text-muted);font-size:13px">No other events with saved profiles.</p>';
  } else {
    document.getElementById("importOverridesList").innerHTML = '';
  }
}

var _importCustomStylesData = {};
function fetchEventStyleOverrides(eventName) {
  var container = document.getElementById("importOverridesList");
  if (!eventName) { container.innerHTML = ''; return; }
  container.innerHTML = '<p style="color:var(--th-text-muted);font-size:13px">Loading…</p>';
  fetch("/dashboard/api/settings/event-styles/" + encodeURIComponent(eventName))
    .then(function(r) { if (!r.ok) throw new Error("not found"); return r.json(); })
    .then(function(data) {
      var overrides = data.stylePromptOverrides || {};
      var customs = data.customStyles || {};
      _importCustomStylesData = customs;
      var overrideKeys = Object.keys(overrides);
      var customKeys = Object.keys(customs);
      if (overrideKeys.length === 0 && customKeys.length === 0) {
        container.innerHTML = '<p style="color:var(--th-text-muted);font-size:13px">No custom style prompts in this event.</p>';
        return;
      }
      var html = '';
      if (customKeys.length > 0) {
        html += '<div style="margin-bottom:8px;font-size:13px;color:var(--th-text-muted)">' + customKeys.length + ' custom style(s) found</div>';
        customKeys.forEach(function(key) {
          var prompt = customs[key].prompt || '';
          var fileCount = (customs[key].files || []).length;
          var preview = prompt.length > 80 ? prompt.substring(0, 80) + '…' : prompt;
          var differs = !_customStyles[key] || _customStyles[key].prompt !== prompt;
          html += '<label style="display:flex;align-items:flex-start;gap:8px;margin-bottom:6px;font-size:13px;cursor:pointer">'
            + '<input type="checkbox" data-import-type="custom" data-import-key="' + escHtml(key) + '"' + (differs ? ' checked' : '') + '>'
            + '<span><strong>' + escHtml(customs[key].name || key) + '</strong> <span style="color:var(--th-text-dim)">(custom' + (fileCount > 0 ? ', ' + fileCount + ' ref image' + (fileCount > 1 ? 's' : '') : '') + ')</span><br><span style="color:var(--th-text-muted)">' + escHtml(preview) + '</span></span>'
            + '</label>';
        });
      }
      if (overrideKeys.length > 0) {
        html += '<div style="margin-bottom:8px;margin-top:' + (customKeys.length > 0 ? '12px' : '0') + ';font-size:13px;color:var(--th-text-muted)">' + overrideKeys.length + ' prompt override(s) found</div>';
        overrideKeys.forEach(function(key) {
          var preview = overrides[key].length > 80 ? overrides[key].substring(0, 80) + '…' : overrides[key];
          var differs = _stylePromptOverrides[key] !== overrides[key];
          html += '<label style="display:flex;align-items:flex-start;gap:8px;margin-bottom:6px;font-size:13px;cursor:pointer">'
            + '<input type="checkbox" data-import-type="override" data-import-key="' + escAttr(key) + '" data-import-value="' + escAttr(overrides[key]) + '"' + (differs ? ' checked' : '') + '>'
            + '<span><strong>' + escHtml(key) + '</strong> <span style="color:var(--th-text-dim)">(override)</span><br><span style="color:var(--th-text-muted)">' + escHtml(preview) + '</span></span>'
            + '</label>';
        });
      }
      html += '<button class="btn btn-primary" onclick="importSelectedOverrides()" style="margin-top:8px">Import Selected</button>';
      container.innerHTML = html;
    })
    .catch(function() {
      container.innerHTML = '<p style="color:#e74c3c;font-size:13px">Failed to load event styles.</p>';
    });
}

function importSelectedOverrides() {
  var checkboxes = document.querySelectorAll('#importOverridesList input[type="checkbox"]:checked');
  var count = 0;
  checkboxes.forEach(function(cb) {
    var type = cb.getAttribute("data-import-type");
    var key = cb.getAttribute("data-import-key");
    var value = cb.getAttribute("data-import-value");
    if (!key) return;
    if (type === "custom") {
      var src = _importCustomStylesData[key];
      if (src) {
        _customStyles[key] = { name: src.name || key, prompt: src.prompt || "", files: (src.files || []).slice() };
        count++;
      }
    } else {
      if (value) { _stylePromptOverrides[key] = value; count++; }
    }
  });
  if (count > 0) {
    renderStyles();
    document.getElementById("importStylePanel").style.display = "none";
    alert(count + " style(s) imported — save to persist");
  }
}

// ── Lead Capture Field Editor ──
var _leadFieldLabels = {
  firstName: "First Name", lastName: "Last Name", country: "Country",
  email: "Business Email", personalEmail: "Email Address", company: "Company", jobTitle: "Job Title"
};

function renderLeadFields() {
  var container = document.getElementById("leadFieldsList");
  if (!container) return;
  var keys = ["firstName","lastName","country","email","personalEmail","company","jobTitle"];
  var h = "";
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var f = _leadCaptureFields[k] || { enabled: true, prompt: "", errorMsg: "" };
    var checked = f.enabled !== false ? "checked" : "";
    h += '<div style="padding:16px;background:var(--th-bg);border:1px solid var(--th-card-border);border-radius:10px;margin-bottom:10px">';
    h += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">';
    h += '<span style="font-size:14px;font-weight:700;color:var(--th-text-secondary)">' + _leadFieldLabels[k] + '</span>';
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
    "enqueued","pickupPrint","pickupDigital","twilioBlurb","stillWorking",
    "deliveryDigital","deliveryPrint","lastPortrait",
    "styleMenuIntro","styleMenuFooter","styleMenuRetry",
    "brandMenuIntro","brandMenuFooter","brandMenuRetry",
    "backgroundMenuIntro","backgroundMenuFooter","backgroundMenuRetry",
    "moderationFail","noFace","multiSubjectReject",
    "leadIntroBefore","leadIntroAfter","leadComplete","leadCompleteWithCta",
    "npsPrompt","npsThanks",
    "reviewReject","reviewFailed",
    "nudgeDropoff"];
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
  return String(s||"").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Themed modal helpers — return Promises so callers stay linear.
// Built with DOM methods (no innerHTML) so user-supplied strings can't inject markup.
// twModal.prompt({title, message, placeholder, defaultValue, validate}) -> Promise<string|null>
// twModal.confirm({title, message, confirmText, danger})                 -> Promise<boolean>
var twModal = (function() {
  var current = null;
  function closeCurrent(result) {
    if (!current) return;
    var resolve = current.resolve;
    var node = current.node;
    var onKey = current.onKey;
    current = null;
    document.removeEventListener("keydown", onKey, true);
    if (node && node.parentNode) node.parentNode.removeChild(node);
    resolve(result);
  }
  function makeBtn(text, cls, role) {
    var b = document.createElement("button");
    b.className = cls;
    b.textContent = text;
    b.setAttribute("data-role", role);
    return b;
  }
  function mount(cancelValue) {
    if (current) closeCurrent(null);
    var backdrop = document.createElement("div");
    backdrop.className = "tw-modal-backdrop";
    var dialog = document.createElement("div");
    dialog.className = "tw-modal";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    backdrop.appendChild(dialog);
    var finalCancel = cancelValue === undefined ? null : cancelValue;
    backdrop.addEventListener("click", function(e) {
      if (e.target === backdrop) closeCurrent(finalCancel);
    });
    var onKey = function(e) {
      if (e.key === "Escape") { e.preventDefault(); closeCurrent(finalCancel); }
    };
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(backdrop);
    return { node: backdrop, dialog: dialog, onKey: onKey };
  }
  function addHeading(dialog, title, message) {
    if (title) {
      var t = document.createElement("div");
      t.className = "tw-modal-title";
      t.textContent = title;
      dialog.appendChild(t);
    }
    if (message) {
      var m = document.createElement("div");
      m.className = "tw-modal-msg";
      m.textContent = message;
      dialog.appendChild(m);
    }
  }
  function prompt(opts) {
    opts = opts || {};
    return new Promise(function(resolve) {
      var ctx = mount(null);
      current = { node: ctx.node, resolve: resolve, onKey: ctx.onKey };
      addHeading(ctx.dialog, opts.title || "Enter a value", opts.message);
      var input = document.createElement("input");
      input.type = "text";
      input.className = "tw-modal-input";
      input.value = opts.defaultValue || "";
      input.placeholder = opts.placeholder || "";
      ctx.dialog.appendChild(input);
      var err = document.createElement("div");
      err.className = "tw-modal-error";
      ctx.dialog.appendChild(err);
      var actions = document.createElement("div");
      actions.className = "tw-modal-actions";
      var cancel = makeBtn("Cancel", "btn", "cancel");
      var ok = makeBtn(opts.confirmText || "OK", "btn " + (opts.danger ? "btn-danger" : "btn-primary"), "ok");
      actions.appendChild(cancel);
      actions.appendChild(ok);
      ctx.dialog.appendChild(actions);
      setTimeout(function() { input.focus(); input.select(); }, 0);
      var submit = function() {
        var v = input.value;
        if (typeof opts.validate === "function") {
          var msg = opts.validate(v);
          if (msg) { err.textContent = msg; input.focus(); return; }
        }
        closeCurrent(v);
      };
      ok.addEventListener("click", submit);
      cancel.addEventListener("click", function() { closeCurrent(null); });
      input.addEventListener("keydown", function(e) {
        if (e.key === "Enter") { e.preventDefault(); submit(); }
      });
      input.addEventListener("input", function() { err.textContent = ""; });
    });
  }
  function confirm(opts) {
    opts = opts || {};
    return new Promise(function(resolve) {
      var ctx = mount(false);
      current = { node: ctx.node, resolve: resolve, onKey: ctx.onKey };
      addHeading(ctx.dialog, opts.title || "Are you sure?", opts.message);
      var actions = document.createElement("div");
      actions.className = "tw-modal-actions";
      var cancel = makeBtn(opts.cancelText || "Cancel", "btn", "cancel");
      var ok = makeBtn(opts.confirmText || "OK", "btn " + (opts.danger ? "btn-danger" : "btn-primary"), "ok");
      actions.appendChild(cancel);
      actions.appendChild(ok);
      ctx.dialog.appendChild(actions);
      setTimeout(function() { ok.focus(); }, 0);
      ok.addEventListener("click", function() { closeCurrent(true); });
      cancel.addEventListener("click", function() { closeCurrent(false); });
    });
  }
  function alert(opts) {
    opts = opts || {};
    return new Promise(function(resolve) {
      var ctx = mount(true);
      current = { node: ctx.node, resolve: resolve, onKey: ctx.onKey };
      addHeading(ctx.dialog, opts.title || "Heads up", opts.message);
      var actions = document.createElement("div");
      actions.className = "tw-modal-actions";
      var ok = makeBtn(opts.confirmText || "OK", "btn btn-primary", "ok");
      actions.appendChild(ok);
      ctx.dialog.appendChild(actions);
      setTimeout(function() { ok.focus(); }, 0);
      ok.addEventListener("click", function() { closeCurrent(true); });
    });
  }
  return { prompt: prompt, confirm: confirm, alert: alert };
})();

function addCustomStyle() {
  var name = document.getElementById("csName").value.trim();
  var prompt = document.getElementById("csPrompt").value.trim();
  if (!name || !prompt) return;
  var key = name.toLowerCase().replace(/\\s+/g, "-");
  _customStyles[key] = {
    name: name,
    prompt: prompt,
    files: [],
    behavior: "normal",
    acceptsColorPalette: true,
  };
  document.getElementById("csName").value = "";
  document.getElementById("csPrompt").value = "";
  document.getElementById("customStyleForm").style.display = "none";
  renderStyles();
}

function removeCustomStyle(key) {
  delete _customStyles[key];
  renderStyles();
}

function toggleStyleRefFile(styleKey, filename, on) {
  var style = _customStyles[styleKey];
  if (!style) return;
  if (!style.files) style.files = [];
  var idx = style.files.indexOf(filename);
  if (on && idx === -1) style.files.push(filename);
  if (!on && idx !== -1) style.files.splice(idx, 1);
  style.analysis = "";
  renderStyles();
}

async function uploadStyleRefs(styleKey) {
  var input = document.getElementById("uploadStyleRef_" + styleKey);
  var status = document.getElementById("uploadStyleRefStatus_" + styleKey);
  if (!input || !input.files || input.files.length === 0) { if (status) { status.textContent = "No files selected"; status.className = "upload-status err"; } return; }
  if (status) { status.textContent = "Uploading..."; status.className = "upload-status"; }
  var style = _customStyles[styleKey];
  if (!style) return;
  if (!style.files) style.files = [];
  for (var i = 0; i < input.files.length; i++) {
    var file = input.files[i];
    try {
      var url = "/dashboard/api/settings/upload?filename=" + encodeURIComponent(file.name) + "&type=style-reference";
      var r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file });
      var result = await r.json();
      if (result.error) { if (status) { status.textContent = result.error; status.className = "upload-status err"; } return; }
      _allStyleRefFiles = result.files;
      if (style.files.indexOf(result.filename) === -1) style.files.push(result.filename);
    } catch(e) { if (status) { status.textContent = "Upload failed"; status.className = "upload-status err"; } return; }
  }
  style.analysis = "";
  if (status) { status.textContent = "Uploaded " + input.files.length + " file(s)"; status.className = "upload-status"; }
  input.value = "";
  renderStyles();
}

async function deleteStyleRef(filename) {
  if (!confirm("Delete \\"" + filename + "\\" from the style reference library? This removes it for ALL styles.")) return;
  try {
    var r = await fetch("/dashboard/api/settings/style-reference?filename=" + encodeURIComponent(filename), { method: "DELETE" });
    var result = await r.json();
    _allStyleRefFiles = result.files;
    Object.keys(_customStyles).forEach(function(k) {
      if (_customStyles[k].files) {
        var before = _customStyles[k].files.length;
        _customStyles[k].files = _customStyles[k].files.filter(function(f) { return f !== filename; });
        if (_customStyles[k].files.length !== before) _customStyles[k].analysis = "";
      }
    });
    renderStyles();
  } catch(e) { console.error(e); }
}

// ── Multi-Subject Mode ──
function toggleMultiSubjectReject() {
  var mode = document.getElementById("sMultiSubjectMode").value;
  document.getElementById("multiSubjectRejectSection").style.display = mode === "reject" ? "block" : "none";
}

// ── Background Menu ──
function toggleBackgroundMenu(enabled) {
  document.getElementById("sEnableBackgroundMenu").value = enabled;
  document.getElementById("bgChoicesSection").style.display = enabled ? "block" : "none";
  var bgMsgEl = document.getElementById("bgMessagesSection");
  if (bgMsgEl) bgMsgEl.style.display = enabled ? "block" : "none";
  if (enabled) renderBgMessagesPreview();
}

function toggleBgItem(index) {
  var body = document.getElementById("bgBody_" + index);
  if (body) body.style.display = body.style.display === "none" ? "block" : "none";
}

function renderBackgroundChoices() {
  var el = document.getElementById("bgChoicesList");
  renderBgMessagesPreview();
  if (!_backgroundChoices.length) { el.innerHTML = '<div style="font-size:13px;color:var(--th-text-muted);padding:4px 0">No background options configured.</div>'; return; }
  el.innerHTML = _backgroundChoices.map(function(c, i) {
    if (!c.files) c.files = [];
    if (!c.mode) c.mode = "ai";
    var bgFiles = c.files;
    var fileCount = bgFiles.length;
    var filesHtml = (_allBgRefFiles || []).map(function(f) {
      var fChecked = bgFiles.indexOf(f) !== -1 ? " checked" : "";
      var esc = f.replace(/'/g, "\\\\'");
      return '<label class="brand-ref-tag' + (fChecked ? ' selected' : '') + '" style="font-size:12px"><input type="checkbox"' + fChecked + ' onchange="toggleBgRefFile(' + i + ',\\'' + esc + '\\',this.checked)"><img src="/background-references/' + encodeURIComponent(f) + '" style="width:24px;height:24px;object-fit:cover;border-radius:2px"> ' + escHtml(f) + ' <span class="brand-ref-delete" title="Delete from library" onclick="event.preventDefault();deleteBgRef(\\'' + esc + '\\')">x</span></label>';
    }).join("");
    var modeLabel = c.mode === "exact" ? "Exact" : "AI";
    var modeHint = c.mode === "exact"
      ? '<div style="font-size:11px;color:var(--th-text-muted);margin-top:4px">First reference image will be used as the literal background. Portrait is generated with transparency and composited on top.</div>'
      : '<div style="font-size:11px;color:var(--th-text-muted);margin-top:4px">Reference images are sent to AI as inspiration. The background is generated in the portrait\\'s art style.</div>';
    return (i > 0 ? '<div style="border-top:1px solid var(--th-card-border);margin:12px 0"></div>' : '') +
    '<div style="background:var(--th-border-subtle);border-radius:8px;overflow:hidden">' +
      '<div onclick="toggleBgItem(' + i + ')" style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;cursor:pointer;user-select:none">' +
        '<span style="font-weight:700;font-size:13px;color:var(--th-text)">' + escHtml(c.name) + '</span>' +
        '<span style="font-size:11px;color:var(--th-text-muted)">' + modeLabel + (fileCount ? ' · ' + fileCount + ' ref' + (fileCount > 1 ? 's' : '') : '') + '</span>' +
      '</div>' +
      '<div id="bgBody_' + i + '" style="display:none;padding:0 14px 14px">' +
        '<div class="sf"><label>Name</label><input type="text" value="' + escAttr(c.name) + '" onchange="_backgroundChoices[' + i + '].name=this.value;renderBackgroundChoices()"></div>' +
        '<div class="sf"><label>Prompt</label><textarea rows="2" onchange="_backgroundChoices[' + i + '].prompt=this.value">' + (c.prompt || '').replace(/</g, '&lt;') + '</textarea></div>' +
        '<div class="sf"><label>Mode</label><select onchange="_backgroundChoices[' + i + '].mode=this.value;renderBackgroundChoices()">' +
          '<option value="ai"' + (c.mode !== "exact" ? ' selected' : '') + '>AI Reference</option>' +
          '<option value="exact"' + (c.mode === "exact" ? ' selected' : '') + '>Exact Background</option>' +
        '</select>' + modeHint + '</div>' +
        '<div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px;margin-top:8px">' +
          '<button class="prompt-link" style="font-size:11px" onclick="togglePrompt(\\'bgf' + i + '\\')">ref images (' + fileCount + ')</button>' +
          '<button style="font-size:11px;color:var(--brand-red);cursor:pointer;background:var(--th-border-subtle);border:1px solid rgba(239,34,58,0.2);padding:4px 10px;border-radius:6px;font-family:inherit;font-weight:700;transition:all .15s" onclick="removeBackgroundChoice(' + i + ')">remove</button>' +
        '</div>' +
        '<div class="style-prompt" id="bgf' + i + '" style="padding:8px 0"><div class="brand-ref-tags" style="margin:0">' +
          (filesHtml || '<span style="font-size:12px;color:var(--th-text-muted)">No reference images uploaded yet.</span>') +
          '<div class="file-upload-row" style="margin-top:6px">' +
            '<input type="file" id="uploadBgRef_' + i + '" accept=".png,.jpg,.jpeg,.gif" multiple>' +
            '<button class="btn btn-sm" onclick="uploadBgRefs(' + i + ')">Upload</button>' +
            '<span id="uploadBgRefStatus_' + i + '" class="upload-status"></span>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).join("");
}

function addBackgroundChoice() {
  var name = document.getElementById("bgNewName").value.trim();
  var prompt = document.getElementById("bgNewPrompt").value.trim();
  if (!name) return;
  var key = name.toLowerCase().replace(/\\s+/g, "-");
  _backgroundChoices.push({ key: key, name: name, prompt: prompt, files: [], mode: "ai" });
  document.getElementById("bgNewName").value = "";
  document.getElementById("bgNewPrompt").value = "";
  document.getElementById("addBgForm").style.display = "none";
  renderBackgroundChoices();
}

function removeBackgroundChoice(index) {
  _backgroundChoices.splice(index, 1);
  renderBackgroundChoices();
}

function toggleBgRefFile(index, filename, checked) {
  var c = _backgroundChoices[index];
  if (!c) return;
  if (!c.files) c.files = [];
  if (checked && c.files.indexOf(filename) === -1) c.files.push(filename);
  if (!checked) c.files = c.files.filter(function(f) { return f !== filename; });
  c.analysis = "";
  renderBackgroundChoices();
}

async function uploadBgRefs(index) {
  var input = document.getElementById("uploadBgRef_" + index);
  var status = document.getElementById("uploadBgRefStatus_" + index);
  if (!input || !input.files || input.files.length === 0) { if (status) { status.textContent = "No files selected"; status.className = "upload-status err"; } return; }
  if (status) { status.textContent = "Uploading..."; status.className = "upload-status"; }
  var c = _backgroundChoices[index];
  if (!c) return;
  if (!c.files) c.files = [];
  for (var i = 0; i < input.files.length; i++) {
    var file = input.files[i];
    try {
      var url = "/dashboard/api/settings/upload?filename=" + encodeURIComponent(file.name) + "&type=background-reference";
      var r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file });
      var result = await r.json();
      if (result.error) { if (status) { status.textContent = result.error; status.className = "upload-status err"; } return; }
      _allBgRefFiles = result.files;
      if (c.files.indexOf(result.filename) === -1) c.files.push(result.filename);
    } catch(e) { if (status) { status.textContent = "Upload failed"; status.className = "upload-status err"; } return; }
  }
  c.analysis = "";
  if (status) { status.textContent = "Uploaded " + input.files.length + " file(s)"; status.className = "upload-status"; }
  input.value = "";
  renderBackgroundChoices();
}

async function deleteBgRef(filename) {
  if (!confirm("Delete \\"" + filename + "\\" from the background reference library? This removes it from ALL backgrounds.")) return;
  try {
    var r = await fetch("/dashboard/api/settings/background-reference?filename=" + encodeURIComponent(filename), { method: "DELETE" });
    var result = await r.json();
    _allBgRefFiles = result.files;
    _backgroundChoices.forEach(function(c) {
      if (c.files) {
        var before = c.files.length;
        c.files = c.files.filter(function(f) { return f !== filename; });
        if (c.files.length !== before) c.analysis = "";
      }
    });
    renderBackgroundChoices();
  } catch(e) { console.error(e); }
}

function renderBgMessagesPreview() {
  var el = document.getElementById("bgMessagesPreview");
  if (!el) return;
  if (!_backgroundChoices.length) { el.innerHTML = ""; return; }
  var lines = _backgroundChoices.map(function(c, i) { return (i + 1) + ". " + c.name; });
  el.innerHTML = '<div style="font-size:12px;color:var(--th-text-muted);margin-bottom:4px">Preview — what users will see:</div>' +
    '<div style="background:var(--th-bg);border:1px solid var(--th-border-subtle);border-radius:6px;padding:10px 12px;font-size:12px;color:var(--th-text-dim);white-space:pre-line;line-height:1.6">' +
    (document.getElementById("msgBackgroundMenuIntro").value || _msgDefaults.backgroundMenuIntro || "") +
    "\\n\\n" + lines.join("\\n") + "\\n\\n" +
    (document.getElementById("msgBackgroundMenuFooter").value || _msgDefaults.backgroundMenuFooter || "") +
    '</div>';
}

// ── Brand Menu ──
function toggleBrandMenu(enabled) {
  _enableBrandMenu = enabled;
  document.getElementById("sEnableBrandMenu").value = enabled;
  document.getElementById("singleBrandSection").style.display = enabled ? "none" : "block";
  document.getElementById("brandChoicesSection").style.display = enabled ? "block" : "none";
  var brMsgEl = document.getElementById("brandMessagesSection");
  if (brMsgEl) brMsgEl.style.display = enabled ? "block" : "none";
  if (enabled) {
    renderBrandRefLibrary();
    renderBrands();
    renderBrandMessagesPreview();
  }
}

function renderBrands() {
  var el = document.getElementById("brandsList");
  renderBrandMessagesPreview();
  renderNewBrandFiles();
  var keys = Object.keys(_customBrands);
  if (!keys.length) { el.innerHTML = '<div style="font-size:13px;color:var(--th-text-muted);padding:4px 0">No brands configured. Add one below.</div>'; return; }
  el.innerHTML = keys.map(function(k, i) {
    var brand = _customBrands[k];
    var isDisabled = _disabledBrands.indexOf(k) !== -1;
    var hasOverride = !!_brandPromptOverrides[k];
    var promptVal = _brandPromptOverrides[k] || brand.brandPrompt || "";
    var filesHtml = (_allBrandRefFiles || []).map(function(f) {
      var checked = (brand.files || []).indexOf(f) !== -1 ? " checked" : "";
      var esc = f.replace(/'/g, "\\\\'");
      return '<label class="brand-ref-tag' + (checked ? ' selected' : '') + '" style="font-size:12px"><input type="checkbox"' + checked + ' onchange="toggleBrandFile(\\'' + escAttr(k) + '\\',\\'' + esc + '\\',this.checked)"><img src="/brand-references/' + encodeURIComponent(f) + '" style="width:24px;height:24px"> ' + escHtml(f) + '</label>';
    }).join("");
    return '<div class="style-card' + (isDisabled ? ' disabled' : '') + '" style="margin-bottom:12px">' +
      '<div class="style-card-body">' +
        '<div class="style-card-header">' +
          '<span class="sname">' + escHtml(brand.name || k) + '</span>' +
          '<label class="toggle-sw"><input type="checkbox" ' + (!isDisabled ? 'checked' : '') + ' onchange="toggleBrandEnabled(\\'' + escAttr(k) + '\\',this.checked)"><span class="slider"></span></label>' +
        '</div>' +
        '<div class="style-card-actions">' +
          '<button class="prompt-link" onclick="togglePrompt(\\'brp' + i + '\\')">prompt' + (hasOverride ? ' *' : '') + '</button>' +
          (hasOverride ? '<button class="reset-link visible" onclick="resetBrandPromptOverride(\\'' + escAttr(k) + '\\',' + i + ')">reset</button>' : '') +
          '<button class="prompt-link" onclick="togglePrompt(\\'brf' + i + '\\')">files (' + (brand.files || []).length + ')</button>' +
          '<button class="remove-link" onclick="removeBrand(\\'' + escAttr(k) + '\\')">remove</button>' +
        '</div>' +
        '<textarea class="style-prompt" id="brp' + i + '" rows="2" placeholder="Brand-specific prompt" oninput="onBrandPromptEdit(\\'' + escAttr(k) + '\\',this.value)">' + escHtml(promptVal) + '</textarea>' +
        '<div class="style-prompt" id="brf' + i + '" style="padding:8px 0"><div class="brand-ref-tags" style="margin:0">' + (filesHtml || '<span style="font-size:12px;color:var(--th-text-muted)">No reference files uploaded yet.</span>') + '</div></div>' +
        '<div class="adv-panel">' +
          '<div class="adv-row">' +
            '<div class="adv-field">' +
              '<span class="adv-field-label">Category</span>' +
              '<select class="adv-select" onchange="onBrandCategoryEdit(\\'' + escAttr(k) + '\\',this.value)">' +
                '<option value="wardrobe-only"' + ((brand.category || "wardrobe-only") === "wardrobe-only" ? " selected" : "") + '>Wardrobe only</option>' +
                '<option value="wardrobe-plus-scene"' + (brand.category === "wardrobe-plus-scene" ? " selected" : "") + '>Wardrobe + scene</option>' +
              '</select>' +
            '</div>' +
            '<label class="adv-checkbox"><input type="checkbox"' + (brand.allowOriginal !== false ? " checked" : "") + ' onchange="onBrandAllowOriginalEdit(\\'' + escAttr(k) + '\\',this.checked)"> Allow &ldquo;Original scene&rdquo;</label>' +
          '</div>' +
          '<div class="adv-field">' +
            '<span class="adv-field-label">Wardrobe fragment</span>' +
            '<textarea class="adv-textarea" rows="2" placeholder="wearing a ..." oninput="onBrandWardrobeEdit(\\'' + escAttr(k) + '\\',this.value)">' + escHtml(brand.wardrobe || "") + '</textarea>' +
          '</div>' +
          '<div class="adv-field">' +
            '<span class="adv-field-label">Color palette override <span style="text-transform:none;font-weight:400;letter-spacing:0;opacity:.7">(optional)</span></span>' +
            '<textarea class="adv-textarea" rows="2" placeholder="Recolor everything to ..." oninput="onBrandColorPaletteEdit(\\'' + escAttr(k) + '\\',this.value)">' + escHtml(brand.colorPalette || "") + '</textarea>' +
          '</div>' +
          '<div class="adv-field">' +
            '<div class="scenes-header">' +
              '<span class="adv-field-label">Scenes (' + ((brand.scenes || []).length) + ')</span>' +
              '<button class="btn btn-sm" onclick="addScene(\\'' + escAttr(k) + '\\')">+ Add scene</button>' +
            '</div>' +
            (brand.scenes && brand.scenes.length
              ? '<div class="scene-list">' + brand.scenes.map(function(s, si) {
                  if (!s.files) s.files = [];
                  if (!s.mode) s.mode = "ai";
                  var sFiles = s.files;
                  var sFileCount = sFiles.length;
                  var sFilesHtml = (_allBgRefFiles || []).map(function(f) {
                    var fChecked = sFiles.indexOf(f) !== -1 ? " checked" : "";
                    var esc = f.replace(/'/g, "\\\\'");
                    return '<label class="brand-ref-tag' + (fChecked ? ' selected' : '') + '" style="font-size:12px"><input type="checkbox"' + fChecked + ' onchange="toggleSceneFile(\\'' + escAttr(k) + '\\',' + si + ',\\'' + esc + '\\',this.checked)"><img src="/background-references/' + encodeURIComponent(f) + '" style="width:24px;height:24px;object-fit:cover;border-radius:2px"> ' + escHtml(f) + '</label>';
                  }).join("");
                  var sModeHint = s.mode === "exact"
                    ? '<div style="font-size:11px;color:var(--th-text-muted);margin-top:4px">First reference image will be used as the literal background. Portrait is generated with transparency and composited on top.</div>'
                    : '<div style="font-size:11px;color:var(--th-text-muted);margin-top:4px">Reference images are sent to AI as inspiration. The background is generated in the portrait\\'s art style.</div>';
                  return '<div class="scene-row">' +
                    '<div class="scene-row-top">' +
                      '<code class="scene-key">' + escHtml(s.key) + '</code>' +
                      '<input type="text" class="scene-name-input" value="' + escAttr(s.name || "") + '" placeholder="Display name" oninput="onSceneNameEdit(\\'' + escAttr(k) + '\\',' + si + ',this.value)">' +
                      '<button class="scene-remove" title="Remove scene" onclick="removeScene(\\'' + escAttr(k) + '\\',' + si + ')">&times;</button>' +
                    '</div>' +
                    '<textarea class="adv-textarea" rows="2" placeholder="Background prompt" oninput="onScenePromptEdit(\\'' + escAttr(k) + '\\',' + si + ',this.value)">' + escHtml(s.prompt || "") + '</textarea>' +
                    '<div class="sf" style="margin-top:8px"><label>Mode</label>' +
                      '<select onchange="onSceneModeEdit(\\'' + escAttr(k) + '\\',' + si + ',this.value)">' +
                        '<option value="ai"' + (s.mode !== "exact" ? ' selected' : '') + '>AI Reference</option>' +
                        '<option value="exact"' + (s.mode === "exact" ? ' selected' : '') + '>Exact Background</option>' +
                      '</select>' + sModeHint +
                    '</div>' +
                    '<div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px;margin-top:8px">' +
                      '<button class="prompt-link" style="font-size:11px" onclick="togglePrompt(\\'scf_' + escAttr(k) + '_' + si + '\\')">ref images (' + sFileCount + ')</button>' +
                    '</div>' +
                    '<div class="style-prompt" id="scf_' + escAttr(k) + '_' + si + '" style="padding:8px 0"><div class="brand-ref-tags" style="margin:0">' +
                      (sFilesHtml || '<span style="font-size:12px;color:var(--th-text-muted)">No reference images uploaded yet.</span>') +
                      '<div class="file-upload-row" style="margin-top:6px">' +
                        '<input type="file" id="uploadSceneRef_' + escAttr(k) + '_' + si + '" accept=".png,.jpg,.jpeg,.gif" multiple>' +
                        '<button class="btn btn-sm" onclick="uploadSceneRefs(\\'' + escAttr(k) + '\\',' + si + ')">Upload</button>' +
                        '<span id="uploadSceneRefStatus_' + escAttr(k) + '_' + si + '" class="upload-status"></span>' +
                      '</div>' +
                    '</div></div>' +
                  '</div>';
                }).join("") + '</div>'
              : '<div class="scenes-empty">No scenes configured. Click &ldquo;+ Add scene&rdquo; to add one.</div>'
            ) +
          '</div>' +
        '</div>' +
        renderWarningsBlock(_brandWarnings(brand)) +
      '</div>' +
    '</div>';
  }).join("");
}

function toggleBrandEnabled(key, enabled) {
  var idx = _disabledBrands.indexOf(key);
  if (enabled && idx !== -1) _disabledBrands.splice(idx, 1);
  if (!enabled && idx === -1) _disabledBrands.push(key);
  renderBrands();
}

function toggleBrandFile(key, filename, on) {
  var brand = _customBrands[key];
  if (!brand) return;
  if (!brand.files) brand.files = [];
  var idx = brand.files.indexOf(filename);
  if (on && idx === -1) brand.files.push(filename);
  if (!on && idx !== -1) brand.files.splice(idx, 1);
  brand.analysis = "";
  renderBrands();
}

function onBrandPromptEdit(key, value) {
  var brand = _customBrands[key];
  if (!brand) return;
  // If value differs from the brand's base prompt, store as override
  if (value !== (brand.brandPrompt || "")) {
    _brandPromptOverrides[key] = value;
  } else {
    delete _brandPromptOverrides[key];
  }
}

function onBrandCategoryEdit(key, value) {
  if (!_customBrands[key]) return;
  if (value === "wardrobe-only" || value === "wardrobe-plus-scene") {
    _customBrands[key].category = value;
  } else {
    delete _customBrands[key].category;
  }
  renderBrands();
}

function onBrandWardrobeEdit(key, value) {
  if (!_customBrands[key]) return;
  var trimmed = (value || "").trim();
  if (trimmed) {
    _customBrands[key].wardrobe = value;
    delete _customBrands[key].brandPrompt;
  } else {
    delete _customBrands[key].wardrobe;
  }
}

function onBrandAllowOriginalEdit(key, value) {
  if (!_customBrands[key]) return;
  _customBrands[key].allowOriginal = !!value;
}

function onBrandColorPaletteEdit(key, value) {
  if (!_customBrands[key]) return;
  var trimmed = (value || "").trim();
  if (trimmed) _customBrands[key].colorPalette = value;
  else delete _customBrands[key].colorPalette;
}

function addScene(brandKey) {
  var b = _customBrands[brandKey];
  if (!b) return;
  if (!Array.isArray(b.scenes)) b.scenes = [];
  twModal.prompt({
    title: "Add scene",
    message: "Give this background scene a short key (used internally) — e.g. ice-rink, rotary-phone.",
    placeholder: "ice-rink",
    confirmText: "Next",
    validate: function(v) {
      var norm = (v || "").trim().toLowerCase().replace(/\\s+/g, "-");
      if (!norm) return "Scene key is required.";
      if (!/^[a-z0-9-]+$/.test(norm)) return "Use lowercase letters, numbers, and dashes only.";
      if (b.scenes.some(function(s) { return s.key === norm; })) return "A scene with this key already exists.";
      return null;
    }
  }).then(function(raw) {
    if (raw == null) return;
    var sceneKey = raw.trim().toLowerCase().replace(/\\s+/g, "-");
    return twModal.prompt({
      title: "Display name",
      message: "How should this scene appear in the background menu?",
      placeholder: sceneKey,
      defaultValue: sceneKey.replace(/-/g, " ").replace(/\b\w/g, function(c) { return c.toUpperCase(); }),
      confirmText: "Add scene"
    }).then(function(nameRaw) {
      if (nameRaw == null) return;
      var sceneName = (nameRaw || "").trim() || sceneKey;
      b.scenes.push({ key: sceneKey, name: sceneName, prompt: "", files: [] });
      renderBrands();
    });
  });
}

function removeScene(brandKey, sceneIdx) {
  var b = _customBrands[brandKey];
  if (!b || !Array.isArray(b.scenes)) return;
  var s = b.scenes[sceneIdx];
  var label = s && s.name ? s.name : (s && s.key ? s.key : "this scene");
  twModal.confirm({
    title: "Remove scene?",
    message: "\\"" + label + "\\" will be removed from this brand's background menu. You can add it back later.",
    confirmText: "Remove",
    danger: true
  }).then(function(ok) {
    if (!ok) return;
    b.scenes.splice(sceneIdx, 1);
    renderBrands();
  });
}

function onSceneNameEdit(brandKey, idx, value) {
  var b = _customBrands[brandKey];
  if (!b || !b.scenes || !b.scenes[idx]) return;
  b.scenes[idx].name = value;
}

function onScenePromptEdit(brandKey, idx, value) {
  var b = _customBrands[brandKey];
  if (!b || !b.scenes || !b.scenes[idx]) return;
  b.scenes[idx].prompt = value;
}

function onSceneModeEdit(brandKey, idx, value) {
  var b = _customBrands[brandKey];
  if (!b || !b.scenes || !b.scenes[idx]) return;
  b.scenes[idx].mode = value === "exact" ? "exact" : "ai";
  b.scenes[idx].analysis = "";
  renderBrands();
}

function toggleSceneFile(brandKey, idx, filename, checked) {
  var b = _customBrands[brandKey];
  if (!b || !b.scenes || !b.scenes[idx]) return;
  var s = b.scenes[idx];
  if (!s.files) s.files = [];
  if (checked && s.files.indexOf(filename) === -1) s.files.push(filename);
  if (!checked) s.files = s.files.filter(function(f) { return f !== filename; });
  s.analysis = "";
  renderBrands();
}

async function uploadSceneRefs(brandKey, idx) {
  var input = document.getElementById("uploadSceneRef_" + brandKey + "_" + idx);
  var status = document.getElementById("uploadSceneRefStatus_" + brandKey + "_" + idx);
  if (!input || !input.files || input.files.length === 0) { if (status) { status.textContent = "No files selected"; status.className = "upload-status err"; } return; }
  if (status) { status.textContent = "Uploading..."; status.className = "upload-status"; }
  var b = _customBrands[brandKey];
  if (!b || !b.scenes || !b.scenes[idx]) return;
  var s = b.scenes[idx];
  if (!s.files) s.files = [];
  for (var i = 0; i < input.files.length; i++) {
    var file = input.files[i];
    try {
      var url = "/dashboard/api/settings/upload?filename=" + encodeURIComponent(file.name) + "&type=background-reference";
      var r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file });
      var result = await r.json();
      if (result.error) { if (status) { status.textContent = result.error; status.className = "upload-status err"; } return; }
      _allBgRefFiles = result.files;
      if (s.files.indexOf(result.filename) === -1) s.files.push(result.filename);
    } catch(e) { if (status) { status.textContent = "Upload failed"; status.className = "upload-status err"; } return; }
  }
  s.analysis = "";
  if (status) { status.textContent = "Uploaded " + input.files.length + " file(s)"; status.className = "upload-status"; }
  input.value = "";
  renderBrands();
}

function resetBrandPromptOverride(key, index) {
  delete _brandPromptOverrides[key];
  var brand = _customBrands[key];
  var ta = document.getElementById("brp" + index);
  if (ta && brand) ta.value = brand.brandPrompt || "";
  renderBrands();
}

function addBrand() {
  var name = document.getElementById("brandNewName").value.trim();
  var prompt = document.getElementById("brandNewPrompt").value.trim();
  if (!name) return;
  var key = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!key) return;
  if (_customBrands[key]) {
    twModal.alert({ title: "Can't add brand", message: "A brand with key \\"" + key + "\\" already exists." });
    return;
  }
  // Collect selected files from the add form
  var files = [];
  var checkboxes = document.querySelectorAll("#brandNewFiles input[type=checkbox]:checked");
  for (var i = 0; i < checkboxes.length; i++) {
    files.push(checkboxes[i].getAttribute("data-file"));
  }
  _customBrands[key] = {
    name: name,
    files: files,
    wardrobe: prompt,
    category: "wardrobe-only",
    allowOriginal: true,
  };
  document.getElementById("brandNewName").value = "";
  document.getElementById("brandNewPrompt").value = "";
  document.getElementById("addBrandForm").style.display = "none";
  renderBrands();
}

function removeBrand(key) {
  var label = _customBrands[key] ? _customBrands[key].name : key;
  twModal.confirm({
    title: "Remove brand?",
    message: "\\"" + label + "\\" will be removed from this event's brand list. You can re-add it later.",
    confirmText: "Remove",
    danger: true
  }).then(function(ok) {
    if (!ok) return;
    delete _customBrands[key];
    delete _brandPromptOverrides[key];
    _disabledBrands = _disabledBrands.filter(function(k) { return k !== key; });
    renderBrands();
  });
}

function renderNewBrandFiles() {
  var container = document.getElementById("brandNewFiles");
  if (!container) return;
  if (!_allBrandRefFiles || !_allBrandRefFiles.length) {
    container.innerHTML = '<span style="font-size:12px;color:var(--th-text-muted)">Upload brand reference files above first.</span>';
    return;
  }
  container.innerHTML = _allBrandRefFiles.map(function(f) {
    var esc = f.replace(/'/g, "\\\\'");
    return '<label class="brand-ref-tag" style="font-size:12px"><input type="checkbox" data-file="' + escAttr(f) + '" onchange="this.closest(\\'.brand-ref-tag\\').classList.toggle(\\'selected\\',this.checked)"><img src="/brand-references/' + encodeURIComponent(f) + '" style="width:24px;height:24px"> ' + escHtml(f) + '</label>';
  }).join("");
}

function renderBrandRefLibrary() {
  var container = document.getElementById("brandRefLibrary");
  if (!container) return;
  if (!_allBrandRefFiles || !_allBrandRefFiles.length) {
    container.innerHTML = '<span style="font-size:12px;color:var(--th-text-muted)">No reference files uploaded yet.</span>';
    return;
  }
  container.innerHTML = _allBrandRefFiles.map(function(f) {
    var esc = f.replace(/'/g, "\\\\'");
    return '<label class="brand-ref-tag selected" style="font-size:12px"><img src="/brand-references/' + encodeURIComponent(f) + '" style="width:24px;height:24px"> ' + escHtml(f) + ' <span class="brand-ref-delete" title="Delete from library" onclick="event.preventDefault();deleteBrandRef(\\'' + esc + '\\')">x</span></label>';
  }).join("");
}

async function uploadBrandRefsMulti() {
  var input = document.getElementById("uploadBrandRefMulti");
  var status = document.getElementById("uploadBrandRefMultiStatus");
  if (!input.files || !input.files.length) { status.textContent = "No files selected"; status.className = "upload-status err"; return; }
  var count = input.files.length;
  status.textContent = "Uploading..."; status.className = "upload-status";
  for (var i = 0; i < count; i++) {
    var file = input.files[i];
    try {
      var url = "/dashboard/api/settings/upload?filename=" + encodeURIComponent(file.name) + "&type=brand-reference";
      var r = await fetch(url, { method: "POST", body: file });
      var result = await r.json();
      _allBrandRefFiles = result.files;
    } catch(e) { status.textContent = "Upload failed: " + e.message; status.className = "upload-status err"; return; }
  }
  input.value = "";
  status.textContent = "Uploaded " + count + " file(s)"; status.className = "upload-status";
  renderBrandRefLibrary();
  renderBrands();
  renderNewBrandFiles();
}

function renderBrandMessagesPreview() {
  var el = document.getElementById("brandMessagesPreview");
  if (!el) return;
  var keys = Object.keys(_customBrands).filter(function(k) { return _disabledBrands.indexOf(k) === -1; });
  if (!keys.length) { el.innerHTML = ""; return; }
  var lines = keys.map(function(k, i) { return (i + 1) + ". " + (_customBrands[k].name || k); });
  el.innerHTML = '<div style="font-size:12px;color:var(--th-text-muted);margin-bottom:4px">Preview — what users will see:</div>' +
    '<div style="background:var(--th-bg);border:1px solid var(--th-border-subtle);border-radius:6px;padding:10px 12px;font-size:12px;color:var(--th-text-dim);white-space:pre-line;line-height:1.6">' +
    (document.getElementById("msgBrandMenuIntro").value || _msgDefaults.brandMenuIntro || "") +
    "\\n\\n" + lines.join("\\n") + "\\n\\n" +
    (document.getElementById("msgBrandMenuFooter").value || _msgDefaults.brandMenuFooter || "") +
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
    container.innerHTML = '<span style="color:var(--th-text-muted)">No printers detected</span>';
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
  container.innerHTML = '<div style="display:flex;align-items:center;gap:8px;padding:8px 0"><svg width="16" height="16" viewBox="0 0 24 24" style="animation:spin 1s linear infinite;color:var(--th-text-muted)"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" stroke-dasharray="30 70" stroke-linecap="round"/></svg><span style="color:var(--th-text-muted);font-size:13px">Refreshing...</span></div>';
  try {
    var r = await fetch("/dashboard/api/settings/files");
    var files = await r.json();
    _files.printers = files.printers;
    renderPrinterChecklist(files.printers || [], getSelectedPrinters());
  } catch(e) {
    container.innerHTML = '<span style="color:var(--brand-red)">Error loading printers</span>';
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
  if (_saveInFlight) return false;
  _saveInFlight = true;
  try { return await _doSaveSettings(); } finally { _saveInFlight = false; }
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
      if (!r.ok) {
        var errBody = "";
        try { errBody = await r.text(); } catch(_) {}
        throw new Error("Server returned " + r.status + (errBody ? ": " + errBody.substring(0, 200) : ""));
      }
      _settings = await r.json();
      var isExisting = _eventProfiles.indexOf(newEventName) !== -1;
      var msg = isExisting
        ? "Switched to \\"" + newEventName + "\\" -- settings loaded for this event."
        : "Created new event \\"" + newEventName + "\\" -- starting with defaults.";
      await loadSettings();
      showBanner(msg, "success");
      return true;
    } catch (err) {
      showBanner("Save failed: " + err.message, "error");
      return false;
    }
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
    twilioMessagingServiceSid: document.getElementById("sTwilioMssid").value,
    twilioAccountSid: document.getElementById("sTwilioSid").value,
    twilioAuthToken: document.getElementById("sTwilioToken").value,
    openaiApiKey: document.getElementById("sOpenaiKey").value,
    modelOrchestrator: document.getElementById("sModelOrch").value,
    modelVisionLight: document.getElementById("sModelVision").value,
    modelImageGen: document.getElementById("sModelImage").value,
    modelSmartReply: document.getElementById("sModelReply").value,
    modelRefAnalysis: document.getElementById("sModelRefAnalysis").value,
    activePrinters: getSelectedPrinters(),
    templateFile: document.getElementById("sTemplate").value,
    videoFile: document.getElementById("sVideo").value,
    boothDisplayMode: document.getElementById("sBoothMode").value,
    boothHeadline: document.getElementById("sBoothHeadline").value,
    boothSubline: document.getElementById("sBoothSubline").value,
    boothQrImage: _settings.boothQrImage || "",
    boothSteps: getBoothSteps(),
    boothLegalText: document.getElementById("sBoothLegalText").value,
    boothShowSmsInstructions: document.getElementById("sBoothShowSms").value === "true",
    boothSmsPhone: document.getElementById("sBoothSmsPhone").value,
    boothSmsInstructionText: document.getElementById("sBoothSmsText").value,
    adminPhones: _adminPhones,
    termsUrl: document.getElementById("sTermsUrl").value,
    enablePromoMessage: document.getElementById("sEnablePromo").value === "true",
    promoMessage: document.getElementById("sPromoMessage").value,
    enableShareLinks: document.getElementById("sEnableShare").value === "true",
    sharePageOnly: document.getElementById("sSharePageOnly").value === "true",
    enableTwitterShare: document.getElementById("twitterShareToggle").checked,
    enableLinkedInShare: document.getElementById("linkedInShareToggle").checked,
    enableInstagramShare: document.getElementById("instagramShareToggle").checked,
    twitterHandle: document.getElementById("sTwitterHandle").value,
    twitterShareText: document.getElementById("sTwitterShareText").value,
    linkedInShareText: document.getElementById("sLinkedInText").value,
    linkedInCompanyUrl: document.getElementById("sLinkedInCompanyUrl").value,
    instagramHandle: document.getElementById("sInstagramHandle").value,
    shareMessageText: document.getElementById("sShareMessageText").value,
    sharePageTitle: document.getElementById("sSharePageTitle").value,
    sharePageTitlePersonalized: document.getElementById("sSharePageTitlePersonalized").value,
    sharePageDescription: document.getElementById("sSharePageDesc").value,
    dubApiKey: document.getElementById("sDubApiKey").value,
    dubDomain: document.getElementById("sDubDomain").value,
    dubSlugPrefix: document.getElementById("sDubSlugPrefix").value,
    dubFolderId: document.getElementById("sDubFolderId").value,
    enableNps: document.getElementById("sEnableNps").value === "true",
    npsDelay: parseInt(document.getElementById("sNpsDelay").value) || 30,
    stillWorkingEnabled: document.getElementById("sStillWorkingEnabled").value === "true",
    stillWorkingDelay: parseInt(document.getElementById("sStillWorkingDelay").value) || 60,
    queuePaused: document.getElementById("sPaused").value === "true",
    reviewMode: document.getElementById("sReviewMode").value,
    enableManualReview: document.getElementById("sReviewMode").value === "human",
    reviewPin: document.getElementById("sReviewPin").value,
    variantsPerReview: parseInt(document.getElementById("sVariantsPerReview").value) || 1,
    regenerationLimit: parseInt(document.getElementById("sRegenerationLimit").value) || 2,
    aiReviewChecks: {
      likeness: document.getElementById("aiCheckLikeness").checked,
      subjectCount: document.getElementById("aiCheckSubjectCount").checked,
      gender: document.getElementById("aiCheckGender").checked,
      branding: document.getElementById("aiCheckBranding").checked,
      accessories: document.getElementById("aiCheckAccessories").checked,
      anatomy: document.getElementById("aiCheckAnatomy").checked,
    },
    breakMessage: document.getElementById("sBreakMessage").value,
    photoBookAutoplay: document.getElementById("sPhotoBookAutoplay").value === "true",
    photoBookInterval: parseInt(document.getElementById("sPhotoBookInterval").value) || 10,
    revealAnimation: document.getElementById("sRevealAnimation").value,
    milestonesEnabled: document.getElementById("sMilestonesEnabled").value === "true",
    milestoneInterval: parseInt(document.getElementById("sMilestoneInterval").value) || 100,
    enablePrinting: document.getElementById("sEnablePrinting").value === "true",
    immediateDigitalDelivery: document.getElementById("sImmediateDigitalDelivery").checked,
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
    multiSubjectMode: document.getElementById("sMultiSubjectMode").value,
    backgroundChoices: _backgroundChoices,
    customBrands: _customBrands,
    enableBrandMenu: document.getElementById("sEnableBrandMenu").value === "true",
    disabledBrands: _disabledBrands,
    brandPromptOverrides: _brandPromptOverrides,
  };

  try {
    var r = await fetch("/dashboard/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      var errBody = "";
      try { errBody = await r.text(); } catch(_) {}
      throw new Error("Server returned " + r.status + (errBody ? ": " + errBody.substring(0, 200) : ""));
    }
    _settings = await r.json();
    // Re-sync arrays from server response to catch any validation changes
    _backgroundChoices = _settings.backgroundChoices || [];
    _customStyles = Object.assign({}, _settings.customStyles || {});
    _customBrands = Object.assign({}, _settings.customBrands || {});
    showBanner("Settings saved — changes are live.", "success");
    return true;
  } catch(e) { alert("Failed to save settings: " + e.message); return false; }
}

async function resetSettings() {
  var typed = await twModal.prompt({
    title: "Reset ALL settings to factory defaults?",
    message: "This wipes every setting — yours and global — and affects the live pipeline immediately. Custom styles, brands, scenes, prompts, API keys, and event config will all revert. This cannot be undone. Type RESET to confirm.",
    placeholder: "Type RESET",
    confirmText: "Reset everything",
    danger: true,
    validate: function(v) {
      if ((v || "").trim() !== "RESET") return "You must type RESET (all caps) to confirm.";
      return null;
    },
  });
  if (typed === null) return;
  try {
    var r = await fetch("/dashboard/api/settings/reset-all", { method: "POST" });
    _settings = await r.json();
    _adminPhones = (_settings.adminPhones || []).slice();
    _customStyles = Object.assign({}, _settings.customStyles || {});
    _stylePromptOverrides = Object.assign({}, _settings.stylePromptOverrides || {});
    _allStyleRefFiles = [];
    _allBgRefFiles = [];
    _customBrands = Object.assign({}, _settings.customBrands || {});
    _disabledBrands = (_settings.disabledBrands || []).slice();
    _brandPromptOverrides = Object.assign({}, _settings.brandPromptOverrides || {});
    _enableBrandMenu = !!_settings.enableBrandMenu;
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
      var n = d && d.count ? d.count : 0;
      if (n > 0) {
        txt.textContent = n + " image" + (n === 1 ? "" : "s") + " pending review";
        el.style.display = "flex";
      } else {
        el.style.display = "none";
      }
      // Screen-edge pulsing glow: shared across all admin pages so if you're
      // scrolled past the banner you still get a peripheral-vision signal
      // that a photo is waiting. Toggled on body so the CSS in
      // twilio-brand.css can drive the animation without per-page duplication.
      document.body.classList.toggle("review-pending", n > 0);
    }).catch(function(){});
  }
  poll();
  setInterval(poll, 5000);
})();

function toggleTheme() {
  var html = document.documentElement;
  var current = html.getAttribute('data-theme') || 'dark';
  var next = current === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  localStorage.setItem('twilio-theme', next);
  var label = document.getElementById('themeLabel');
  if (label) label.textContent = next === 'dark' ? 'Light mode' : 'Dark mode';
}
</script>
${userBarSnippet()}
</body>
</html>`;
} // end buildHomeHtml

function buildVideoHtml() {
const videoFile = settings.get("videoFile");
if (!videoFile) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0}html,body{background:#000;width:100%;height:100%}</style></head><body></body></html>`;
}
const termsUrl = settings.get("termsUrl") || "";
return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/assets/icon-twilio-bug-red.svg">
<title>Get Started — Twilio Photobooth</title>
<style>
  @font-face { font-family: 'Twilio Sans Text'; src: url('/assets/fonts/TwilioSansText-Regular.otf') format('opentype'); font-weight: 400; font-style: normal; font-display: swap; }

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
    font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    font-size: 12px; font-weight: 400; cursor: pointer; user-select: none;
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
    font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    font-size: 10px; color: rgba(255,255,255,0.2); text-align: center;
  }
  .bottom-bar {
    display: none; flex-shrink: 0; justify-content: center;
    padding: clamp(6px,1vh,12px) 0 clamp(10px,1.4vh,18px);
  }
  .bottom-bar.visible { display: flex; }
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
  <video id="vid" autoplay loop muted playsinline src="/booth-uploads/${encodeURIComponent(videoFile)}"></video>
  <div class="bottom-bar" id="bottomBar"></div>
  ${termsUrl ? `<div class="terms-notice">By participating, you agree to our terms of service: ${termsUrl.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}</div>` : ""}
</div>
` + brb.overlayHtml() + `
<script>
${brb.BRB_OVERLAY_SCRIPT}
var v = document.getElementById("vid");
v.play().catch(function() {});

// In combo iframe: move Play/Pause to bottom bar (aligns with photo book controls)
if (window.self !== window.top) {
  document.getElementById("topBar").style.display = "none";
  var bb = document.getElementById("bottomBar");
  bb.classList.add("visible");
  bb.appendChild(document.getElementById("playBtn"));
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
    const escHtml = (s) => String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
    const eventName = escHtml(settings.get("eventName") || "");
    const breakMsg = escHtml(settings.get("breakMessage") || "");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/assets/icon-twilio-bug-red.svg">
<title>Break - ${eventName}</title>
<style>
  @font-face { font-family: 'Twilio Sans Text'; src: url('/assets/fonts/TwilioSansText-Regular.otf') format('opentype'); font-weight: 400; font-style: normal; font-display: swap; }
  @font-face { font-family: 'Twilio Sans Display'; src: url('/assets/fonts/TwilioSansDisplay-Extrabold.otf') format('opentype'); font-weight: 800; font-style: normal; font-display: swap; }

  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: #000D25; }

  /* Animated gradient orbs */
  body::before, body::after {
    content: ''; position: fixed; border-radius: 50%; filter: blur(120px); opacity: .35;
    animation: brbFloat 8s ease-in-out infinite alternate;
  }
  body::before {
    width: 60vmax; height: 60vmax; top: -20%; left: -15%;
    background: radial-gradient(circle, #EF223A 0%, transparent 70%);
  }
  body::after {
    width: 50vmax; height: 50vmax; bottom: -20%; right: -15%;
    background: radial-gradient(circle, #2188EF 0%, transparent 70%);
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
    font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
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
    font-family: 'Twilio Sans Display', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    font-size: clamp(48px, 7vw, 96px); font-weight: 800; letter-spacing: 0.02em;
    line-height: 1; margin-bottom: 20px;
    background: linear-gradient(135deg, #fff 0%, rgba(255,255,255,.6) 100%);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    background-clip: text;
  }
  .event {
    font-size: clamp(16px, 2.5vw, 28px); font-weight: 400;
    color: rgba(255,255,255,.35); margin-bottom: 20px; letter-spacing: .5px;
  }
  .msg {
    font-size: clamp(15px, 1.8vw, 22px); color: rgba(255,255,255,.25);
    max-width: 520px; line-height: 1.6;
  }
  .dots { margin-top: 48px; display: flex; gap: 10px; }
  .dots span {
    width: 8px; height: 8px; border-radius: 50%; background: #EF223A;
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
  <script>
    if (navigator.wakeLock) { navigator.wakeLock.request("screen").catch(function() {}); }
  </script>
</body>
</html>`;
} // end buildBreakHtml

function buildStaticPanelHtml() {
const esc = (s) => String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const headline = settings.get("boothHeadline") || "Get Your AI Portrait";
const subline = settings.get("boothSubline") || "";
const qrImage = settings.get("boothQrImage") || "";
const stepsArr = settings.get("boothSteps");
const steps = (stepsArr && stepsArr.length) ? stepsArr : [settings.get("boothStep1"), settings.get("boothStep2"), settings.get("boothStep3")].filter(Boolean);
const legalText = settings.get("boothLegalText") || "";
const termsUrl = settings.get("termsUrl") || "";
const showSms = settings.get("boothShowSmsInstructions") !== false;
const smsText = settings.get("boothSmsInstructionText") || "Hit send to start";
const customPhone = settings.get("boothSmsPhone") || "";
const rawPhone = customPhone || settings.get("twilioPhoneNumber") || "";
// Format phone for display: +12065551234 → (206) 555-1234
const fmtPhone = rawPhone.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, "($1) $2-$3") || rawPhone;
return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script>(function(){var t=localStorage.getItem('twilio-theme')||'dark';document.documentElement.setAttribute('data-theme',t)})()</script>
<link rel="icon" type="image/svg+xml" href="/assets/icon-twilio-bug-red.svg">
<title>Get Started — Twilio Photobooth</title>
<style>
  /* Twilio Sans Display — headlines (Extrabold per brand guide) */
  @font-face { font-family: 'Twilio Sans Display'; src: url('/assets/fonts/TwilioSansDisplay-Extrabold.otf') format('opentype'); font-weight: 800; font-style: normal; font-display: swap; }
  /* Twilio Sans Text — body copy */
  @font-face { font-family: 'Twilio Sans Text'; src: url('/assets/fonts/TwilioSansText-Regular.otf') format('opentype'); font-weight: 400; font-style: normal; font-display: swap; }
  @font-face { font-family: 'Twilio Sans Text'; src: url('/assets/fonts/TwilioSansText-Bold.otf') format('opentype'); font-weight: 700; font-style: normal; font-display: swap; }
  /* Twilio Sans Mono — step numbers */
  @font-face { font-family: 'Twilio Sans Mono'; src: url('/assets/fonts/TwilioSansMono-Bold.otf') format('opentype'); font-weight: 700; font-style: normal; font-display: swap; }

  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: #000D25; color: #fff; font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }

  .scene {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    height: 100vh; padding: 2rem 2.5rem; text-align: center; position: relative;
    overflow: hidden; /* panel auto-scales via JS to always fit */
  }
  /* Subtle Twilio Red radial glow — brand energy */
  .scene::before {
    content: ''; position: absolute; inset: 0; z-index: 0; pointer-events: none;
    background: radial-gradient(ellipse 60% 50% at 50% 25%, rgba(239,34,58,0.07) 0%, transparent 70%),
                radial-gradient(ellipse 80% 40% at 50% 100%, rgba(239,34,58,0.03) 0%, transparent 60%);
  }

  .panel { position: relative; z-index: 1; max-width: 600px; width: 100%; }

  /* Twilio bug mark */
  .logo { margin-bottom: 1.75rem; }
  .logo img { width: 3.5rem; height: 3.5rem; }

  /* Display Extrabold — brand headline style, +2% letter-spacing, 100% line-height */
  .headline {
    font-family: 'Twilio Sans Display', 'Twilio Sans Text', sans-serif;
    font-size: clamp(2rem, 5vw, 2.75rem); font-weight: 800; line-height: 1.05;
    margin-bottom: 0.75rem; letter-spacing: 0.02em; color: #fff;
    overflow-wrap: break-word; word-wrap: break-word;
  }

  /* Text Regular — uppercase subline (eyebrow style) */
  .subline {
    font-family: 'Twilio Sans Text', sans-serif;
    font-size: 1.1rem; font-weight: 400; color: rgba(255,255,255,0.5);
    margin-bottom: 2.25rem; text-transform: uppercase; letter-spacing: 0.05em;
    line-height: 1.2;
  }

  /* QR code in builder-shape-inspired container with rounded corners */
  .qr-frame { position: relative; display: inline-block; margin-bottom: 2rem; }
  .qr-wrap {
    background: #fff; border-radius: 1.75rem; padding: 1.5rem;
    display: inline-block; position: relative; z-index: 1;
    box-shadow: 0 0 60px rgba(239,34,58,0.12), 0 0 120px rgba(239,34,58,0.04);
  }
  .qr-wrap img { width: 220px; height: 220px; object-fit: contain; display: block; }
  .qr-placeholder { width: 220px; height: 220px; display: flex; align-items: center; justify-content: center; color: #999; font-size: 14px; font-family: 'Twilio Sans Text', sans-serif; }

  /* SMS fallback instructions */
  .sms-fallback {
    margin-bottom: 2rem; text-align: center;
    font-family: 'Twilio Sans Text', sans-serif; color: rgba(255,255,255,0.65);
    font-size: 0.95rem; line-height: 1.5;
  }
  .sms-fallback .or-divider {
    font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.1em;
    color: rgba(255,255,255,0.3); margin-bottom: 0.6rem;
  }
  .sms-fallback .sms-phone {
    font-family: 'Twilio Sans Mono', monospace; font-weight: 700;
    color: #fff; font-size: 1.1rem;
  }
  .sms-fallback .sms-msg {
    color: rgba(255,255,255,0.5); font-style: italic;
  }

  /* Draft line corner accents — inspired by brand technical drawings */
  .draft-corner {
    position: absolute; width: 32px; height: 32px; z-index: 0;
  }
  .draft-corner svg { width: 100%; height: 100%; }
  .draft-tl { top: -8px; left: -8px; }
  .draft-tr { top: -8px; right: -8px; transform: scaleX(-1); }
  .draft-bl { bottom: -8px; left: -8px; transform: scaleY(-1); }
  .draft-br { bottom: -8px; right: -8px; transform: scale(-1,-1); }

  /* Steps — Mono Bold numbers, Text Regular descriptions */
  .steps { text-align: left; margin: 0 auto 1.5rem; max-width: 420px; }
  .step { display: flex; align-items: center; gap: 1rem; margin-bottom: 1rem; }
  .step-num {
    width: 2.5rem; height: 2.5rem; border-radius: 50%; flex-shrink: 0;
    background: rgba(239,34,58,0.12); color: #EF223A;
    display: flex; align-items: center; justify-content: center;
    font-family: 'Twilio Sans Mono', monospace; font-size: 0.95rem; font-weight: 700;
  }
  .step-text {
    font-family: 'Twilio Sans Text', sans-serif;
    font-size: 1rem; font-weight: 400; color: rgba(255,255,255,0.85); line-height: 1.4;
  }

  /* Legal — Text Regular, Twilio Red for visibility */
  .legal {
    font-family: 'Twilio Sans Text', sans-serif;
    font-size: 0.95rem; color: rgba(239,34,58,0.7); line-height: 1.6;
    max-width: 480px; margin: 1.5rem auto 0;
  }
  .legal a { color: #EF223A; text-decoration: underline; }

  /* Top bar controls */
  .top-bar {
    position: fixed; top: 0; right: 0; display: flex; align-items: center; gap: 6px;
    padding: 10px 16px; z-index: 5;
  }
  .top-btn {
    background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
    border-radius: 8px; padding: 6px 14px; color: rgba(255,255,255,0.55);
    font-family: 'Twilio Sans Text', sans-serif;
    font-size: 12px; font-weight: 700; cursor: pointer; user-select: none;
    display: flex; align-items: center; gap: 6px; transition: all .2s;
  }
  .top-btn:hover { color: rgba(255,255,255,0.85); background: rgba(255,255,255,0.1); }
  .top-btn svg { width: 14px; height: 14px; }

  /* Responsive — scale up for large booth monitors */
  @media (min-width: 1280px) {
    .panel { max-width: 680px; }
    .headline { font-size: clamp(2.5rem, 4vw, 3.25rem); }
    .subline { font-size: 1.25rem; }
    .qr-wrap img, .qr-placeholder { width: 260px; height: 260px; }
    .step-num { width: 2.75rem; height: 2.75rem; }
    .sms-fallback { font-size: 1.05rem; }
    .sms-fallback .sms-phone { font-size: 1.2rem; }
    .draft-corner { width: 40px; height: 40px; }
    .draft-tl { top: -10px; left: -10px; }
    .draft-tr { top: -10px; right: -10px; }
    .draft-bl { bottom: -10px; left: -10px; }
    .draft-br { bottom: -10px; right: -10px; }
  }
  @media (min-width: 1920px) {
    .panel { max-width: 760px; }
    .headline { font-size: clamp(3rem, 4vw, 4rem); }
    .subline { font-size: 1.4rem; }
    .qr-wrap img, .qr-placeholder { width: 320px; height: 320px; }
    .sms-fallback { font-size: 1.15rem; }
    .sms-fallback .sms-phone { font-size: 1.3rem; }
    .step-num { width: 3rem; height: 3rem; }
    .draft-corner { width: 48px; height: 48px; }
    .draft-tl { top: -12px; left: -12px; }
    .draft-tr { top: -12px; right: -12px; }
    .draft-bl { bottom: -12px; left: -12px; }
    .draft-br { bottom: -12px; right: -12px; }
  }
  ${brb.BRB_OVERLAY_CSS}
</style>
</head>
<body>
<div class="top-bar">
  <div class="top-btn" id="brbBtn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="10" y1="15" x2="10" y2="9"/><line x1="14" y1="15" x2="14" y2="9"/></svg><span>BRB</span></div>
  <div class="top-btn" id="fsBtn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg><span>Fullscreen</span></div>
</div>
<div class="scene">
  <div class="panel">
    <div class="logo"><img src="/assets/icon-twilio-bug-red.svg" alt="Twilio"></div>
    <div class="headline">${esc(headline)}</div>
    ${subline ? `<div class="subline">${esc(subline)}</div>` : ""}
    <div class="qr-frame">
      <div class="draft-corner draft-tl"><svg viewBox="0 0 32 32" fill="none"><path d="M2 30 L2 12 Q2 2 12 2 L30 2" stroke="rgba(239,34,58,0.3)" stroke-width="1.5" fill="none"/><circle cx="2" cy="2" r="3" fill="none" stroke="rgba(239,34,58,0.2)" stroke-width="1"/></svg></div>
      <div class="draft-corner draft-tr"><svg viewBox="0 0 32 32" fill="none"><path d="M2 30 L2 12 Q2 2 12 2 L30 2" stroke="rgba(239,34,58,0.3)" stroke-width="1.5" fill="none"/><circle cx="2" cy="2" r="3" fill="none" stroke="rgba(239,34,58,0.2)" stroke-width="1"/></svg></div>
      <div class="draft-corner draft-bl"><svg viewBox="0 0 32 32" fill="none"><path d="M2 30 L2 12 Q2 2 12 2 L30 2" stroke="rgba(239,34,58,0.3)" stroke-width="1.5" fill="none"/><circle cx="2" cy="2" r="3" fill="none" stroke="rgba(239,34,58,0.2)" stroke-width="1"/></svg></div>
      <div class="draft-corner draft-br"><svg viewBox="0 0 32 32" fill="none"><path d="M2 30 L2 12 Q2 2 12 2 L30 2" stroke="rgba(239,34,58,0.3)" stroke-width="1.5" fill="none"/><circle cx="2" cy="2" r="3" fill="none" stroke="rgba(239,34,58,0.2)" stroke-width="1"/></svg></div>
      <div class="qr-wrap">${qrImage ? `<img src="/booth-uploads/${encodeURIComponent(qrImage)}" alt="Scan to start">` : `<div class="qr-placeholder">Upload a QR code in Settings</div>`}</div>
    </div>
    ${showSms && fmtPhone ? `<div class="sms-fallback">
      <div class="or-divider">or text us directly</div>
      <div>Text <span class="sms-phone">${esc(fmtPhone)}</span> with the message <span class="sms-msg">"${esc(smsText)}"</span></div>
    </div>` : ""}
    ${steps.length ? `<div class="steps">${steps.map((t, i) => `<div class="step"><div class="step-num">${i + 1}</div><div class="step-text">${esc(t)}</div></div>`).join("")}</div>` : ""}
    ${legalText || termsUrl ? `<div class="legal">${esc(legalText)}${termsUrl ? ` <a href="${esc(termsUrl)}" target="_blank" rel="noopener">${esc(termsUrl)}</a>` : ""}</div>` : ""}
  </div>
</div>
` + brb.overlayHtml() + `
<script>
${brb.BRB_OVERLAY_SCRIPT}
document.getElementById("brbBtn").addEventListener("click", function() { toggleBrb(); });
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
// Hide top bar when embedded in combo iframe
if (window.self !== window.top) {
  document.querySelector(".top-bar").style.display = "none";
}

// Auto-scale panel to fit viewport when content is too tall
(function autoScale() {
  var panel = document.querySelector(".panel");
  if (!panel) return;
  function fit() {
    panel.style.transform = "none";
    var vh = window.innerHeight;
    var pad = 4 * parseFloat(getComputedStyle(document.documentElement).fontSize); // 2rem top + 2rem bottom
    var avail = vh - pad;
    var natural = panel.scrollHeight;
    if (natural > avail) {
      var s = avail / natural;
      panel.style.transform = "scale(" + s + ")";
      panel.style.transformOrigin = "center center";
    }
  }
  fit();
  window.addEventListener("resize", fit);
  // Re-check after fonts load
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(fit);
  }
})();
</script>
</body>
</html>`;
}

function buildComboHtml() {
const mode = settings.get("boothDisplayMode") || "video";
const videoFile = settings.get("videoFile");
const fsOverlay = `<div id="fsOverlay" style="position:fixed;inset:0;z-index:999;background:#000D25;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-direction:column;gap:16px">
<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#EF223A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
<span style="color:#fff;font-family:system-ui,sans-serif;font-size:18px;font-weight:600">Click anywhere to enter fullscreen</span>
<span style="color:#656E87;font-family:system-ui,sans-serif;font-size:13px">Press Esc to exit fullscreen</span>
</div>
<script>document.getElementById("fsOverlay").addEventListener("click",function(){document.documentElement.requestFullscreen().then(function(){document.getElementById("fsOverlay").remove()}).catch(function(){document.getElementById("fsOverlay").remove()})})</script>`;
const fullWidthBook = `<!DOCTYPE html>
<html lang="en" data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script>(function(){var t=localStorage.getItem('twilio-theme')||'dark';document.documentElement.setAttribute('data-theme',t)})()</script>
<link rel="icon" type="image/svg+xml" href="/assets/icon-twilio-bug-red.svg">
<title>Booth Display — Twilio Photobooth</title>
<style>*{margin:0;padding:0}html,body{width:100%;height:100%;overflow:hidden;background:#000}iframe{width:100%;height:100%;border:none}</style>
</head><body><iframe src="/photogallery/" allow="fullscreen" allowfullscreen></iframe>
${fsOverlay}
</body></html>`;
if (mode === "none") return fullWidthBook;
if (mode === "video" && !videoFile) return fullWidthBook;
const leftSrc = mode === "static" ? "/home/panel" : "/home/video";
return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script>(function(){var t=localStorage.getItem('twilio-theme')||'dark';document.documentElement.setAttribute('data-theme',t)})()</script>
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
  <iframe id="leftPane" src="${leftSrc}" allow="autoplay; fullscreen" allowfullscreen></iframe>
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
${fsOverlay}
</body>
</html>`;
}

function mountHome(app) {
    app.use("/templates", express.static(path.join(__dirname, "..", "templates")));
    app.use("/brand-references", express.static(path.join(__dirname, "..", "brand-references")));
    app.use("/style-references", express.static(path.join(__dirname, "..", "style-references")));
    app.use("/background-references", express.static(path.join(__dirname, "..", "background-references")));
    app.use("/booth-uploads", express.static(path.join(__dirname, "..", "booth-uploads")));
    app.use("/assets", express.static(ASSETS_DIR));
    app.use("/home", router);
    console.log("🏠 Home page mounted at /home");
}

module.exports = { mountHome };
