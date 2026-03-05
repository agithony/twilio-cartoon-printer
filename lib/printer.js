const { exec } = require("child_process");
const settings = require("./settings");

function findPrinter() {
    return new Promise((resolve, reject) => {
        const baseName = settings.get("printerName");
        exec("lpstat -p", (err, stdout) => {
            if (err) {
                reject(new Error(`Cannot list printers: ${err.message}`));
                return;
            }
            const lines = stdout.split("\n").filter((l) => l.startsWith("printer "));
            const matches = lines
                .map((line) => ({
                    name: line.split(" ")[1],
                    lower: line.toLowerCase(),
                }))
                .filter((p) => p.name && p.name.startsWith(baseName));

            if (matches.length === 0) {
                reject(new Error(`No printer found matching "${baseName}"`));
                return;
            }

            // Prefer a healthy printer over a disconnected/disabled one
            const BAD = ["looking for printer", "disabled", "unplugged or turned off"];
            const healthy = matches.find(
                (p) => !BAD.some((b) => p.lower.includes(b)),
            );

            if (healthy) {
                resolve(healthy.name);
            } else {
                const first = matches[0];
                if (first.lower.includes("looking for printer")) {
                    reject(new Error(`Printer "${first.name}" is disconnected`));
                } else if (first.lower.includes("disabled")) {
                    reject(new Error(`Printer "${first.name}" is disabled`));
                } else {
                    reject(new Error(`Printer "${first.name}" is turned off`));
                }
            }
        });
    });
}

async function checkPrinterReady() {
    const printerName = await findPrinter();
    console.log(`🖨️  Found printer: ${printerName}`);
    return printerName;
}

function printImage(filepath, printerName) {
    return new Promise((resolve, reject) => {
        const { PRINT_SIZES, PRINT_QUALITIES } = require("./settings");

        const printSize = settings.get("printSize") || "5x7";
        const printQuality = settings.get("printQuality") || "high";
        const customFlags = settings.get("customPrintFlags") || "";

        const sizePreset = PRINT_SIZES[printSize] || PRINT_SIZES["5x7"];
        const pageSize = sizePreset.pageSize + ".NMgn";
        const resolution = PRINT_QUALITIES[printQuality] || PRINT_QUALITIES["high"];

        const flags = [
            `-d "${printerName}"`,
            `-o PageSize=${pageSize}`,
            "-o EPIJ_RmMg=1",
            "-o EPIJ_exmg=0",
            "-o print-scaling=none",
            "-o scaling=100",
            `-o Resolution=${resolution}`,
        ];
        if (customFlags) flags.push(customFlags);

        const command = `lp ${flags.join(" ")} "${filepath}"`;
        console.log(`🖨️  Sending to printer: ${command}`);
        exec(command, (err, stdout) => {
            if (err) {
                console.error(`🖨️  Print error: ${err.message}`);
                reject(err);
                return;
            }

            console.log(`🖨️  Print job accepted: ${stdout.trim()}`);

            // Parse request ID from lp output (e.g. "request id is EPSON_ET_8550-123 (1 file(s))")
            const match = stdout.match(/request id is (\S+)/);
            if (!match) {
                console.log("🖨️  Could not parse request ID, skipping print completion wait");
                resolve(stdout);
                return;
            }

            const requestId = match[1];
            console.log(`🖨️  Waiting for print job ${requestId} to finish...`);
            waitForPrintComplete(requestId, resolve, reject);
        });
    });
}

const PRINT_POLL_INTERVAL = 3000; // check every 3 seconds
const PRINT_TIMEOUT = 5 * 60 * 1000; // give up after 5 minutes

function waitForPrintComplete(requestId, resolve, reject) {
    const startTime = Date.now();

    const poll = () => {
        if (Date.now() - startTime > PRINT_TIMEOUT) {
            console.log(`🖨️  Print job ${requestId} timed out waiting for completion, proceeding anyway`);
            resolve();
            return;
        }

        exec("lpstat", (err, stdout) => {
            if (err) {
                // lpstat failed -- printer may be gone, just proceed
                console.log(`🖨️  lpstat error while waiting: ${err.message}, proceeding`);
                resolve();
                return;
            }

            // If the request ID is still in lpstat output, it's still printing
            if (stdout.includes(requestId)) {
                setTimeout(poll, PRINT_POLL_INTERVAL);
            } else {
                console.log(`🖨️  Print job ${requestId} completed`);
                resolve();
            }
        });
    };

    setTimeout(poll, PRINT_POLL_INTERVAL);
}

module.exports = {
    checkPrinterReady,
    printImage,
};
