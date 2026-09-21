const express = require("express");
const settings = require("./settings");
const ui = require("./ui-i18n");
const { buildChannelLaunchPath, buildChannelOptions, isValidEventName, resolveEventLocale } = require("./channel-entry");

function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[char]));
}

function safeHttpUrl(value) {
    try {
        const url = new URL(String(value || ""));
        return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
    } catch {
        return "";
    }
}

function channelIcon(channel) {
    const src = channel.id === "sms" ? "/assets/icon-sms.svg" : "/assets/icon-phone-chat.svg";
    return `<span class="channel-icon ${channel.id}"><img src="${src}" alt=""></span>`;
}

function buildAttendeeStartHtml({ eventName, locale, languageMode, channels, legalText, termsUrl }) {
    const availableChannels = channels.filter((channel) => channel.enabled && channel.href);
    const safeTermsUrl = safeHttpUrl(termsUrl);
    const channelCards = availableChannels.map((channel) => `
      <a class="channel-card channel-${channel.id}" href="${escapeHtml(channel.launchHref || channel.href)}">
        ${channelIcon(channel)}
        <span class="channel-copy">
          <strong>${escapeHtml(channel.title)}</strong>
          <span>${escapeHtml(channel.description)}</span>
        </span>
        <svg class="channel-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
      </a>`).join("");
    const languagePicker = languageMode === "ask" ? `
      <nav class="language-picker" aria-label="${escapeHtml(ui.t(locale, "language"))}">
        <a href="/start?event=${encodeURIComponent(eventName)}&amp;lang=en"${locale === "en" ? ' aria-current="page"' : ""}>English</a>
        <a href="/start?event=${encodeURIComponent(eventName)}&amp;lang=pt_BR"${locale === "pt_BR" ? ' aria-current="page"' : ""}>Português</a>
      </nav>` : "";
    const themeLabel = escapeHtml(ui.t(locale, "theme"));
    const themeButton = `<button type="button" class="theme-control" id="startThemeBtn" aria-label="${themeLabel}" title="${themeLabel}" onclick="(function(){var h=document.documentElement;var c=h.getAttribute('data-theme')||'dark';var n=c==='dark'?'light':'dark';h.setAttribute('data-theme',n);localStorage.setItem('twilio-theme',n)})()">
      <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/></svg>
      <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
      <span>${themeLabel}</span>
    </button>`;

    return `<!DOCTYPE html>
<html lang="${ui.htmlLang(locale)}" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script>(function(){var t=localStorage.getItem('twilio-theme')||'dark';document.documentElement.setAttribute('data-theme',t)})()</script>
<link rel="icon" type="image/svg+xml" href="/assets/icon-twilio-bug-red.svg">
<link rel="stylesheet" href="/assets/twilio-brand.css">
<title>${escapeHtml(ui.t(locale, "chooseChannelTitle"))} — Twilio Photobooth</title>
<style>
  * { box-sizing: border-box; }
  body { min-height: 100vh; margin: 0; color: var(--th-text); }
  body::before { content: ""; position: fixed; inset: 0; pointer-events: none; background: radial-gradient(circle at 50% 0%, rgba(239,34,58,.12), transparent 42%), radial-gradient(circle at 100% 100%, rgba(33,136,239,.08), transparent 38%); }
  .page { position: relative; z-index: 1; width: min(100%, 600px); min-height: 100vh; margin: 0 auto; padding: 56px 24px 36px; display: flex; flex-direction: column; justify-content: center; }
  .theme-wrap { position: fixed; z-index: 3; top: 14px; right: 14px; }
  .theme-control { display: inline-flex; align-items: center; gap: 7px; padding: 8px 11px; border: 1px solid var(--th-card-border); border-radius: 10px; background: var(--th-card); color: var(--th-text-dim); font-size: 12px; font-weight: 700; cursor: pointer; user-select: none; }
  .theme-control:hover { color: var(--th-text); background: var(--th-raised); }
  .theme-control svg { display: none; width: 14px; height: 14px; }
  html[data-theme="dark"] .theme-control .icon-sun { display: block; }
  html[data-theme="light"] .theme-control .icon-moon { display: block; }
  .brand { width: 52px; height: 52px; margin-bottom: 30px; }
  .eyebrow { margin-bottom: 14px; color: var(--red-400); font-family: 'Twilio Sans Mono', monospace; font-size: 12px; font-weight: 700; line-height: 1.4; text-transform: uppercase; }
  h1 { margin: 0; font-size: clamp(36px, 10vw, 56px); line-height: 1; }
  .intro { margin: 18px 0 30px; color: var(--th-text-dim); font-size: 17px; line-height: 1.5; }
  .channel-list { display: grid; gap: 14px; }
  .channel-card { min-height: 94px; display: flex; align-items: center; gap: 16px; padding: 16px; border: 1px solid var(--th-card-border); border-radius: 18px; background: var(--th-card); color: var(--th-text); text-decoration: none; box-shadow: 0 10px 30px var(--th-card-shadow); transition: transform .16s ease, border-color .16s ease, background .16s ease; }
  .channel-card:hover, .channel-card:focus-visible { transform: translateY(-2px); border-color: var(--blue-400); background: var(--th-card-hover); outline: none; }
  .channel-sms:hover, .channel-sms:focus-visible { border-color: var(--red-400); }
  .channel-icon { width: 58px; height: 58px; flex: 0 0 58px; display: grid; place-items: center; border-radius: 16px; }
  .channel-icon img { width: 34px; height: 34px; }
  .channel-icon.sms { background: rgba(239,34,58,.12); }
  .channel-icon.sms img { filter: brightness(0) saturate(100%) invert(42%) sepia(90%) saturate(4000%) hue-rotate(340deg) brightness(105%); }
  .channel-icon.whatsapp { background: rgba(33,136,239,.12); }
  .channel-icon.whatsapp img { filter: brightness(0) saturate(100%) invert(35%) sepia(90%) saturate(2000%) hue-rotate(200deg) brightness(110%); }
  .channel-copy { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 4px; }
  .channel-copy strong { font-size: 17px; line-height: 1.3; }
  .channel-copy span { color: var(--th-text-dim); font-size: 14px; line-height: 1.35; }
  .channel-arrow { width: 22px; height: 22px; flex: 0 0 22px; color: var(--th-text-muted); }
  .next-step { margin: 26px 0 0; padding-left: 16px; border-left: 3px solid var(--red-450); color: var(--th-text-secondary); font-size: 14px; line-height: 1.5; }
  .empty { padding: 24px; border: 1px solid var(--th-card-border); border-radius: 18px; color: var(--th-text-dim); background: var(--th-card); text-align: center; }
  .language-picker { display: flex; justify-content: center; gap: 8px; margin-top: 28px; }
  .language-picker a { padding: 7px 11px; border-radius: 999px; color: var(--th-text-dim); font-size: 12px; font-weight: 700; text-decoration: none; }
  .language-picker a[aria-current="page"] { background: var(--th-raised); color: var(--th-text); }
  .legal { margin-top: 26px; color: var(--th-text-muted); font-size: 12px; line-height: 1.5; text-align: center; }
  .legal a { color: var(--blue-300); }
  @media (max-width: 420px) { .page { padding-inline: 18px; } .theme-control span { display: none; } }
</style>
</head>
<body>
<div class="theme-wrap">${themeButton}</div>
<main class="page">
  <img class="brand" src="/assets/icon-twilio-bug-red.svg" alt="Twilio">
  <div class="eyebrow">${escapeHtml(ui.t(locale, "eventLabel", { eventName }))}</div>
  <h1>${escapeHtml(ui.t(locale, "chooseChannelTitle"))}</h1>
  <p class="intro">${escapeHtml(ui.t(locale, "chooseChannelIntro"))}</p>
  <div class="channel-list">${channelCards || `<div class="empty">${escapeHtml(ui.t(locale, "noChannel"))}</div>`}</div>
  ${channelCards ? `<p class="next-step">${escapeHtml(ui.t(locale, "chooserNextStep"))}</p>` : ""}
  ${languagePicker}
  ${legalText || safeTermsUrl ? `<div class="legal">${escapeHtml(legalText)}${safeTermsUrl ? ` <a href="${escapeHtml(safeTermsUrl)}" target="_blank" rel="noopener">${escapeHtml(safeTermsUrl)}</a>` : ""}</div>` : ""}
</main>
</body>
</html>`;
}

