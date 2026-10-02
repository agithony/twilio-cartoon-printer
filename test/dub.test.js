const { test } = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const settings = require("../lib/settings");
const dub = require("../lib/dub");

test("a reused custom slug still produces a Dub short link for the new portrait", async (t) => {
    const originalPost = axios.post;
    const originalGet = axios.get;
    const originalSettingsGet = settings.get;
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    const posts = [];
    settings.get = (key) => ({
        dubApiKey: "test-key", dubDomain: "twil.io", dubFolderId: "folder-1",
    })[key] ?? originalSettingsGet(key);
    axios.post = async (url, body, options) => {
        posts.push({ url, body, options });
        if (posts.length === 1) {
            const error = new Error("Duplicate key");
            error.response = { status: 409, data: { error: { message: "Duplicate key" } } };
            throw error;
        }
        return { data: { shortLink: "https://twil.io/fresh7" } };
    };
    axios.get = async () => ({
        data: { shortLink: "https://twil.io/la-kings-14", url: "https://booth.example/s/old-photo" },
    });
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};
    t.after(() => {
        axios.post = originalPost;
        axios.get = originalGet;
        settings.get = originalSettingsGet;
        console.log = originalLog;
        console.warn = originalWarn;
        console.error = originalError;
    });

    const longUrl = "https://booth.example/s/new-photo?e=LAKings";
    const shortLink = await dub.shortenUrl(longUrl, "la-kings-14");

    assert.equal(shortLink, "https://twil.io/fresh7");
    assert.equal(posts.length, 2);
    assert.deepEqual(posts[0].body, {
        url: longUrl, domain: "twil.io", key: "la-kings-14", folderId: "folder-1",
    });
    assert.deepEqual(posts[1].body, {
        url: longUrl, domain: "twil.io", folderId: "folder-1",
    });
    assert.equal(await dub.shortenUrl(longUrl, "la-kings-14"), shortLink);
    assert.equal(posts.length, 2, "the recovered link is reused without another Dub request");
});
