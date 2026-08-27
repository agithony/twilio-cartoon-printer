const EPSON_PAGE_SIZES = {
    "4x6": "EPKG.NMgn",
    "6x4": "EPKG.NMgn",
    "5x7": "EPPhotoPaper2L.NMgn",
    "8x10": "EP8x10in.NMgn",
};

const EPSON_QUALITIES = {
    standard: "360x360dpi",
    high: "720x720dpi",
    max: "720x720dpi",
};

const DNP_DS_RX1_PAGE_SIZES = {
    "4x6": "300dnp6x4",
    "6x4": "300dnp6x4",
    "5x7": "210dnp5x7",
};

const DNP_DS_RX1_QUALITIES = {
    standard: "300x300dpi",
    high: "300x600dpi",
    max: "300x600dpi",
};

function isDnpDsRx1(printerName, printerCapabilities = "") {
    const normalized = String(printerName || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const capabilities = String(printerCapabilities || "").toLowerCase();
    return normalized.includes("dsrx1") || (capabilities.includes("300dnp6x4") && capabilities.includes("210dnp5x7"));
}

function sanitizeCustomFlags(customFlags) {
    const value = String(customFlags || "").trim();
    if (!value) return "";
    const tokens = value.split(/\s+/);
    if (tokens.length % 2 !== 0) throw new Error("Custom print flags must use safe '-o Name' or '-o Name=Value' pairs");
    for (let i = 0; i < tokens.length; i += 2) {
        if (tokens[i] !== "-o" || !/^[A-Za-z0-9][A-Za-z0-9_.-]*(?:=[A-Za-z0-9_.:+,\/-]+)?$/.test(tokens[i + 1])) {
            throw new Error("Custom print flags must use safe '-o Name' or '-o Name=Value' pairs");
        }
    }
    return tokens.join(" ");
}

function resolvePrintSettings({ printSize, printQuality, customFlags, outputProfile }) {
    const profile = outputProfile || {};
    const resolvedPrintSize = profile.printSize || printSize || "5x7";
    return {
        printSize: resolvedPrintSize,
        printQuality: profile.printQuality || printQuality || "high",
        orientation: profile.orientation || (resolvedPrintSize === "6x4" ? "landscape" : "portrait"),
        customFlags: Object.prototype.hasOwnProperty.call(profile, "customPrintFlags")
            ? profile.customPrintFlags
            : customFlags || "",
    };
}

function buildPrintCommand({ filepath, printerName, printerCapabilities = "", printSize, printQuality, customFlags = "", outputProfile = null }) {
    const resolved = resolvePrintSettings({ printSize, printQuality, customFlags, outputProfile });
    let flags;

    if (isDnpDsRx1(printerName, printerCapabilities)) {
        const pageSize = DNP_DS_RX1_PAGE_SIZES[resolved.printSize];
        if (!pageSize) {
            throw new Error(`DNP DS-RX1 does not support print size "${resolved.printSize}".`);
        }
        const resolution = DNP_DS_RX1_QUALITIES[resolved.printQuality] || DNP_DS_RX1_QUALITIES.high;
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
        const pageSize = EPSON_PAGE_SIZES[resolved.printSize] || EPSON_PAGE_SIZES["5x7"];
        const resolution = EPSON_QUALITIES[resolved.printQuality] || EPSON_QUALITIES.high;
        flags = [
            `-d "${printerName}"`,
            `-o PageSize=${pageSize}`,
            "-o EPIJ_RmMg=1",
            "-o EPIJ_exmg=0",
            "-o print-scaling=none",
            "-o scaling=100",
            `-o Resolution=${resolution}`,
        ];
        if (resolved.orientation === "landscape" || resolved.printSize === "6x4") {
            flags.push("-o orientation-requested=4");
        }
    }

    const safeCustomFlags = sanitizeCustomFlags(resolved.customFlags);
    if (safeCustomFlags) flags.push(safeCustomFlags);
    return `lp ${flags.join(" ")} "${filepath}"`;
}

module.exports = { buildPrintCommand, isDnpDsRx1, resolvePrintSettings, sanitizeCustomFlags };
