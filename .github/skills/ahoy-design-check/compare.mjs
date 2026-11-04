#!/usr/bin/env node
// Ahoy design check: compares what measure.js measured on the built page with a Figma frame's node tree (the harness's
// specs/<KEY>/design/frames/<frame>.json) and prints every mismatch beyond the tolerance, one line each.
//
//   node .github/skills/ahoy-design-check/compare.mjs <frame tree .json> <measured .json>
//
// Exit 0: no mismatch. Exit 1: mismatches, printed. Exit 2: an input it cannot read.
// Boxes are compared from the frame's corner: from the element tagged with the frame's own id when there is one,
// else from the page's corner. No dependency: Node's standard library only.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Pixels a position, size or line height may be off by. */
export const BOX_PX = 2;
const LINE_PX = 1;
const RADIUS_PX = 1;
const WIDTH_PX = 0.5;
const OPACITY = 0.02;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const px = (v) => {
  const n = Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
};
const hex2 = (n) =>
  Math.round(Math.min(1, Math.max(0, n)) * 255)
    .toString(16)
    .padStart(2, "0");

/** A computed CSS colour (`rgb(…)`, `rgba(…)`, `rgb(r g b / a)`) as the trees write colours: `#rrggbb`, `aa` when not opaque. */
export function cssHex(css) {
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(String(css).trim());
  if (!m) return null;
  const alpha = m[4] === undefined ? 1 : m[4].endsWith("%") ? Number.parseFloat(m[4]) / 100 : Number.parseFloat(m[4]);
  const [r, g, b] = [m[1], m[2], m[3]].map((c) => Number.parseFloat(c) / 255);
  return `#${hex2(r)}${hex2(g)}${hex2(b)}${alpha < 1 ? hex2(alpha) : ""}`;
}

