const path = require("path");
const { convertDocxToHtmlMathml } = require("../");

(async () => {
    const html = await convertDocxToHtmlMathml(
        { path: path.join(__dirname, "../omml.docx") },
        { enableOmml: true, enableMathType: false }
    );

    console.log(html);
})();
