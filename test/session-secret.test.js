const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const root = path.join(__dirname, "..");

function loadAuth(envChanges) {
    const env = { ...process.env, ...envChanges };
    if (envChanges.SESSION_SECRET === undefined) delete env.SESSION_SECRET;
    return spawnSync(process.execPath, ["-e", "require('./lib/auth')"], {
        cwd: root,
        env,
        encoding: "utf8",
    });
}

function startApplication(sessionSecret) {
    return spawnSync(process.execPath, ["index.js"], {
        cwd: root,
        env: {
            ...process.env,
            NODE_ENV: "production",
            SESSION_SECRET: sessionSecret || "",
        },
        encoding: "utf8",
        timeout: 10_000,
    });
}

test("production rejects missing and weak SESSION_SECRET values in isolated processes", () => {
    for (const sessionSecret of ["", "x".repeat(31)]) {
        const child = startApplication(sessionSecret);
        assert.notEqual(child.status, 0);
        assert.match(child.stderr, /SESSION_SECRET must be set to at least 32 characters in production/);
    }

    const strong = loadAuth({ NODE_ENV: "production", SESSION_SECRET: "x".repeat(32) });
    assert.equal(strong.status, 0, strong.stderr);
});

test("local startup may generate an ephemeral SESSION_SECRET", () => {
    const child = loadAuth({ NODE_ENV: "test", SESSION_SECRET: undefined });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /generated ephemeral secret/);
});
