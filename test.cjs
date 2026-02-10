// test.cjs
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const mammoth = require("./");
const AdmZip = require("adm-zip");
const Html = require("./lib/html");

// ✅ XSLT (OMML -> MathML) — xslt-processor v3+
const { Xslt, XmlParser } = require("xslt-processor");
const xslt = new Xslt();
const xmlParser = new XmlParser();

const OMML2MML_XSL_PATH = path.join(__dirname, "OMML2MML.XSL");
const OMML2MML_XSL = fs.readFileSync(OMML2MML_XSL_PATH, "utf8");
const OMML2MML_XSL_DOC = xmlParser.xmlParse(OMML2MML_XSL); // parse 1 lần

// ---------------- utils ----------------
function ensureBuffer(x) {
  if (Buffer.isBuffer(x)) return x;
  if (x instanceof ArrayBuffer) return Buffer.from(x);
  if (x && x.buffer instanceof ArrayBuffer) return Buffer.from(x.buffer);
  return Buffer.from(x);
}
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function normalizeMathml(mathml) {
  let fixed = (mathml || "").trim();
  fixed = fixed.replace(/^\s*<\?xml[^>]*\?>\s*/i, "");

  fixed = fixed.replace(
    /<mml:math[^>]*xmlns:mml=["']http:\/\/www\.w3\.org\/1998\/Math\/MathML["'][^>]*>/gi,
    '<math xmlns="http://www.w3.org/1998/Math/MathML">'
  );
  fixed = fixed.replace(
    /<m:math[^>]*xmlns:m=["']http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/math["'][^>]*>/gi,
    '<math xmlns="http://www.w3.org/1998/Math/MathML">'
  );
  fixed = fixed.replace(/<\/mml:math>/gi, "</math>");
  fixed = fixed.replace(/<\/m:math>/gi, "</math>");
  fixed = fixed.replace(/mml:/g, "");
  fixed = fixed.replace(/m:/g, "");

  if (
    fixed.includes("<math") &&
    !fixed.includes('xmlns="http://www.w3.org/1998/Math/MathML"')
  ) {
    fixed = fixed.replace(
      "<math",
      '<math xmlns="http://www.w3.org/1998/Math/MathML"'
    );
  }
  return fixed.trim();
}

// -------- Ruby batch (MathType) --------
function pickRubyExe() {
  const candidates = [
    "ruby",
    "C:\\Ruby33-x64\\bin\\ruby.exe",
    "C:\\Ruby32-x64\\bin\\ruby.exe",
    "C:\\Ruby31-x64\\bin\\ruby.exe",
    "C:\\Ruby30-x64\\bin\\ruby.exe",
    "C:\\msys64\\usr\\bin\\ruby.exe",
  ];
  for (const c of candidates) {
    if (c === "ruby") return c;
    try {
      if (fs.existsSync(c)) return c;
    } catch { }
  }
  return "ruby";
}

function runRubyMathtypeToMathmlBatchInline(binFilePaths) {
  const rubyExe = pickRubyExe();

  const rubyCode = `
begin
  require 'json'
  require 'mathtype_to_mathml_plus'

  def clean_mathml(mathml)
    return mathml unless mathml.is_a?(String)
    mathml = mathml.delete("\\u2009")
    mathml = mathml.gsub("\\u00A0", " ")
    mathml = mathml.gsub(/<mtext>\\s*<\\/mtext>/, '')
    mathml = mathml.gsub(/\\s*display="block"/, '')
    mathml = mathml.gsub(/\\s*display="inline"/, '')
    mathml = mathml.gsub(/\\n+/, "\\n").strip
    mathml.encode('UTF-8', invalid: :replace, undef: :replace, replace: '')
  end

  results = {}
  ARGV.each do |file_path|
    begin
      if !File.exist?(file_path) || !File.readable?(file_path)
        results[file_path] = "<!-- ERROR: File not accessible -->"
        next
      end

      size = File.size(file_path)
      if size == 0
        results[file_path] = "<!-- ERROR: Empty file -->"
        next
      end
      if size > 10_485_760
        results[file_path] = "<!-- ERROR: File too large -->"
        next
      end

      converter = MathTypeToMathMLPlus::Converter.new(file_path)
      mathml = converter.convert
      if mathml.nil? || mathml.strip.empty?
        results[file_path] = "<!-- ERROR: Empty conversion result -->"
        next
      end

      results[file_path] = clean_mathml(mathml)
    rescue => e
      results[file_path] = "<!-- ERROR: #{e.message.to_s.gsub(/[<>]/, '_')} -->"
    end
  end

  puts JSON.generate(results)
rescue LoadError => e
  STDERR.puts "LOAD_ERROR: #{e.message}"
  exit 2
rescue => e
  STDERR.puts "FATAL: #{e.class}: #{e.message}"
  exit 1
end
`.trim();

  return new Promise((resolve, reject) => {
    const args = ["-e", rubyCode, ...binFilePaths];
    const child = spawn(rubyExe, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));

    child.on("error", (err) =>
      reject(new Error(`Không spawn được ruby (${rubyExe}).\n${err.message}`))
    );

    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Ruby exit ${code}\nSTDERR:\n${stderr}\nSTDOUT(head):\n${stdout.slice(0, 300)}`
          )
        );
        return;
      }

      const out = stdout.trim();
      if (!out) {
        reject(new Error(`Ruby không trả JSON.\nSTDERR:\n${stderr}`));
        return;
      }

      let obj;
      try {
        obj = JSON.parse(out);
      } catch (e) {
        reject(
          new Error(
            `STDOUT không phải JSON.\nSTDOUT(head):\n${out.slice(0, 300)}\nSTDERR:\n${stderr}`
          )
        );
        return;
      }
      resolve(obj);
    });
  });
}

// -------- OMML -> MathML via XSLT --------
function wrapOmml(ommlXml) {
  const s = (ommlXml || "").trim();
  if (!s) return "";

  const looksLikeOmml =
    /<\s*m:oMath\b/i.test(s) || /<\s*m:oMathPara\b/i.test(s);

  const inner = looksLikeOmml ? s : `<m:oMath>${s}</m:oMath>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">
  <w:body>
    ${inner}
  </w:body>
</w:document>`;
}

async function ommlToMathml(ommlXml) {
  const wrapped = wrapOmml(ommlXml);
  if (!wrapped) return "";

  const doc = xmlParser.xmlParse(wrapped);
  const out = await xslt.xsltProcess(doc, OMML2MML_XSL_DOC);
  return out;
}

// ---------------- main ----------------
async function run() {
  let tmpDir = null;

  try {
    const inputPath = "./test.docx";

    const originalBuffer = fs.readFileSync(inputPath);
    const zip = new AdmZip(originalBuffer);
    const patchedBuffer = zip.toBuffer();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mammoth-mathtype-"));

    const mtPlaceholderToFile = new Map();
    const mtAllBinFiles = [];
    const ommlPlaceholderToXml = new Map();

    let seqMT = 0;
    let seqOMML = 0;

    const result = await mammoth.convertToHtml(
      { buffer: patchedBuffer },
      {
        convertMath: async (math) => {
          if (math.kind === "mathtype") {
            const raw = await math.read();
            const binBuffer = ensureBuffer(raw);

            const binName = path.basename(
              math.binPath || `oleObject-${Date.now()}-${seqMT}.bin`
            );
            const binFilePath = path.join(tmpDir, `${seqMT}-${binName}`);

            fs.writeFileSync(binFilePath, binBuffer);

            const id = `mt${seqMT++}`;
            mtPlaceholderToFile.set(id, binFilePath);
            mtAllBinFiles.push(binFilePath);

            return [Html.raw(`<span data-mt="${id}"></span>`)];
          }

          if (math.kind === "omml") {
            const id = `omml${seqOMML++}`;
            const omml = (math.omml || "").trim();
            ommlPlaceholderToXml.set(id, omml);
            return [Html.raw(`<span data-omml="${id}"></span>`)];
          }

          return [Html.text(math.altText || "[math]")];
        },
      }
    );

    const mapPathToMathml = mtAllBinFiles.length
      ? await runRubyMathtypeToMathmlBatchInline(mtAllBinFiles)
      : {};

    let htmlBody = result.value;

    for (const [id, filePath] of mtPlaceholderToFile.entries()) {
      const rawMathml = mapPathToMathml[filePath];
      const fixed = rawMathml
        ? normalizeMathml(rawMathml)
        : `<span class="math-error">MathType error</span>`;

      const re = new RegExp(
        `<span\\s+data-mt="${escapeRegExp(id)}"\\s*><\\/span>`,
        "g"
      );
      htmlBody = htmlBody.replace(re, fixed);
    }

    for (const [id, ommlXml] of ommlPlaceholderToXml.entries()) {
      let fixed = `<span class="math-error">OMML error</span>`;
      try {
        const mathml = await ommlToMathml(ommlXml);
        fixed = normalizeMathml(mathml);
        if (!fixed) fixed = `<span class="math-error">OMML empty</span>`;
      } catch { }

      const re = new RegExp(
        `<span\\s+data-omml="${escapeRegExp(id)}"\\s*><\\/span>`,
        "g"
      );
      htmlBody = htmlBody.replace(re, fixed);
    }

    const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<script>
window.MathJax = {
  loader: { load: ['input/mml', 'output/chtml'] },
  startup: { typeset: true }
};
</script>
<script defer src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/startup.js"></script>
<style>
.math-error{color:#b00020;background:#fff3cd;padding:2px 4px;border-radius:4px}
</style>
</head>
<body>
${htmlBody}
</body>
</html>`;

    fs.writeFileSync("result.html", html, "utf8");
    console.log("🎉 DONE:", path.resolve("result.html"));
  } catch (err) {
    console.error("❌ Error:", err);
  } finally {
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch { }
    }
  }
}

run();