function createAttendeeStartRouter({ settingsModule = settings } = {}) {
    const router = express.Router();
    router.get("/open", (req, res) => {
        const eventQuery = req.query.event;
        const channel = req.query.channel;
        if (typeof eventQuery !== "string" || !isValidEventName(eventQuery) || !["sms", "whatsapp"].includes(channel)) {
            return res.status(400).type("text").send("Invalid launch request");
        }
        if (eventQuery !== settingsModule.get("eventName")) {
            return res.status(404).type("text").send("Event not found");
        }

        const getSetting = (key) => settingsModule.get(key);
        const locale = resolveEventLocale(getSetting, req.query.lang);
        const channelMap = buildChannelOptions({ locale, getSetting, carryLocale: req.query.carry === "1" });
        const selected = channelMap[channel];
        if (!selected.enabled || !selected.href) return res.status(404).type("text").send("Channel not available");

        const userAgent = String(req.get("user-agent") || "");
        const destination = channel === "sms" && /iPad|iPhone|iPod|Macintosh.*Mobile/i.test(userAgent)
            ? selected.iosHref
            : selected.href;
        res.set({ "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" });
        return res.redirect(302, destination);
    });

    router.get("/", (req, res) => {
        const eventQuery = req.query.event;
        if (typeof eventQuery !== "string" || !isValidEventName(eventQuery)) {
            return res.status(400).type("text").send("Invalid or missing event");
        }
        if (eventQuery !== settingsModule.get("eventName")) {
            return res.status(404).type("text").send("Event not found");
        }

        const getSetting = (key) => settingsModule.get(key);
        const locale = resolveEventLocale(getSetting, req.query.lang);
        const channelMap = buildChannelOptions({ locale, getSetting, carryLocale: true });
        const channels = [channelMap.sms, channelMap.whatsapp]
            .filter((channel) => channel.enabled && channel.href)
            .map((channel) => ({
                ...channel,
                launchHref: buildChannelLaunchPath(eventQuery, locale, channel.id, true),
            }));
        const html = buildAttendeeStartHtml({
            eventName: eventQuery,
            locale,
            languageMode: getSetting("languageMode"),
            channels,
            legalText: getSetting("boothLegalText") || "",
            termsUrl: getSetting("termsUrl") || "",
        });
        res.set({
            "Cache-Control": "private, no-store",
            "Content-Language": ui.htmlLang(locale),
            "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
        });
        return res.status(channels.length ? 200 : 503).type("html").send(html);
    });
    return router;
}

const attendeeStartRouter = createAttendeeStartRouter();

module.exports = { attendeeStartRouter, buildAttendeeStartHtml, createAttendeeStartRouter };