/** Splits a computed list (`box-shadow`) on the commas outside parentheses. */
function splitList(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") depth--;
    else if (text[i] === "," && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

/** A shadow as `{inset, x, y, blur, spread, colour}`, from the tree's CSS or a computed `box-shadow` entry. */
function shadowOf(text) {
  const colour = /(rgba?\([^)]*\)|#[0-9a-f]{6,8})/i.exec(text)?.[1];
  const numbers = text
    .replace(colour ?? "", "")
    .match(/-?[\d.]+px/g)
    ?.map((n) => Number.parseFloat(n));
  if (!colour || !numbers || numbers.length < 2) return null;
  return {
    inset: /\binset\b/.test(text),
    x: numbers[0],
    y: numbers[1],
    blur: numbers[2] ?? 0,
    spread: numbers[3] ?? 0,
    colour: colour.startsWith("#") ? colour.toLowerCase() : cssHex(colour),
  };
}

/** Node types whose own background, corners, border and shadow the frame tree states, absent meaning none. */
const BOXES = new Set(["FRAME", "INSTANCE", "COMPONENT", "RECTANGLE"]);
const TEXT_CASE = { UPPER: "uppercase", LOWER: "lowercase", TITLE: "capitalize" };
const DECORATION = { UNDERLINE: "underline", STRIKETHROUGH: "line-through" };
const fmt = (v) => (Array.isArray(v) ? `[${v.join(", ")}]` : String(v));

/**
 * The mismatches between a frame's node tree and the measured page: each tagged node's box, text style, colours,
 * corners, border, opacity and shadows, beyond the tolerance. Returns the lines to print and what was compared.
 */
export function compareFrame(tree, measured) {
  if (!isObject(tree) || !isObject(tree.root)) throw new Error("the frame tree has no root node");
  if (!isObject(measured) || !Array.isArray(measured.nodes)) throw new Error("the measurement has no nodes");
  const byId = new Map();
  for (const node of measured.nodes) if (isObject(node) && typeof node.id === "string") byId.set(node.id, node);
  const frameNode = byId.get(tree.id);
  const origin = frameNode && Array.isArray(frameNode.box) ? frameNode.box : [0, 0];
  const lines = [];
  const unmeasured = [];
  const seen = new Set();
  let compared = 0;

  const visit = (design) => {
    if (!isObject(design)) return;
    const built = byId.get(design.id);
    const label = `${design.id} "${String(design.name ?? "").slice(0, 60)}"`;
    const miss = (property, want, got) => lines.push(`${label} ${property}: design ${fmt(want)}, built ${fmt(got)}`);
    if (!built) {
      if (design.type === "TEXT" || design.type === "INSTANCE" || design.fill || design.stroke)
        unmeasured.push(design.id);
    } else {
      seen.add(design.id);
      compared++;
      if (built.visible === false) miss("visibility", "shown", "hidden");
      const font = isObject(design.font) ? design.font : null;
      const boxes = BOXES.has(design.type);
      if (Array.isArray(design.box) && Array.isArray(built.box)) {
        // An auto-width text is as wide as its characters, which a block element is not: its x and width come from
        // the characters' box, its y and height (the line boxes) from the element's.
        const characters = design.type === "TEXT" && font?.textAutoResize === "WIDTH_AND_HEIGHT";
        const own =
          characters && Array.isArray(built.textBox)
            ? [built.textBox[0], built.box[1], built.textBox[2], built.box[3]]
            : built.box;
        const at = design.id === tree.id ? [0, 0, own[2], own[3]] : own;
        const relative = [at[0] - origin[0], at[1] - origin[1], at[2], at[3]].map((n) => Math.round(n * 100) / 100);
        if (design.id === tree.id) {
          if (design.box.slice(2).some((v, i) => Math.abs(v - relative[2 + i]) > BOX_PX))
            miss("size", design.box.slice(2), relative.slice(2));
        } else if (design.box.some((v, i) => Math.abs(v - relative[i]) > BOX_PX)) miss("box", design.box, relative);
      }
      if (design.type === "TEXT" && font) {
        const family = String(built.fontFamily ?? "")
          .split(",")[0]
          .replace(/["']/g, "")
          .trim();
        if (font.fontFamily && family.toLowerCase() !== String(font.fontFamily).toLowerCase())
          miss("font-family", font.fontFamily, family);
        if (font.fontSize !== undefined && Math.abs(px(built.fontSize) - font.fontSize) > 0.5)
          miss("font-size", `${font.fontSize}px`, built.fontSize);
        if (font.fontWeight !== undefined && px(built.fontWeight) !== font.fontWeight)
          miss("font-weight", font.fontWeight, built.fontWeight);
        if (font.lineHeightPx !== undefined && built.lineHeight !== "normal") {
          const line = px(built.lineHeight);
          if (line === null || Math.abs(line - font.lineHeightPx) > LINE_PX)
            miss("line-height", `${font.lineHeightPx}px`, built.lineHeight);
        }
        const spacing = built.letterSpacing === "normal" ? 0 : px(built.letterSpacing);
        if (font.letterSpacing !== undefined && Math.abs((spacing ?? 0) - font.letterSpacing) > WIDTH_PX)
          miss("letter-spacing", `${font.letterSpacing}px`, built.letterSpacing);
        const transform = TEXT_CASE[font.textCase] ?? "none";
        if ((built.textTransform ?? "none") !== transform) miss("text-transform", transform, built.textTransform);
        const decoration = DECORATION[font.textDecoration] ?? "none";
        if ((built.textDecoration ?? "none") !== decoration) miss("text-decoration", decoration, built.textDecoration);
        if (design.fill && cssHex(built.color) !== design.fill)
          miss("color", design.fill, cssHex(built.color) ?? built.color);
      } else if (design.fill) {
        const own = cssHex(built.background);
        const shown = own && !/^#[0-9a-f]{6}00$/.test(own) ? own : cssHex(built.backdrop);
        if (shown !== design.fill) miss("background", design.fill, shown ?? built.background);
      } else if (boxes && !design.paints) {
        // No fill in the design: a background of the built element's own shows unless it is the one behind it.
        const own = cssHex(built.background);
        if (own && !/^#[0-9a-f]{6}00$/.test(own) && own !== cssHex(built.backdrop)) miss("background", "none", own);
      }
      const corners = Array.isArray(design.radii)
        ? design.radii
        : design.radius
          ? Array(4).fill(design.radius)
          : boxes
            ? [0, 0, 0, 0]
            : null;
      if (corners && Array.isArray(built.radius)) {
        const got = built.radius.map((r) => px(r) ?? 0);
        if (corners.some((r, i) => Math.abs(r - got[i]) > RADIUS_PX)) miss("border-radius", corners, got);
      }
      if (design.stroke && Array.isArray(built.borderWidth)) {
        const want = Array.isArray(design.strokeWeights)
          ? design.strokeWeights
          : Array(4).fill(design.strokeWeight ?? 1);
        const got = built.borderWidth.map((w) => px(w) ?? 0);
        if (want.some((w, i) => Math.abs(w - got[i]) > WIDTH_PX)) miss("border-width", want, got);
        const colours = (built.borderColor ?? []).filter((_, i) => got[i] > 0).map(cssHex);
        if (colours.some((c) => c !== design.stroke)) miss("border-color", design.stroke, [...new Set(colours)]);
      } else if (boxes && Array.isArray(built.borderWidth)) {
        const got = built.borderWidth.map((w) => px(w) ?? 0);
        if (got.some((w) => w > WIDTH_PX)) miss("border-width", "none", got);
      }
      if (design.opacity !== undefined && Math.abs((px(built.opacity) ?? 1) - design.opacity) > OPACITY)
        miss("opacity", design.opacity, built.opacity);
      const shadows = (design.effects ?? []).filter((e) => /^(box|text)-shadow:/.test(e)).map((e) => shadowOf(e));
      if (shadows.length > 0 && design.type !== "TEXT") {
        const got = built.boxShadow && built.boxShadow !== "none" ? splitList(built.boxShadow).map(shadowOf) : [];
        const same = (a, b) =>
          a &&
          b &&
          a.inset === b.inset &&
          a.colour === b.colour &&
          ["x", "y", "blur", "spread"].every((k) => Math.abs(a[k] - b[k]) <= LINE_PX);
        if (got.length !== shadows.length || shadows.some((s, i) => !same(s, got[i])))
          miss(
            "box-shadow",
            design.effects.filter((e) => e.startsWith("box-shadow:")).map((e) => e.slice(12)),
            built.boxShadow,
          );
      } else if (shadows.length === 0 && boxes && built.boxShadow && built.boxShadow !== "none")
        miss("box-shadow", "none", built.boxShadow);
    }
    for (const child of Array.isArray(design.children) ? design.children : []) visit(child);
  };
  visit(tree.root);
  const unknown = [...byId.keys()].filter((id) => !seen.has(id) && id !== tree.id);
  const header =
    `frame ${tree.id} "${String(tree.name ?? "").slice(0, 60)}": ${compared} node(s) measured; ` +
    `${lines.length} mismatch(es) beyond ${BOX_PX} px or in a colour or font`;
  const footer = [
    ...(unmeasured.length > 0
      ? [
          `not measured: ${unmeasured.length} node(s) with text, a component or a colour, e.g. ${unmeasured.slice(0, 10).join(", ")}`,
        ]
      : []),
    ...(unknown.length > 0 ? [`tagged but not in this frame: ${unknown.slice(0, 10).join(", ")}`] : []),
  ];
  return { header, mismatches: lines, footer, compared, unmeasured: unmeasured.length };
}

/** A measurement as browser_evaluate saved it: the JSON object, a JSON string of it, or text around it. */
export function readMeasured(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end < start) throw new Error("the measurement is not JSON");
    value = JSON.parse(text.slice(start, end + 1));
  }
  return typeof value === "string" ? JSON.parse(value) : value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [treePath, measuredPath] = process.argv.slice(2);
  if (!treePath || !measuredPath) {
    console.error("usage: node compare.mjs <frame tree .json> <measured .json>");
    process.exit(2);
  }
  let result;
  try {
    result = compareFrame(JSON.parse(readFileSync(treePath, "utf8")), readMeasured(readFileSync(measuredPath, "utf8")));
  } catch (error) {
    console.error(`design check: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  console.log([result.header, ...result.mismatches, ...result.footer].join("\n"));
  process.exit(result.mismatches.length > 0 ? 1 : 0);
}
