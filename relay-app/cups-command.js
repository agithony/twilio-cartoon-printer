const EPSON_PAGE_SIZES = {
    "4x6": "4x6",
    "5x7": "EPPhotoPaper2L",
    "8x10": "8x10",
};

const EPSON_QUALITIES = {
    standard: "360x360dpi",
    high: "720x720dpi",
    max: "1440x1440dpi",
};

const DNP_DS_RX1_PAGE_SIZES = {
    "4x6": "300dnp6x4",
    "5x7": "210dnp5x7",
};

const DNP_DS_RX1_QUALITIES = {
    standard: "300x300dpi",
    high: "300x600dpi",
    max: "300x600dpi",
};

function isDnpDsRx1(printerName) {
    const normalized = String(printerName || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    return normalized.includes("dsrx1");
}

function buildPrintCommand({ filepath, printerName, printSize, printQuality, customFlags = "" }) {
    let flags;

    if (isDnpDsRx1(printerName)) {
        const pageSize = DNP_DS_RX1_PAGE_SIZES[printSize];
        if (!pageSize) {
            throw new Error(`DNP DS-RX1 does not support print size "${printSize}". Select 4x6 for the loaded 6x4 media.`);
        }
        const resolution = DNP_DS_RX1_QUALITIES[printQuality] || DNP_DS_RX1_QUALITIES.high;
        flags = [
            `-d "${printerName}"`,
            `-o PageSize=${pageSize}`,
            "-o Cutter=Normal",
            "-o Finish=Glossy",
            `-o Resolution=${resolution}`,
            "-o ColorModel=RGB",
            "-o PrintRetry=True",
        ];
    } else {
        const pageSize = (EPSON_PAGE_SIZES[printSize] || EPSON_PAGE_SIZES["5x7"]) + ".NMgn";
        const resolution = EPSON_QUALITIES[printQuality] || EPSON_QUALITIES.high;
        flags = [
            `-d "${printerName}"`,
            `-o PageSize=${pageSize}`,
            "-o EPIJ_RmMg=1",
            "-o EPIJ_exmg=0",
            "-o print-scaling=none",
            "-o scaling=100",
            `-o Resolution=${resolution}`,
        ];
    }

    if (customFlags) flags.push(customFlags);
    return `lp ${flags.join(" ")} "${filepath}"`;
}

module.exports = { buildPrintCommand, isDnpDsRx1 };
