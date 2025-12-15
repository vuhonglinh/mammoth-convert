const fs = require("fs");
const mammoth = require("./");
const AdmZip = require("adm-zip");


async function run() {
    try {
        const inputPath = "./test.docx";

        const originalBuffer = fs.readFileSync(inputPath);
        const zip = new AdmZip(originalBuffer);


        let xml = zip.readAsText("word/document.xml");


        zip.updateFile("word/document.xml", Buffer.from(xml, "utf8"));
        const patchedBuffer = zip.toBuffer();

        const result = await mammoth.convertToHtml({ buffer: patchedBuffer });
        const html = result.value;

        fs.writeFileSync("result.html", html, "utf8");


        console.log("🎉 DONE");
    } catch (err) {
        console.error("❌ Error:", err);
    }
}

run();
