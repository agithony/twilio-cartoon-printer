const heartbeats = new Map();

function record(filename, claimId, timestamp = Date.now()) {
    heartbeats.set(filename, { claimId, timestamp });
}

function get(filename, claimId) {
    const heartbeat = heartbeats.get(filename);
    if (!heartbeat) return null;
    if (claimId && heartbeat.claimId !== claimId) return null;
    return heartbeat.timestamp;
}

function clear(filename, claimId) {
    const heartbeat = heartbeats.get(filename);
    if (!heartbeat || (claimId && heartbeat.claimId !== claimId)) return;
    heartbeats.delete(filename);
}

module.exports = { record, get, clear };
