// lib/omml-to-mathml.js
const fs = require("fs");
const { xsltProcess, xmlParse } = require("xslt-processor");

function normalizeXsltMathML(xml) {
    xml = xml.replace(
        /<mml:math[^>]*xmlns:mml=["']http:\/\/www\.w3\.org\/1998\/Math\/MathML["'][^>]*>/gi,
        '<math xmlns="http://www.w3.org/1998/Math/MathML">'
    );
    xml = xml.replace(
        /<m:math[^>]*xmlns:m=["']http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/math["'][^>]*>/gi,
        '<math xmlns="http://www.w3.org/1998/Math/MathML">'
    );

    xml = xml.replace(/<\/mml:math>/gi, "</math>");
    xml = xml.replace(/<\/m:math>/gi, "</math>");
    xml = xml.replace(/mml:/g, "");
    xml = xml.replace(/m:/g, "");
    return xml;
}

function ensureMathRoot(xml) {
    const trimmed = (xml || "").trim();
    if (!trimmed) return trimmed;
    if (/^<math[\s>]/i.test(trimmed)) return trimmed;
    return `<math xmlns="http://www.w3.org/1998/Math/MathML"><mrow>${trimmed}</mrow></math>`;
}

function isValidMathML(xml) {
    const t = (xml || "").trim();
    if (!/^<math[\s>]/i.test(t)) return false;
    if (!/(<mi\b|<mo\b|<mn\b|<mfrac\b|<msup\b|<msub\b|<mfenced\b|<mrow\b)/i.test(t)) return false;
    return true;
}

class OmmlToMathmlService {
    constructor(xsltPath) {
        const xsltText = fs.readFileSync(xsltPath, "utf8");
        this._xslDoc = xmlParse(xsltText); // ✅ parse XSLT 1 lần
    }

    convert(ommlXml) {
        try {
            // ✅ parse OMML mỗi lần (nhẹ hơn spawn process rất nhiều)
            const ommlDoc = xmlParse(ommlXml);
            let out = xsltProcess(ommlDoc, this._xslDoc);

            out = (out || "").trim();
            out = out.replace(/<\?xml[^>]*>/gi, "").trim();
            out = normalizeXsltMathML(out);

            if (!/^<math[\s>]/i.test(out)) out = ensureMathRoot(out);
            if (!isValidMathML(out)) {
                return `<math xmlns="http://www.w3.org/1998/Math/MathML"><mrow><mi>?</mi></mrow></math>`;
            }
            return out.trim();
        } catch (e) {
            return `<math xmlns="http://www.w3.org/1998/Math/MathML"><mrow><mi>?</mi></mrow></math>`;
        }
    }
}

module.exports = { OmmlToMathmlService };
