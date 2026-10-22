// Renders the diagram skeletons (*.mjs next to this file) to .excalidraw + .svg with the official
// Excalidraw library in headless Chrome, and inlines each minified SVG into ../index.html between
// its <!--diagram:NAME--> … <!--/diagram:NAME--> markers. A dev-time tool, not a package
// dependency: see ../README.md.
//
//   PUPPETEER_CORE_FROM=<a package.json or directory whose node_modules has puppeteer-core> \
//     node docs/onboarding/diagrams/render.mjs [name.mjs …]       (no names: every diagram)
//
// Env: PUPPETEER_CORE_FROM (where puppeteer-core is resolved from; default: this repository,
// which does not depend on it), CHROME_PATH (default: Google Chrome's macOS location).
// Excalidraw itself is loaded from esm.sh at render time; the page never loads anything.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const VERSION = "0.18.0"; // @excalidraw/excalidraw
const here = dirname(fileURLToPath(import.meta.url));
const page = resolve(here, "../index.html");
const CHROME =
  process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function puppeteer() {
  const from = process.env.PUPPETEER_CORE_FROM || here;
  const anchor = statSync(from).isDirectory() ? join(from, "package.json") : from;
  try {
    return createRequire(anchor)("puppeteer-core");
  } catch {
    console.error(`render: puppeteer-core not found from ${from}; set PUPPETEER_CORE_FROM`);
    process.exit(1);
  }
}

const skip = new Set(["lib.mjs", "render.mjs"]);
let files = process.argv.slice(2).map((f) => resolve(f));
if (!files.length) {
  files = readdirSync(here)
    .filter((f) => f.endsWith(".mjs") && !skip.has(f))
    .sort()
    .map((f) => resolve(here, f));
}

const esc = (s) => s.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
const round = (v, p = 10) => v.replace(/-?\d+\.\d+/g, (x) => String(Math.round(Number(x) * p) / p));

/**
 * Minifies Excalidraw's SVG: no comments, empty defs, metadata or default attributes; path data to
 * whole pixels (the strokes are hand-drawn anyway), other coordinates to 0.1 px.
 */
function minify(svg, name, alt) {
  const viewBox = svg.match(/viewBox="([^"]+)"/)[1];
  const width = Math.round(Number(viewBox.split(" ")[2]));
  return svg
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<metadata>[\s\S]*?<\/metadata>/g, "")
    .replace(/<defs><style class="style-fonts">\s*<\/style><\/defs>/g, "")
    .replace(/ (text-anchor="start"|direction="ltr"|dominant-baseline="alphabetic")/g, "")
    .replace(/ d="([^"]*)"/g, (_, v) => ` d="${round(v, 1)}"`)
    .replace(/\s(transform|x|y|x1|x2|y1|y2|width|height|points)="([^"]*)"/g, (_, k, v) => {
      return ` ${k}="${round(v)}"`;
    })
    .replace(/\sid="([^"]+)"/g, ` id="${name}-$1"`)
    .replace(/url\(#([^)]+)\)/g, `url(#${name}-$1)`)
    .replace(/>\s+</g, "><")
    .replace(
      /^<svg[^>]*>/,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" data-w="${width}" ` +
        `role="img" aria-label="${esc(alt)}" focusable="false">`,
    );
}

const browser = await puppeteer().launch({
  executablePath: CHROME,
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const tab = await browser.newPage();
  tab.on("console", (m) => m.type() === "error" && console.error("[page]", m.text()));
  await tab.setContent(`<!doctype html><html><head><script>
window.EXCALIDRAW_ASSET_PATH = "https://esm.sh/@excalidraw/excalidraw@${VERSION}/dist/prod/";
</script></head><body><script type="module">
import { convertToExcalidrawElements, exportToSvg } from "https://esm.sh/@excalidraw/excalidraw@${VERSION}?bundle";
window.__x = { convertToExcalidrawElements, exportToSvg };
window.__ready = true;
</script></body></html>`);
  await tab.waitForFunction("window.__ready === true", { timeout: 120_000 });

  let html = readFileSync(page, "utf8");
  for (const src of files) {
    const name = basename(src, ".mjs");
    const {
      skeleton,
      alt,
      padding = 16,
    } = await import(`${pathToFileURL(src).href}?t=${Date.now()}`);
    if (!alt) throw new Error(`${name}: export an alt text`);
    const res = await tab.evaluate(
      async (skeleton, padding) => {
        const { convertToExcalidrawElements, exportToSvg } = window.__x;
        const elements = convertToExcalidrawElements(skeleton, { regenerateIds: false });
        const svg = await exportToSvg({
          elements,
          files: {},
          appState: {
            exportBackground: false,
            viewBackgroundColor: "#040F0B",
            exportWithDarkMode: false,
            exportPadding: padding,
          },
        });
        return { svg: svg.outerHTML, elements };
      },
      skeleton,
      padding,
    );
    const svg = minify(res.svg, name, alt);
    writeFileSync(resolve(here, `${name}.svg`), `${svg}\n`);
    writeFileSync(
      resolve(here, `${name}.excalidraw`),
      `${JSON.stringify(
        {
          type: "excalidraw",
          version: 2,
          source: "https://excalidraw.com",
          elements: res.elements,
          appState: { viewBackgroundColor: "#040F0B", gridSize: null },
          files: {},
        },
        null,
        2,
      )}\n`,
    );
    const marker = new RegExp(`<!--diagram:${name}-->[\\s\\S]*?<!--/diagram:${name}-->`, "g");
    const count = html.match(marker)?.length ?? 0;
    html = html.replace(marker, () => `<!--diagram:${name}-->${svg}<!--/diagram:${name}-->`);
    console.log(
      `${name.padEnd(20)} ${svg.length} B, ${res.elements.length} elements, ${count}× in page`,
    );
  }
  writeFileSync(page, html);
} finally {
  await browser.close();
}
