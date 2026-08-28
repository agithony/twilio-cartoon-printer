const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const express = require("express");
const settings = require("../lib/settings");
const { mountPhotoGallery, invalidatePhotoGalleryCache } = require("../lib/photogallery");
const { DONE_DIR, FAILED_DIR } = require("../lib/config");

const EVENT = "__gallery_origin_cache_test__";
const PREFIX = "29991231_235930";
const eventDir = settings.getDownloadDir(EVENT);

function get(app, requestPath) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
            http.get({ port: server.address().port, path: requestPath }, (res) => {
                let body = "";
                res.on("data", (chunk) => body += chunk);
                res.on("end", () => server.close(() => resolve({ status: res.statusCode, body, headers: res.headers })));
            }).on("error", (err) => server.close(() => reject(err)));
        });
    });
}

before(() => {
    fs.mkdirSync(eventDir, { recursive: true });
    fs.writeFileSync(path.join(eventDir, `${PREFIX}_output.png`), "not-a-real-png");
    fs.writeFileSync(path.join(eventDir, `${PREFIX}_input.jpg`), "private-selfie");
});

after(() => fs.rmSync(eventDir, { recursive: true, force: true }));

test("gallery API reuses a warm image listing", async () => {
    const app = express();
    mountPhotoGallery(app);
    const originalReaddir = fs.promises.readdir;
    let eventScans = 0;
    let terminalScans = 0;
    fs.promises.readdir = async function patchedReaddir(dir, ...args) {
        if (String(dir) === eventDir) eventScans++;
        if (String(dir) === DONE_DIR || String(dir) === FAILED_DIR) terminalScans++;
        return originalReaddir.call(this, dir, ...args);
    };

    try {
        const first = await get(app, `/photogallery/api/images?event=${EVENT}`);
        const second = await get(app, `/photogallery/api/images?event=${EVENT}`);
        assert.equal(first.status, 200);
        assert.equal(second.status, 200);
        assert.equal(JSON.parse(second.body).images.length, 1);
        assert.equal(eventScans, 1);
        assert.equal(terminalScans, 0);
    } finally {
        fs.promises.readdir = originalReaddir;
    }
});

test("gallery invalidation refreshes a changed image listing", async () => {
    const app = express();
    mountPhotoGallery(app);
    await get(app, `/photogallery/api/images?event=${EVENT}`);
    const secondPrefix = `${PREFIX}b`;
    fs.writeFileSync(path.join(eventDir, `${secondPrefix}_output.png`), "another-output");
    invalidatePhotoGalleryCache(EVENT);

    const refreshed = await get(app, `/photogallery/api/images?event=${EVENT}`);
    assert.equal(JSON.parse(refreshed.body).images.length, 2);
    fs.unlinkSync(path.join(eventDir, `${secondPrefix}_output.png`));
    invalidatePhotoGalleryCache(EVENT);
});

test("gallery media caches outputs briefly but never caches selfies", async () => {
    const app = express();
    mountPhotoGallery(app);
    const output = await get(app, `/photogallery/img/${EVENT}/${PREFIX}_output.png`);
    const selfie = await get(app, `/photogallery/img/${EVENT}/${PREFIX}_input.jpg`);

    assert.equal(output.headers["cache-control"], "public, max-age=0, must-revalidate");
    assert.equal(selfie.headers["cache-control"], "private, no-store");
});
