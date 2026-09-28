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

const DNP_DS620_PAGE_SIZES = {
    "4x6": "dnp6x4",
    "6x4": "dnp6x4",
    "5x7": "dnp5x7",
};

const DNP_DS_RX1_QUALITIES = {
    standard: "300x300dpi",
    high: "300x600dpi",
    max: "300x600dpi",
};

function detectDnpModel(printerName, printerCapabilities = "") {
    const normalized = String(printerName || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normalized.includes("dsrx1")) return "ds-rx1";
    if (normalized.includes("ds620")) return "ds620";

    const capabilityTokens = new Set(
        String(printerCapabilities || "").toLowerCase().split(/\s+/).map((token) => token.replace(/^\*/, "")),
    );
    if (capabilityTokens.has("300dnp6x4") && capabilityTokens.has("210dnp5x7")) return "ds-rx1";
    if (capabilityTokens.has("dnp6x4") && capabilityTokens.has("dnp5x7")) return "ds620";
    return null;
}

function isDnpDsRx1(printerName, printerCapabilities = "") {
    return detectDnpModel(printerName, printerCapabilities) === "ds-rx1";
}

function isDnpPrinter(printerName, printerCapabilities = "") {
    return detectDnpModel(printerName, printerCapabilities) !== null;
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
    const dnpModel = detectDnpModel(printerName, printerCapabilities);
    let flags;

    if (dnpModel) {
        const pageSizes = dnpModel === "ds620" ? DNP_DS620_PAGE_SIZES : DNP_DS_RX1_PAGE_SIZES;
        const pageSize = pageSizes[resolved.printSize];
        if (!pageSize) {
            throw new Error(`DNP ${dnpModel === "ds620" ? "DS620" : "DS-RX1"} does not support print size "${resolved.printSize}".`);
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

module.exports = { buildPrintCommand, isDnpDsRx1, isDnpPrinter, resolvePrintSettings, sanitizeCustomFlags };
