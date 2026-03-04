const express = require("express");
const { EVENT_NAME } = require("./config");

const router = express.Router();

router.get("/", (req, res) => {
    if (!req.originalUrl.endsWith("/") && !req.originalUrl.includes("?"))
        return res.redirect(req.originalUrl + "/");
    res.type("html").send(HOME_HTML);
});

const HOME_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Twilio AI Photobooth</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { font-size: clamp(14px, 1.1vw, 18px); }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0a0c10;
    color: #e1e4e8;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .container {
    text-align: center;
    max-width: 600px;
    padding: 40px;
  }
  .logo {
    font-size: clamp(40px, 5vw, 72px);
    margin-bottom: 16px;
  }
  h1 {
    font-size: clamp(24px, 2.8vw, 42px);
    font-weight: 700;
    color: #f0f6fc;
    margin-bottom: 8px;
  }
  .event-name {
    font-size: clamp(14px, 1.4vw, 22px);
    color: #f0883e;
    font-weight: 500;
    margin-bottom: 32px;
  }
  .subtitle {
    font-size: clamp(13px, 1rem, 17px);
    color: #6e7681;
    line-height: 1.6;
    margin-bottom: 40px;
  }
  .nav-links {
    display: flex;
    gap: 16px;
    justify-content: center;
    flex-wrap: wrap;
  }
  .nav-link {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 12px 24px;
    border-radius: 10px;
    font-size: clamp(13px, 1rem, 16px);
    font-weight: 500;
    text-decoration: none;
    transition: background .15s, border-color .15s, transform .15s;
  }
  .nav-link:hover { transform: translateY(-2px); }
  .nav-link.dashboard {
    background: #12151c;
    color: #58a6ff;
    border: 1px solid #58a6ff44;
  }
  .nav-link.dashboard:hover { background: #58a6ff18; border-color: #58a6ff; }
  .footer {
    margin-top: 48px;
    font-size: clamp(11px, 0.78rem, 13px);
    color: #3d434d;
  }
</style>
</head>
<body>
<div class="container">
  <div class="logo">&#x1F4F8;</div>
  <h1>Twilio AI Photobooth</h1>
  <div class="event-name">${EVENT_NAME}</div>
  <p class="subtitle">Text a selfie to our Twilio number, pick an art style, and get a printed portrait at the booth.</p>
  <div class="nav-links">
    <a href="/dashboard/" class="nav-link dashboard">Open Dashboard</a>
  </div>
  <div class="footer">Powered by Twilio + OpenAI</div>
</div>
</body>
</html>`;

function mountHome(app) {
    app.use("/home", router);
    console.log("🏠 Home page mounted at /home");
}

module.exports = { mountHome };
