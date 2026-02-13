const { exec } = require("child_process");

function findPrinter() {
    return new Promise((resolve, reject) => {
        const baseName = process.env.PRINTER_NAME;
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
        const command = `lp -d "${printerName}" -o PageSize=EPPhotoPaper2L.NMgn -o EPIJ_RmMg=1 -o EPIJ_exmg=0 -o print-scaling=none -o scaling=100 -o Resolution=720x720dpi "${filepath}"`;
        console.log(`🖨️  Sending to printer: ${command}`);
        exec(command, (err, stdout) => {
            if (err) {
                console.error(`🖨️  Print error: ${err.message}`);
                reject(err);
            } else {
                console.log(`🖨️  Print job accepted: ${stdout.trim()}`);
                resolve(stdout);
            }
        });
    });
}

module.exports = {
    checkPrinterReady,
    printImage,
};
