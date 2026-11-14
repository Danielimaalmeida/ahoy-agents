#!/usr/bin/env node
// Ahoy design check: compares what measure.js measured on the built page with a Figma frame's node tree (the harness's
// specs/<KEY>/design/frames/<frame>.json) and prints what differs, one line each, in two levels: a mismatch, to fix,
// and a note, a small difference that needs no fix (a design and its build seldom match to the pixel).
//
//   node .github/skills/ahoy-design-check/compare.mjs <frame tree .json> <measured .json> [--within <node id>]...
//
// Exit 0: no mismatch, with or without notes. Exit 1: mismatches, printed. Exit 2: an input it cannot read.
// Boxes are compared from the frame's corner: from the element tagged with the frame's own id when there is one,
// else from the page's corner. `--within` compares only that node of the frame and what is in it, from its own
// corner: the part a package builds of a frame that also shows the application around it.
// No dependency: Node's standard library only.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Pixels a position or size may be off by before it is noted. */
export const BOX_PX = 2;
/** Pixels a position or size may be off by before it is a mismatch. */
export const BOX_MISMATCH_PX = 8;
/** The share of its width an auto-width text may also be off by: its characters are as wide as the browser's font. */
const TEXT_WIDTH_SHARE = 0.1;
/** What each other value may be off by: beyond the first it is noted, beyond the second it is a mismatch. */
const LINE_PX = [1, 2];
const FONT_PX = [0.5, 1];
const SPACING_PX = [0.5, 2];
const RADIUS_PX = [1, 4];
const WIDTH_PX = [0.5, 1];
const OPACITY = [0.02, 0.1];
const SHADOW_PX = [1, 4];
/** A colour channel, of 255: any difference is noted, one beyond 8 (about 3%) is another colour. */
const CHANNEL = [0, 8];
/** How many of the measured nodes just before a node, in its container, it may have moved with. */
const PEERS = 4;
/** The most notes printed for one frame; the rest are counted. */
export const NOTES_SHOWN = 20;

const NOTE = 1;
const MISMATCH = 2;
/** 0 when `off` is within the first limit, a note within the second, else a mismatch. */
const levelOf = (off, [note, mismatch]) => (off > mismatch ? MISMATCH : off > note ? NOTE : 0);

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const round = (n) => Math.round(n * 100) / 100;
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

/** A `#rrggbb` or `#rrggbbaa` colour as its four channels, 0 to 255; null for anything else. */
function channels(hex) {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(hex));
  if (!m) return null;
  const rgb = Number.parseInt(m[1], 16);
  return [rgb >> 16, (rgb >> 8) & 255, rgb & 255, m[2] === undefined ? 255 : Number.parseInt(m[2], 16)];
}

/** How far two colours are apart: 0 the same, a note when nearly the same on every channel, else a mismatch. */
function colourLevel(want, got) {
  if (want === got) return 0;
  const [a, b] = [channels(want), channels(got)];
  if (!a || !b) return MISMATCH;
  return levelOf(Math.max(...a.map((c, i) => Math.abs(c - b[i]))), CHANNEL);
}

/** Whether a colour shows nothing: none, or fully transparent. */
const clear = (hex) => !hex || /^#[0-9a-f]{6}00$/i.test(hex);

/** The font families a browser's own interface font stands for, and the names CSS gives that font. */
const SYSTEM_FONT = /^(?:sf pro|sf compact|san francisco|segoe ui)\b/;
const SYSTEM_STACK = new Set(["-apple-system", "blinkmacsystemfont", "system-ui", "ui-sans-serif"]);
/** The words a font file's name adds to its family for a weight or a slant (`Acme Sans` as `AcmeSans-SemiBold`). */
const STYLE_WORDS = [
  ...["extra", "ultra", "semi", "demi", "thin", "hairline", "light", "book", "regular", "normal", "roman"],
  ...["medium", "bold", "black", "heavy", "italic", "oblique"],
];
const squash = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Whether `rest` is only weight and slant words. */
function styleOnly(rest) {
  let left = rest;
  while (left !== "") {
    const word = STYLE_WORDS.find((w) => left.endsWith(w));
    if (word === undefined) return false;
    left = left.slice(0, -word.length);
  }
  return true;
}

