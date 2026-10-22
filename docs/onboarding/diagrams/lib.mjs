// Excalidraw skeleton helpers in the palette of the page (docs/onboarding/index.html).
// Every diagram module exports `skeleton` (Excalidraw element skeletons) and `alt` (its text
// alternative); render.mjs turns them into .excalidraw + .svg and inlines the SVG into the page.
export const C = {
  text: "#FFFFFF",
  muted: "#B8C6BE",
  accent: "#00FF93",
  struct: "#06B680",
  soft: "#BAFFF5",
  line: "#3A4A42",
  fill: "#0D100F",
  tag: "#8E9E95",
  warn: "#F5B83D",
  danger: "#FF8A80",
};
export const FONT = 2; // Helvetica; CJK falls back to the system font (PingFang SC / Noto Sans SC)

let n = 0;
const uid = (p) => `${p}-${++n}`;
// A fixed seed per element keeps the hand-drawn strokes identical across renders.
const seed = () => 1000 + n * 7919;
const base = () => ({ roughness: 1, fontFamily: FONT, strokeWidth: 2, seed: seed() });

export function rect(x, y, w, h, o = {}) {
  return {
    ...base(),
    type: o.shape || "rectangle",
    id: o.id || uid("r"),
    x,
    y,
    width: w,
    height: h,
    strokeColor: o.stroke || C.muted,
    backgroundColor: o.bg ?? C.fill,
    fillStyle: "solid",
    strokeWidth: o.sw || 2,
    strokeStyle: o.dashed ? "dashed" : "solid",
    roundness: o.square ? null : { type: 3 },
    ...(o.label
      ? {
          label: {
            text: o.label,
            fontSize: o.size || 22,
            fontFamily: FONT,
            strokeColor: o.color || C.text,
          },
        }
      : {}),
  };
}

export function text(x, y, t, o = {}) {
  return {
    ...base(),
    type: "text",
    id: o.id || uid("t"),
    x,
    y,
    text: t,
    fontSize: o.size || 22,
    strokeColor: o.color || C.muted,
    lineHeight: o.lh || 1.3,
    textAlign: o.align || "left",
  };
}

/** A titled box: a title (one or more lines) and an optional sub text, padded inside. */
export function box(x, y, w, h, title, sub, o = {}) {
  const ts = o.ts || 24;
  const lines = title.split("\n").length;
  const pad = o.pad ?? 18;
  const els = [
    rect(x, y, w, h, o),
    text(x + pad, y + 14, title, { size: ts, color: o.tc || C.text, lh: 1.2 }),
  ];
  if (sub) {
    els.push(
      text(x + pad, y + 14 + ts * 1.2 * lines + (o.gap ?? 8), sub, {
        size: o.ss || 19,
        color: o.sc || C.muted,
      }),
    );
  }
  return els;
}

export function arrow(pts, o = {}) {
  const [x0, y0] = pts[0];
  return {
    ...base(),
    type: o.line ? "line" : "arrow",
    id: o.id || uid("a"),
    x: x0,
    y: y0,
    points: pts.map(([x, y]) => [x - x0, y - y0]),
    strokeColor: o.stroke || C.struct,
    strokeWidth: o.sw || 2.5,
    strokeStyle: o.dashed ? "dashed" : "solid",
    ...(o.line
      ? {}
      : { startArrowhead: o.both ? "arrow" : null, endArrowhead: o.noHead ? null : "arrow" }),
  };
}

export const line = (pts, o = {}) => arrow(pts, { line: true, stroke: C.line, sw: 2, ...o });
export const dot = (cx, cy, r = 7, color = C.struct) =>
  rect(cx - r, cy - r, 2 * r, 2 * r, { shape: "ellipse", stroke: color, bg: color, sw: 1 });
export const tag = (x, y, t, color = C.tag, size = 18) => text(x, y, t, { size, color });
/** A numbered step marker: a filled circle with its number. */
export const num = (cx, cy, k, color = C.struct) => [
  rect(cx - 15, cy - 15, 30, 30, {
    shape: "ellipse",
    stroke: color,
    bg: color,
    sw: 1,
    label: String(k),
    size: 17,
    color: "#040F0B",
  }),
];
