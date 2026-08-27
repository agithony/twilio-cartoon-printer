const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
    buildPrintCommand,
    isDnpDsRx1,
    resolvePrintSettings,
    sanitizeCustomFlags,
} = require("../relay-app/cups-command");

const DNP = "Dai_Nippon_Printing_DS_RX1";

test("detects the installed DNP DS-RX1 queue", () => {
    assert.equal(isDnpDsRx1(DNP), true);
    assert.equal(isDnpDsRx1("EPSON_ET_8550_Series"), false);
});

test("builds the verified DNP 6x4 command", () => {
    const command = buildPrintCommand({
        filepath: "/tmp/portrait.png",
        printerName: DNP,
        printSize: "4x6",
        printQuality: "high",
    });
    assert.equal(command, `lp -d "${DNP}" -o PageSize=300dnp6x4 -o Cutter=Normal -o Finish=Glossy -o Resolution=300x600dpi -o ColorModel=RGB -o PrintRetry=True "/tmp/portrait.png"`);
    assert.doesNotMatch(command, /EPIJ|\.NMgn/);
});

test("maps the literal landscape 6x4 size to DNP 6x4 media", () => {
    const command = buildPrintCommand({
        filepath: "/tmp/landscape.png",
        printerName: DNP,
        outputProfile: { printSize: "6x4", printQuality: "high", orientation: "landscape" },
    });
    assert.equal(command, `lp -d "${DNP}" -o PageSize=300dnp6x4 -o Cutter=Normal -o Finish=Glossy -o Resolution=300x600dpi -o ColorModel=RGB -o PrintRetry=True "/tmp/landscape.png"`);
});

test("maps standard DNP quality to 300x300dpi", () => {
    const command = buildPrintCommand({
        filepath: "/tmp/portrait.png",
        printerName: DNP,
        printSize: "4x6",
        printQuality: "standard",
    });
    assert.match(command, /Resolution=300x300dpi/);
});

test("maps DNP 5x7 to the driver's exact media name", () => {
    const command = buildPrintCommand({
        filepath: "/tmp/portrait.png",
        printerName: DNP,
        printSize: "5x7",
        printQuality: "high",
    });
    assert.match(command, /PageSize=210dnp5x7/);
});

test("rejects unsupported DNP 8x10 instead of wasting media", () => {
    assert.throws(() => buildPrintCommand({
        filepath: "/tmp/portrait.png",
        printerName: DNP,
        printSize: "8x10",
        printQuality: "high",
    }), /does not support print size/);
});

test("preserves the existing Epson command", () => {
    const command = buildPrintCommand({
        filepath: "/tmp/portrait.png",
        printerName: "EPSON_ET_8550_Series",
        printSize: "5x7",
        printQuality: "high",
    });
    assert.equal(command, `lp -d "EPSON_ET_8550_Series" -o PageSize=EPPhotoPaper2L.NMgn -o EPIJ_RmMg=1 -o EPIJ_exmg=0 -o print-scaling=none -o scaling=100 -o Resolution=720x720dpi "/tmp/portrait.png"`);
});

test("builds the literal Epson 6x4 landscape command from the job profile", () => {
    const command = buildPrintCommand({
        filepath: "/tmp/landscape.png",
        printerName: "EPSON_ET_8550_Series",
        printSize: "5x7",
        printQuality: "standard",
        customFlags: "-o Legacy=1",
        outputProfile: {
            printSize: "6x4",
            printQuality: "max",
            orientation: "landscape",
            customPrintFlags: "-o Borderless=On",
        },
    });
    assert.equal(command, `lp -d "EPSON_ET_8550_Series" -o PageSize=EPKG.NMgn -o EPIJ_RmMg=1 -o EPIJ_exmg=0 -o print-scaling=none -o scaling=100 -o Resolution=720x720dpi -o orientation-requested=4 -o Borderless=On "/tmp/landscape.png"`);
    assert.doesNotMatch(command, /Legacy/);
});

test("detects a generically named DNP queue from its installed capabilities", () => {
    const capabilities = "PageSize/Media: 300dnp6x4 210dnp5x7\nResolution: 300x600dpi";
    assert.equal(isDnpDsRx1("Photo_Printer", capabilities), true);
    const command = buildPrintCommand({
        filepath: "/tmp/portrait.png",
        printerName: "Photo_Printer",
        printerCapabilities: capabilities,
        printSize: "4x6",
        printQuality: "standard",
    });
    assert.match(command, /PageSize=300dnp6x4/);
    assert.match(command, /Resolution=300x300dpi/);
    assert.doesNotMatch(command, /EPIJ/);
});

test("resolves profile values ahead of legacy relay settings", () => {
    assert.deepEqual(resolvePrintSettings({
        printSize: "5x7",
        printQuality: "standard",
        customFlags: "-o Legacy=1",
        outputProfile: { printSize: "6x4", printQuality: "high", customPrintFlags: "" },
    }), {
        printSize: "6x4",
        printQuality: "high",
        orientation: "landscape",
        customFlags: "",
    });
});

test("local custom flags remain available for either profile", () => {
    const command = buildPrintCommand({
        filepath: "/tmp/portrait.png",
        printerName: DNP,
        printSize: "4x6",
        printQuality: "high",
        customFlags: "-o Sharpness=5",
    });
    assert.match(command, /PrintRetry=True -o Sharpness=5/);
});

test("custom print flags accept only safe CUPS option pairs", () => {
    assert.equal(
        sanitizeCustomFlags("  -o fit-to-page   -o Sharpness=5   -o media-col=photo/6x4  "),
        "-o fit-to-page -o Sharpness=5 -o media-col=photo/6x4",
    );
    assert.throws(() => sanitizeCustomFlags("-o Sharpness=5 -o"), /safe '-o Name'/);
    assert.throws(() => sanitizeCustomFlags("-o Sharpness=5;rm"), /safe '-o Name'/);
    assert.throws(() => sanitizeCustomFlags("--option Sharpness=5"), /safe '-o Name'/);
    assert.throws(() => sanitizeCustomFlags("-o -o"), /safe '-o Name'/);
});
