const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const express = require("express");
const sharp = require("sharp");

const settings = require("../lib/settings");
const { mountPhotoGallery } = require("../lib/photogallery");

const EVENT = "__landscape_gallery_test__";
const PREFIX = "29991231_235954";
const eventDir = settings.getDownloadDir(EVENT);

function get(app, requestPath) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
            http.get({ port: server.address().port, path: requestPath }, (res) => {
                let body = "";
                res.on("data", (chunk) => body += chunk);
                res.on("end", () => {
                    server.close();
                    resolve({ status: res.statusCode, body, type: res.headers["content-type"] });
                });
            }).on("error", (err) => {
                server.close();
                reject(err);
            });
        });
    });
}

before(async () => {
    fs.mkdirSync(eventDir, { recursive: true });
    await sharp({
        create: { width: 1800, height: 1200, channels: 3, background: "#336699" },
    }).png().toFile(path.join(eventDir, `${PREFIX}_output.png`));
});

after(() => {
    fs.rmSync(eventDir, { recursive: true, force: true });
    // Importing the gallery pulls in the messaging chain, which leaves a
    // keep-alive handle open in tests. Match the existing dashboard test.
    setImmediate(() => process.exit(0));
});

test("gallery infers landscape orientation when legacy job metadata is absent", async () => {
    const app = express();
    mountPhotoGallery(app);

    const response = await get(app, `/photogallery/api/images?event=${EVENT}`);
    const payload = JSON.parse(response.body);

    assert.equal(response.status, 200);
    assert.equal(payload.images.length, 1);
    assert.equal(payload.images[0].file, `${PREFIX}_output.png`);
    assert.equal(payload.images[0].orientation, "landscape");
});

test("gallery page reuses landscape ratio and rebuilds when metadata changes", async () => {
    const app = express();
    mountPhotoGallery(app);

    const response = await get(app, "/photogallery/?event=" + EVENT);

    assert.equal(response.status, 200);
    assert.match(response.type, /^text\/html/);
    assert.match(response.body, /function getBookRatio\(\)/);
    assert.equal((response.body.match(/var size = getBookSize\(w, h\);/g) || []).length, 2);
    assert.match(response.body, /imageRenderSignature\(nextImages\) !== oldSignature/);
});
