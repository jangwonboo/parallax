/* 한 파일로 배포한다. 브라우저가 file:// 옆의 JS/CSS/글꼴을 fetch 하지 않게 한다. */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const read = (name) => readFileSync(join(here, name), "utf8");
const readShared = (name) => readFileSync(join(root, "src/reader", name), "utf8");
let html = read("index.template.html");
const schema = JSON.parse(readShared("../shared/schema-contract.json"));
let katexCss = readFileSync(join(root, "node_modules/katex/dist/katex.min.css"), "utf8");

// 브라우저가 실제로 쓰는 woff2만 담는다. woff/ttf 폴백을 남기면 용량이 두 배가 된다.
katexCss = katexCss.replace(
  /src:url\(fonts\/([^)]+\.woff2)\) format\("woff2"\),url\(fonts\/[^)]*\.woff\) format\("woff"\),url\(fonts\/[^)]*\.ttf\) format\("truetype"\)/g,
  (_, font) => {
    const b64 = readFileSync(join(root, "node_modules/katex/dist/fonts", font)).toString("base64");
    return `src:url(data:font/woff2;base64,${b64}) format("woff2")`;
  },
);
if (katexCss.includes("url(fonts/")) throw new Error("KaTeX 글꼴이 HTML에 포함되지 않았습니다.");

function put(marker, value) {
  if (!html.includes(marker)) throw new Error(`템플릿 자리 없음: ${marker}`);
  html = html.replace(marker, () => value);
}
const inlineScript = (source) => `<script>${source.replace(/<\/script/gi, "<\\/script")}</script>`;
const toolbarIcons = readFileSync(join(here, "toolbar-icons.png")).toString("base64");
const readerCss = (readShared("reader.css") + "\n" + read("reader.css"))
  .replace("__TOOLBAR_ICONS__", `data:image/png;base64,${toolbarIcons}`);
put("<!-- INLINE_STYLES -->", `<style>${katexCss}\n${readerCss}</style>`);
put("<!-- INLINE_SCHEMA_SCRIPT -->", inlineScript(`window.PARALLAX_SCHEMA = ${JSON.stringify(schema)};`));
put("<!-- INLINE_KATEX_SCRIPT -->", inlineScript(readFileSync(join(root, "node_modules/katex/dist/katex.min.js"), "utf8")));
const sqlJs = readFileSync(join(here, "vendor/package/dist/sql-wasm.js"), "utf8");
const sqlWasm = readFileSync(join(here, "vendor/package/dist/sql-wasm.wasm")).toString("base64");
put("<!-- INLINE_SQLITE_SCRIPT -->", `${inlineScript(sqlJs)}\n${inlineScript(`window.PARALLAX_SQL_WASM = "${sqlWasm}";`)}`);
put("<!-- INLINE_BROWSER_API -->", inlineScript(read("browser-api.js")));
put("<!-- INLINE_READER_SCRIPT -->", inlineScript(readShared("reader.js")));
put("<!-- INLINE_MENU_SCRIPT -->", inlineScript(read("menu.js")));
const output = join(here, "parallax.html");
writeFileSync(output, html, "utf8");
console.log(`${output} (${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MiB)`);
