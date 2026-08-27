const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const express = require("express");
const sharp = require("sharp");

const settings = require("../lib/settings");
const { mountShare } = require("../lib/share");

const EVENT = "Final Image Routing Test";
const PREFIX = "29991231_235951";
const eventDir = settings.getDownloadDir(EVENT);

function get(app, requestPath) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
            http.get({ port: server.address().port, path: requestPath }, (res) => {
                const chunks = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () => {
                    server.close();
                    resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
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
    }).png().toFile(`${eventDir}/${PREFIX}_output.png`);
    await sharp({
        create: { width: 800, height: 533, channels: 3, background: "#336699" },
    }).jpeg().toFile(`${eventDir}/${PREFIX}_output_mms.jpg`);
});

after(() => {
    fs.rmSync(eventDir, { recursive: true, force: true });
    setImmediate(() => process.exit(0));
});

test("share image route serves the final PNG", async () => {
    const app = express();
    mountShare(app);
    const response = await get(app, `/s/${PREFIX}/img?e=${encodeURIComponent(EVENT)}`);
    const metadata = await sharp(response.body).metadata();

    assert.equal(response.status, 200);
    assert.match(response.headers["content-type"], /^image\/png/);
    assert.match(response.headers["content-disposition"], /_output\.png/);
    assert.equal(metadata.width, 1800);
    assert.equal(metadata.height, 1200);
});

test("MMS route alone serves the compressed JPEG", async () => {
    const app = express();
    mountShare(app);
    const response = await get(app, `/s/${PREFIX}/mms?e=${encodeURIComponent(EVENT)}`);
    const metadata = await sharp(response.body).metadata();

    assert.equal(response.status, 200);
    assert.match(response.headers["content-type"], /^image\/jpeg/);
    assert.match(response.headers["content-disposition"], /_output_mms\.jpg/);
    assert.equal(metadata.width, 800);
    assert.equal(metadata.height, 533);
});