/**
 * Whether a computed `font-family` gives the design's font: its first family is that name, that name written as a
 * font file writes it (without spaces, with its weight), or the system's interface font where the design names one.
 */
export function sameFamily(design, built) {
  const want = String(design).trim().toLowerCase();
  const first = String(built ?? "")
    .split(",")[0]
    .replace(/["']/g, "")
    .trim()
    .toLowerCase();
  if (first === want) return true;
  if (SYSTEM_FONT.test(want) && SYSTEM_STACK.has(first)) return true;
  const [a, b] = [squash(want), squash(first)];
  return a !== "" && b.startsWith(a) && styleOnly(b.slice(a.length));
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

/** How far the built shadows are from the design's: another count, side or colour is a mismatch. */
function shadowLevel(want, got) {
  if (got.length !== want.length) return MISMATCH;
  let worst = 0;
  for (const [i, a] of want.entries()) {
    const b = got[i];
    if (!a || !b || a.inset !== b.inset) return MISMATCH;
    const off = Math.max(...["x", "y", "blur", "spread"].map((k) => Math.abs(a[k] - b[k])));
    worst = Math.max(worst, levelOf(off, SHADOW_PX), colourLevel(a.colour, b.colour));
  }
  return worst;
}

/**
 * Node types that state their own background, corners, border and shadow, absent meaning none. A component instance
 * is not one: its look is the design kit's, drawn on layers inside it that the tree does not list, so only what the
 * instance itself states is compared.
 */
const DRAWN = new Set(["FRAME", "RECTANGLE"]);
const TEXT_CASE = { UPPER: "uppercase", LOWER: "lowercase", TITLE: "capitalize" };
const DECORATION = { UNDERLINE: "underline", STRIKETHROUGH: "line-through" };
const AXES = ["x", "y", "width", "height"];
const fmt = (v) => (Array.isArray(v) ? `[${v.join(", ")}]` : String(v));
const signed = (n) => `${n > 0 ? "+" : ""}${round(n)}`;

/** The node `id` of a design tree, or undefined. */
function find(node, id) {
  if (!isObject(node)) return undefined;
  if (node.id === id) return node;
  for (const child of Array.isArray(node.children) ? node.children : []) {
    const found = find(child, id);
    if (found) return found;
  }
  return undefined;
}

/** Every node id of a design tree. */
function idsOf(node, into = new Set()) {
  if (!isObject(node)) return into;
  if (typeof node.id === "string") into.add(node.id);
  for (const child of Array.isArray(node.children) ? node.children : []) idsOf(child, into);
  return into;
}

/**
 * What differs between a frame's node tree and the measured page, for each tagged node: its box, text style, colours,
 * corners, border, opacity and shadows. `mismatches` are to fix; `notes` are small differences. A position is judged
 * by where the node's surroundings put it: a node that moved as its container did (its start, centre or end) or as one
 * of the nodes just before it in the same container, or that still reaches its container's far edge, is not listed
 * again, so that one shifted or resized node counts once. `within` names the nodes to compare, each with what is in
 * it, instead of the frame.
 */
export function compareFrame(tree, measured, { within = [] } = {}) {
  if (!isObject(tree) || !isObject(tree.root)) throw new Error("the frame tree has no root node");
  if (!isObject(measured) || !Array.isArray(measured.nodes)) throw new Error("the measurement has no nodes");
  const byId = new Map();
  for (const node of measured.nodes) if (isObject(node) && typeof node.id === "string") byId.set(node.id, node);
  const tops = within.map((id) => {
    const node = find(tree.root, id);
    if (!node) throw new Error(`--within ${id} is not a node of frame ${tree.id}`);
    if (!Array.isArray(byId.get(id)?.box)) throw new Error(`--within ${id} is not tagged on the page: tag its element`);
    return node;
  });
  if (tops.length === 0) tops.push(tree.root);
  const mismatches = [];
  const notes = [];
  const unmeasured = [];
  const seen = new Set();
  let compared = 0;

  /**
   * Compares `design` and what is in it. `origin` is the page position of the frame's corner; `container` is the
   * nearest measured node around it and `peers` the measured nodes before it in that container, each as
   * `{id, design, built, shift, grow}` (boxes from the frame's corner).
   */
  const visit = (design, origin, container, peers) => {
    if (!isObject(design) || seen.has(design.id)) return;
    const built = byId.get(design.id);
    const label = `${design.id} "${String(design.name ?? "").slice(0, 60)}"`;
    const say = (level, property, want, got, more = "") => {
      if (level > 0)
        (level === MISMATCH ? mismatches : notes).push(
          `${label} ${property}: design ${fmt(want)}, built ${fmt(got)}${more}`,
        );
    };
    const top = container === null && origin === null;
    let placed = null;
    let from = origin ?? [0, 0];
    if (!built) {
      if (design.type === "TEXT" || design.type === "INSTANCE" || design.fill || design.stroke)
        unmeasured.push(design.id);
    } else if (built.visible === false) {
      seen.add(design.id);
      compared++;
      say(MISMATCH, "visibility", "shown", "hidden");
    } else {
      seen.add(design.id);
      compared++;
      const font = isObject(design.font) ? design.font : null;
      const drawn = DRAWN.has(design.type);
      if (Array.isArray(design.box) && Array.isArray(built.box)) {
        // An auto-width text is as wide as its characters, which a block element is not: its x and width come from
        // the characters' box, its y and height (the line boxes) from the element's.
        const characters = design.type === "TEXT" && font?.textAutoResize === "WIDTH_AND_HEIGHT";
        const own =
          characters && Array.isArray(built.textBox)
            ? [built.textBox[0], built.box[1], built.textBox[2], built.box[3]]
            : built.box;
        // The node a comparison starts at is where it is: only its size is compared.
        if (top) from = [own[0] - design.box[0], own[1] - design.box[1]];
        const at = [own[0] - from[0], own[1] - from[1], own[2], own[3]].map(round);
        const shift = [at[0] - design.box[0], at[1] - design.box[1]].map(round);
        const grow = [at[2] - design.box[2], at[3] - design.box[3]].map(round);
        placed = { id: design.id, design: design.box, built: at, shift, grow };
        const moved = shift.map((s, a) => {
          const expected = container
            ? [container.shift[a], container.shift[a] + container.grow[a] / 2, container.shift[a] + container.grow[a]]
            : [0];
          for (const peer of peers.slice(-PEERS)) expected.push(peer.shift[a], peer.shift[a] + peer.grow[a]);
          return expected.map((e) => round(s - e)).reduce((best, off) => (Math.abs(off) < Math.abs(best) ? off : best));
        });
        // A node whose far edge moved as its container's did stretches to it: its size follows from where it starts.
        const grown = grow.map((g, a) =>
          container && Math.abs(round(shift[a] + g - container.shift[a] - container.grow[a])) <= BOX_PX ? 0 : g,
        );
        const off = top ? [0, 0, ...grown] : [...moved, ...grown];
        const levels = off.map((o, i) => {
          const level = levelOf(Math.abs(o), [BOX_PX, BOX_MISMATCH_PX]);
          const loose = i === 2 && characters && Math.abs(o) <= TEXT_WIDTH_SHARE * design.box[2];
          return loose ? Math.min(level, NOTE) : level;
        });
        const named = off.flatMap((o, i) => (levels[i] > 0 ? [`${AXES[i]} ${signed(o)}`] : [])).join(", ");
        if (top) say(Math.max(...levels), "size", design.box.slice(2), at.slice(2), ` (${named})`);
        else {
          const inside = container && container.id !== tree.id ? container : null;
          const corner = (box, c) => (c ? [round(box[0] - c[0]), round(box[1] - c[1]), box[2], box[3]] : box);
          say(
            Math.max(...levels),
            inside ? `box in ${inside.id}` : "box",
            corner(design.box, inside?.design),
            corner(at, inside?.built),
            ` (${named})`,
          );
        }
      }
      if (design.type === "TEXT" && font) {
        if (font.fontFamily && !sameFamily(font.fontFamily, built.fontFamily)) {
          const family = String(built.fontFamily ?? "")
            .split(",")[0]
            .replace(/["']/g, "")
            .trim();
          say(MISMATCH, "font-family", font.fontFamily, family);
        }
        if (font.fontSize !== undefined)
          say(
            levelOf(Math.abs(px(built.fontSize) - font.fontSize), FONT_PX),
            "font-size",
            `${font.fontSize}px`,
            built.fontSize,
          );
        if (font.fontWeight !== undefined && px(built.fontWeight) !== font.fontWeight)
          say(MISMATCH, "font-weight", font.fontWeight, built.fontWeight);
        if (font.lineHeightPx !== undefined && built.lineHeight !== "normal") {
          const line = px(built.lineHeight);
          const level = line === null ? MISMATCH : levelOf(Math.abs(line - font.lineHeightPx), LINE_PX);
          say(level, "line-height", `${font.lineHeightPx}px`, built.lineHeight);
        }
        const spacing = built.letterSpacing === "normal" ? 0 : px(built.letterSpacing);
        if (font.letterSpacing !== undefined)
          say(
            levelOf(Math.abs((spacing ?? 0) - font.letterSpacing), SPACING_PX),
            "letter-spacing",
            `${font.letterSpacing}px`,
            built.letterSpacing,
          );
        const transform = TEXT_CASE[font.textCase] ?? "none";
        if ((built.textTransform ?? "none") !== transform)
          say(MISMATCH, "text-transform", transform, built.textTransform);
        const decoration = DECORATION[font.textDecoration] ?? "none";
        if ((built.textDecoration ?? "none") !== decoration)
          say(MISMATCH, "text-decoration", decoration, built.textDecoration);
        if (design.fill) {
          const colour = cssHex(built.color);
          say(colourLevel(design.fill, colour), "color", design.fill, colour ?? built.color);
        }
      } else if (!clear(design.fill)) {
        const own = cssHex(built.background);
        const shown = clear(own) ? cssHex(built.backdrop) : own;
        say(colourLevel(design.fill, shown), "background", design.fill, shown ?? built.background);
      } else if (drawn && !design.paints) {
        // No fill in the design: a background of the built element's own shows unless it is the one behind it.
        const own = cssHex(built.background);
        if (!clear(own) && own !== cssHex(built.backdrop)) say(MISMATCH, "background", "none", own);
      }
      const corners = Array.isArray(design.radii)
        ? design.radii
        : design.radius
          ? Array(4).fill(design.radius)
          : drawn
            ? [0, 0, 0, 0]
            : null;
      if (corners && Array.isArray(built.radius)) {
        // A corner is never rounder than half its box's shorter side, whatever its radius says.
        const half = (box) => (Array.isArray(box) ? Math.min(box[2], box[3]) / 2 : Infinity);
        const want = corners.map((r) => round(Math.min(r, half(design.box))));
        const got = built.radius.map((r) => round(Math.min(px(r) ?? 0, half(built.box))));
        say(levelOf(Math.max(...want.map((r, i) => Math.abs(r - got[i]))), RADIUS_PX), "border-radius", want, got);
      }
      if (design.stroke && Array.isArray(built.borderWidth)) {
        const want = Array.isArray(design.strokeWeights)
          ? design.strokeWeights
          : Array(4).fill(design.strokeWeight ?? 1);
        const got = built.borderWidth.map((w) => px(w) ?? 0);
        const missing = got.every((w) => w <= WIDTH_PX[0]) && want.some((w) => w > WIDTH_PX[0]);
        const width = levelOf(Math.max(...want.map((w, i) => Math.abs(w - got[i]))), WIDTH_PX);
        say(missing ? MISMATCH : width, "border-width", want, got);
        const colours = [...new Set((built.borderColor ?? []).filter((_, i) => got[i] > 0).map(cssHex))];
        say(Math.max(0, ...colours.map((c) => colourLevel(design.stroke, c))), "border-color", design.stroke, colours);
      } else if (drawn && Array.isArray(built.borderWidth)) {
        const got = built.borderWidth.map((w) => px(w) ?? 0);
        if (got.some((w) => w > WIDTH_PX[0])) say(MISMATCH, "border-width", "none", got);
      }
      if (design.opacity !== undefined)
        say(
          levelOf(Math.abs((px(built.opacity) ?? 1) - design.opacity), OPACITY),
          "opacity",
          design.opacity,
          built.opacity,
        );
      const shadows = (design.effects ?? []).filter((e) => /^(box|text)-shadow:/.test(e)).map((e) => shadowOf(e));
      if (shadows.length > 0 && design.type !== "TEXT") {
        const got = built.boxShadow && built.boxShadow !== "none" ? splitList(built.boxShadow).map(shadowOf) : [];
        say(
          shadowLevel(shadows, got),
          "box-shadow",
          design.effects.filter((e) => e.startsWith("box-shadow:")).map((e) => e.slice(12)),
          built.boxShadow,
        );
      } else if (shadows.length === 0 && drawn && built.boxShadow && built.boxShadow !== "none")
        say(MISMATCH, "box-shadow", "none", built.boxShadow);
    }
    // What is in a node that was not measured stands in its place, among the same nodes.
    const inner = placed ? [] : peers;
    if (placed) peers.push(placed);
    for (const child of Array.isArray(design.children) ? design.children : [])
      visit(child, from, placed ?? container, inner);
  };
  for (const top of tops) visit(top, null, null, []);

  const inFrame = idsOf(tree.root);
  const others = [...byId.keys()].filter((id) => !seen.has(id) && id !== tree.id);
  const outside = within.length > 0 ? others.filter((id) => inFrame.has(id)) : [];
  const unknown = others.filter((id) => !outside.includes(id));
  if (within.length > 0)
    notes.unshift(
      `frame ${tree.id} compared within ${within.join(", ")} only: ${outside.length} tagged node(s) outside not compared`,
    );
  const header =
    `frame ${tree.id} "${String(tree.name ?? "").slice(0, 60)}": ${compared} node(s) measured; ` +
    `${mismatches.length} mismatch(es) to fix; ${notes.length} note(s)`;
  const footer = [
    ...(unmeasured.length > 0
      ? [
          `not measured: ${unmeasured.length} node(s) with text, a component or a colour, e.g. ${unmeasured.slice(0, 10).join(", ")}`,
        ]
      : []),
    ...(unknown.length > 0 ? [`tagged but not in this frame: ${unknown.slice(0, 10).join(", ")}`] : []),
  ];
  return { header, mismatches, notes, footer, compared, unmeasured: unmeasured.length };
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

/** What the command prints: the summary, the mismatches, the notes (at most `NOTES_SHOWN`) and what was not compared. */
export function printed(result) {
  const more = result.notes.length - NOTES_SHOWN;
  return [
    result.header,
    ...(result.mismatches.length > 0 ? ["mismatches, to fix:", ...result.mismatches] : []),
    ...(result.notes.length > 0 ? ["notes, nothing to fix:", ...result.notes.slice(0, NOTES_SHOWN)] : []),
    ...(more > 0 ? [`... and ${more} more note(s)`] : []),
    ...result.footer,
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [treePath, measuredPath, ...rest] = process.argv.slice(2);
  const within = rest.filter((_, i) => i % 2 === 1);
  if (!treePath || !measuredPath || rest.length % 2 !== 0 || rest.some((arg, i) => i % 2 === 0 && arg !== "--within")) {
    console.error("usage: node compare.mjs <frame tree .json> <measured .json> [--within <node id>]...");
    process.exit(2);
  }
  let result;
  try {
    result = compareFrame(
      JSON.parse(readFileSync(treePath, "utf8")),
      readMeasured(readFileSync(measuredPath, "utf8")),
      {
        within,
      },
    );
  } catch (error) {
    console.error(`design check: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  console.log(printed(result));
  process.exit(result.mismatches.length > 0 ? 1 : 0);
}
