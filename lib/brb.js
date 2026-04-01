const settings = require("./settings");

const BRB_OVERLAY_CSS = `
  @font-face { font-family: 'Twilio Sans Text'; src: url('/assets/fonts/TwilioSansText-Regular.otf') format('opentype'); font-weight: 400; font-style: normal; font-display: swap; }
  @font-face { font-family: 'Twilio Sans Display'; src: url('/assets/fonts/TwilioSansDisplay-Extrabold.otf') format('opentype'); font-weight: 800; font-style: normal; font-display: swap; }

  #brbOverlay {
    position: fixed; inset: 0; z-index: 9999;
    display: none; align-items: center; justify-content: center;
    background: #000D25;
    overflow: hidden; cursor: pointer;
  }
  #brbOverlay.active { display: flex; }

  #brbOverlay::before, #brbOverlay::after {
    content: ''; position: absolute; border-radius: 50%; filter: blur(120px); opacity: .35;
    animation: brbFloat 8s ease-in-out infinite alternate;
  }
  #brbOverlay::before {
    width: 60vmax; height: 60vmax; top: -20%; left: -15%;
    background: radial-gradient(circle, #EF223A 0%, transparent 70%);
  }
  #brbOverlay::after {
    width: 50vmax; height: 50vmax; bottom: -20%; right: -15%;
    background: radial-gradient(circle, #2188EF 0%, transparent 70%);
    animation-delay: -4s; animation-direction: alternate-reverse;
  }
  @keyframes brbFloat {
    0% { transform: translate(0, 0) scale(1); }
    100% { transform: translate(5vw, -5vh) scale(1.15); }
  }

  .brb-content {
    position: relative; z-index: 1; text-align: center;
    font-family: 'Twilio Sans Text', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    animation: brbFadeIn .6s ease-out;
  }
  @keyframes brbFadeIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }

  .brb-logo {
    width: 56px; height: 56px; margin: 0 auto 36px; opacity: .6;
    animation: brbPulse 3s ease-in-out infinite;
  }
  @keyframes brbPulse { 0%,100% { opacity: .4; transform: scale(1); } 50% { opacity: .7; transform: scale(1.05); } }

  .brb-title {
    font-family: 'Twilio Sans Display', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    font-size: clamp(48px, 7vw, 96px); font-weight: 800; letter-spacing: 0.02em;
    line-height: 1; margin-bottom: 20px;
    background: linear-gradient(135deg, #fff 0%, rgba(255,255,255,.6) 100%);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    background-clip: text;
  }

  .brb-event {
    font-size: clamp(16px, 2.5vw, 28px); font-weight: 400;
    color: rgba(255,255,255,.35); margin-bottom: 20px; letter-spacing: .5px;
  }

  .brb-msg {
    font-size: clamp(15px, 1.8vw, 22px); color: rgba(255,255,255,.25);
    max-width: 520px; margin: 0 auto; line-height: 1.6;
  }

  .brb-dots {
    margin-top: 48px; display: flex; gap: 10px; justify-content: center;
  }
  .brb-dots span {
    width: 8px; height: 8px; border-radius: 50%;
    background: #EF223A;
    animation: brbDot 2s ease-in-out infinite;
  }
  .brb-dots span:nth-child(2) { animation-delay: .3s; }
  .brb-dots span:nth-child(3) { animation-delay: .6s; }
  @keyframes brbDot { 0%,100% { opacity: .15; transform: scale(.8); } 50% { opacity: .8; transform: scale(1.2); } }

  .brb-dismiss {
    position: absolute; bottom: 32px; left: 50%; transform: translateX(-50%);
    font-size: 12px; color: rgba(255,255,255,.15); font-family: 'Twilio Sans Text', sans-serif;
    letter-spacing: .5px;
  }
`;

const BRB_OVERLAY_SCRIPT = `
function toggleBrb() {
  var el = document.getElementById("brbOverlay");
  if (!el) return;
  var show = !el.classList.contains("active");
  el.classList.toggle("active", show);
  if (show) {
    fetch("/dashboard/api/settings").then(function(r) { return r.json(); }).then(function(s) {
      var msg = document.getElementById("brbMsg");
      if (msg && s.breakMessage) msg.textContent = s.breakMessage;
    }).catch(function() {});
  }
}
`;

function overlayHtml() {
    const eventName = settings.get("eventName") || "";
    const breakMsg = settings.get("breakMessage") || "";
    return `
<div id="brbOverlay" onclick="toggleBrb()">
  <div class="brb-content">
    <img class="brb-logo" src="/assets/icon-twilio-bug-red.svg" alt="">
    <div class="brb-title">We'll Be Right Back</div>
    ${eventName && eventName !== "default" ? `<div class="brb-event">${eventName}</div>` : ""}
    <div class="brb-msg" id="brbMsg">${breakMsg}</div>
    <div class="brb-dots"><span></span><span></span><span></span></div>
  </div>
  <div class="brb-dismiss">click anywhere to dismiss</div>
</div>`;
}

const BRB_BUTTON_HTML = `
<div id="brbBtn" style="background:rgba(0,0,0,0.6);border:1px solid rgba(255,255,255,0.2);border-radius:8px;padding:8px 18px;color:rgba(255,255,255,0.7);font-family:'Twilio Sans Text',sans-serif;font-size:13px;cursor:pointer;user-select:none;backdrop-filter:blur(8px);display:flex;align-items:center;gap:6px;transition:all .2s">
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="10" y1="15" x2="10" y2="9"/><line x1="14" y1="15" x2="14" y2="9"/></svg>
  <span>BRB</span>
</div>`;

module.exports = { BRB_OVERLAY_CSS, BRB_OVERLAY_SCRIPT, BRB_BUTTON_HTML, overlayHtml };
