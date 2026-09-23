const lockTails = new Map();

async function acquireRelayJobLock(filename) {
    const previous = lockTails.get(filename) || Promise.resolve();
    let releaseCurrent;
    const current = new Promise((resolve) => { releaseCurrent = resolve; });
    lockTails.set(filename, current);
    await previous;

    let released = false;
    return () => {
        if (released) return;
        released = true;
        releaseCurrent();
        if (lockTails.get(filename) === current) lockTails.delete(filename);
    };
}

module.exports = { acquireRelayJobLock };
