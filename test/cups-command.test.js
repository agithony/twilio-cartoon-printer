const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildPrintCommand, isDnpDsRx1 } = require("../relay-app/cups-command");

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
