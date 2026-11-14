#!/usr/bin/env node
// Ahoy design check: compares what measure.js measured on the built page with a Figma frame's node tree (the harness's
// specs/<KEY>/design/frames/<frame>.json) and prints what differs, one line each, in two levels: a mismatch, to fix,
// and a note, a small difference that needs no fix (a design and its build seldom match to the pixel).
//
//   node .github/skills/ahoy-design-check/compare.mjs <frame tree .json> <measured .json> [--within <node id>]...
//
// Exit 0: no mismatch, with or without notes. Exit 1: mismatches, printed. Exit 2: an input it cannot read.
// Boxes are compared from the frame's corner: from the element tagged with the frame's own id when there is one,
// else from the page's corner. `--within` compares only what is in that node of the frame, from its corner: the part
// a package builds of a frame that also shows the application around it.
// No dependency: Node's standard library only.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * What each value may be off by: beyond `note` it is noted, beyond `mismatch` it is a mismatch. Pixels, but for
 * `colour` (a channel, of 255: 8 is about 3%) and `opacity` (of 1). The skill's table says the same.
 */
export const LIMITS = {
  box: { note: 2, mismatch: 8 },
  colour: { note: 0, mismatch: 8 },
  fontSize: { note: 0.5, mismatch: 1 },
  lineHeight: { note: 1, mismatch: 2 },
  letterSpacing: { note: 0.5, mismatch: 2 },
  radius: { note: 1, mismatch: 4 },
  borderWidth: { note: 0.5, mismatch: 1 },
  shadow: { note: 1, mismatch: 4 },
  opacity: { note: 0.02, mismatch: 0.1 },
};
/** The share of its own size beyond which a size that is off is a mismatch, however few pixels that is. */
export const SIZE_SHARE = 0.15;
/** The share of its width an auto-width text may be off by and stay a note: its characters are as wide as the browser's font. */
export const TEXT_WIDTH_SHARE = 0.1;
/** The share of its container a node spans, from which it may be one that stretches to the container's far edge. */
const STRETCH_SHARE = 0.5;
/** How many of the measured nodes just before a node, in its container, it may have moved or grown with. */
const PEERS = 4;
/** The most notes printed for one frame; the rest are counted. */
export const NOTES_SHOWN = 20;
/** The most nodes named in the line of those that were not measured. */
const UNMEASURED_SHOWN = 10;

const SAME = 0;
const NOTE = 1;
const MISMATCH = 2;

/** `SAME` when `off` is within the limit's note, `NOTE` within its mismatch, else `MISMATCH`; a value that is no number is one. */
function levelOf(off, limit) {
  if (!Number.isFinite(off) || off > limit.mismatch) return MISMATCH;
  return off > limit.note ? NOTE : SAME;
}
/** The worst of some levels, `SAME` for none. */
const worst = (levels) => levels.reduce((a, b) => Math.max(a, b), SAME);
/** How far the furthest of two lists' values are apart; no number when one is. */
const furthest = (want, got) => want.reduce((far, w, i) => Math.max(far, Math.abs(w - got[i])), 0);

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

/** How far two colours are apart: the same, a note when nearly the same on every channel, else a mismatch. */
function colourLevel(want, got) {
  if (want === got) return SAME;
  const [one, other] = [channels(want), channels(got)];
  if (!one || !other) return MISMATCH;
  return levelOf(furthest(one, other), LIMITS.colour);
}

/** Whether a colour shows nothing: none, or fully transparent. */
const isClear = (hex) => !hex || /^#[0-9a-f]{6}00$/i.test(hex);

/** The font families a browser's own interface font stands for, and the names CSS gives that font. */
const SYSTEM_FONT = /^(?:sf pro|sf compact|san francisco|segoe ui)\b/;
const SYSTEM_STACK = new Set(["-apple-system", "blinkmacsystemfont", "system-ui", "ui-sans-serif"]);
/** The words a font file's name adds to its family for a weight or a slant (`Acme Sans` as `AcmeSans-SemiBold`). */
const STYLE_WORDS = [
  ...["extra", "ultra", "semi", "demi", "thin", "hairline", "light", "book", "regular", "normal", "roman"],
  ...["medium", "bold", "black", "heavy", "italic", "oblique"],
];
const squash = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
/** The first family of a computed `font-family`, without its quotes. */
const firstFamily = (stack) =>
  String(stack ?? "")
    .split(",")[0]
    .replace(/["']/g, "")
    .trim();

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
  const first = firstFamily(built).toLowerCase();
  if (first === want) return true;
  if (SYSTEM_FONT.test(want) && SYSTEM_STACK.has(first)) return true;
  const [name, file] = [squash(want), squash(first)];
  return name !== "" && file.startsWith(name) && styleOnly(file.slice(name.length));
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
  return worst(
    want.map((shadow, i) => {
      const other = got[i];
      if (!shadow || !other || shadow.inset !== other.inset) return MISMATCH;
      const sides = ["x", "y", "blur", "spread"];
      const off = furthest(
        sides.map((k) => shadow[k]),
        sides.map((k) => other[k]),
      );
      return Math.max(levelOf(off, LIMITS.shadow), colourLevel(shadow.colour, other.colour));
    }),
  );
}

/** Node types that state their own background, corners, border and shadow, absent meaning none. */
const DRAWN = new Set(["FRAME", "RECTANGLE"]);
/**
 * Node types that are a component of the design kit. Its corners, border, shadow and opacity are the kit's, drawn on
 * layers inside it that the tree does not list: where the node itself states one, a difference is a note at most, and
 * where it states none, nothing is compared. Its fill is compared as any node's: it tells its variant.
 */
const KIT = new Set(["INSTANCE", "COMPONENT"]);
const TEXT_CASE = { UPPER: "uppercase", LOWER: "lowercase", TITLE: "capitalize" };
const DECORATION = { UNDERLINE: "underline", STRIKETHROUGH: "line-through" };
const AXES = ["x", "y", "width", "height"];
const fmt = (v) => (Array.isArray(v) ? `[${v.join(", ")}]` : String(v));
const signed = (n) => `${n > 0 ? "+" : ""}${round(n)}`;
const named = (node) => `${node.id} "${String(node.name ?? "").slice(0, 60)}"`;
const childrenOf = (node) => (Array.isArray(node.children) ? node.children : []);
/** Whether a design node is one a person sees: a text, a component, or a box with a colour. */
const shows = (node) => node.type === "TEXT" || node.type === "INSTANCE" || Boolean(node.fill) || Boolean(node.stroke);

/** The node `id` of a design tree, or undefined. */
function find(node, id) {
  if (!isObject(node)) return undefined;
  if (node.id === id) return node;
  for (const child of childrenOf(node)) {
    const found = find(child, id);
    if (found) return found;
  }
  return undefined;
}

/** Every node of a design tree that `keep` takes, the tree's own first. */
function nodesOf(node, keep, into = []) {
  if (!isObject(node)) return into;
  if (keep(node)) into.push(node);
  for (const child of childrenOf(node)) nodesOf(child, keep, into);
  return into;
}

const isBox = (v) => Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === "number" && Number.isFinite(n));
const isSides = (v) => Array.isArray(v) && v.length === 4 && v.every((s) => typeof s === "string");

/**
 * The measured nodes by id, each checked to be what measure.js writes: a measurement of another shape is an input
 * this cannot read, never a page that matches.
 */
function measuredNodes(measured) {
  const byId = new Map();
  for (const node of measured.nodes) {
    if (!isObject(node) || typeof node.id !== "string") continue;
    const wrong = [
      ["box", isBox(node.box)],
      ["textBox", node.textBox === null || node.textBox === undefined || isBox(node.textBox)],
      ["radius", isSides(node.radius)],
      ["borderWidth", isSides(node.borderWidth)],
      ["borderColor", isSides(node.borderColor)],
    ].find(([, ok]) => !ok);
    if (wrong) throw new Error(`the measurement of node ${node.id} has no ${wrong[0]} as measure.js writes it`);
    byId.set(node.id, node);
  }
  return byId;
}

/**
 * How far a placed node moved on one axis beyond where its surroundings put it: its container (it kept its distance
 * to the container's start, its share of the container, its distance to the far edge when it is nearer that one, or
 * its place in the middle when it is centred) or one of the nodes just before it (it moved as that one did, or still
 * follows that one's end).
 */
function movedOn(axis, node, container, peers) {
  const start = node.design[axis];
  const size = node.design[axis + 2];
  const near = (off) => Math.abs(round(off)) <= LIMITS.box.note;
  // Where it would be had it kept a distance, and where had it kept a share: a share explains a move or does not.
  const kept = [];
  const shared = [];
  if (container) {
    const whole = container.design[axis + 2];
    const before = start - container.design[axis];
    const after = container.design[axis] + whole - start - size;
    const [shift, grow] = [container.shift[axis], container.grow[axis]];
    kept.push(shift);
    if (after < before) kept.push(shift + grow);
    if (whole > 0) shared.push(shift + (grow * before) / whole);
    if (Math.abs(after - before) <= 2 * LIMITS.box.note) shared.push(shift + grow / 2);
  } else kept.push(0);
  for (const peer of peers) {
    kept.push(peer.shift[axis]);
    const follows = start >= peer.design[axis] + peer.design[axis + 2] - LIMITS.box.note;
    if (follows) kept.push(peer.shift[axis] + peer.grow[axis]);
  }
  if (shared.some((e) => near(node.shift[axis] - e))) return 0;
  return kept
    .map((e) => round(node.shift[axis] - e))
    .reduce((best, off) => (Math.abs(off) < Math.abs(best) ? off : best));
}

/**
 * How far a placed node grew on one axis beyond what its surroundings explain: it stretches to its container's far
 * edge (it spans half the container or more, and that edge moved as the container's did), it kept its share of the
 * container, or it grew as a node of its size just before it did (the next row, the next card).
 */
function grownOn(axis, node, container, peers) {
  const size = node.design[axis + 2];
  const grow = node.grow[axis];
  const near = (off) => Math.abs(round(off)) <= LIMITS.box.note;
  if (container) {
    const [whole, more] = [container.design[axis + 2], container.grow[axis]];
    const stretches = size >= STRETCH_SHARE * whole && near(node.shift[axis] + grow - container.shift[axis] - more);
    const keepsShare = whole > 0 && near(grow - (more * size) / whole);
    if (stretches || keepsShare) return 0;
  }
  const asBefore = peers.some((peer) => near(peer.design[axis + 2] - size) && near(peer.grow[axis] - grow));
  return asBefore ? 0 : grow;
}

/** The level of one box value that is `off`: a size is also judged by its share of the design's. */
function boxLevel(off, index, design, autoWidth) {
  const level = levelOf(Math.abs(off), LIMITS.box);
  if (index < 2 || level === SAME) return level;
  const share = Math.abs(off) / design.box[index];
  if (autoWidth && index === 2) return share <= TEXT_WIDTH_SHARE ? NOTE : level;
  return design.type !== "TEXT" && share > SIZE_SHARE ? MISMATCH : level;
}

/** Compares a text's font and colour. */
function compareText(design, font, built, say) {
  if (font.fontFamily && !sameFamily(font.fontFamily, built.fontFamily))
    say(MISMATCH, "font-family", font.fontFamily, firstFamily(built.fontFamily));
  if (font.fontSize !== undefined) {
    const off = Math.abs(px(built.fontSize) - font.fontSize);
    say(levelOf(off, LIMITS.fontSize), "font-size", `${font.fontSize}px`, built.fontSize);
  }
  if (font.fontWeight !== undefined && px(built.fontWeight) !== font.fontWeight)
    say(MISMATCH, "font-weight", font.fontWeight, built.fontWeight);
  if (font.lineHeightPx !== undefined && built.lineHeight !== "normal") {
    const off = Math.abs(px(built.lineHeight) - font.lineHeightPx);
    say(levelOf(off, LIMITS.lineHeight), "line-height", `${font.lineHeightPx}px`, built.lineHeight);
  }
  if (font.letterSpacing !== undefined) {
    const spacing = built.letterSpacing === "normal" ? 0 : px(built.letterSpacing);
    const off = Math.abs(spacing - font.letterSpacing);
    say(levelOf(off, LIMITS.letterSpacing), "letter-spacing", `${font.letterSpacing}px`, built.letterSpacing);
  }
  const transform = TEXT_CASE[font.textCase] ?? "none";
  if ((built.textTransform ?? "none") !== transform) say(MISMATCH, "text-transform", transform, built.textTransform);
  const decoration = DECORATION[font.textDecoration] ?? "none";
  if ((built.textDecoration ?? "none") !== decoration)
    say(MISMATCH, "text-decoration", decoration, built.textDecoration);
  if (design.fill) {
    const colour = cssHex(built.color);
    say(colourLevel(design.fill, colour), "color", design.fill, colour ?? built.color);
  }
}

/** Compares a box's background: the design's fill, or none where the node states its own look. */
function compareBackground(design, built, say) {
  const own = cssHex(built.background);
  if (!isClear(design.fill)) {
    const shown = isClear(own) ? cssHex(built.backdrop) : own;
    say(colourLevel(design.fill, shown), "background", design.fill, shown ?? built.background);
  } else if (DRAWN.has(design.type) && !design.paints && !isClear(own) && own !== cssHex(built.backdrop)) {
    // No fill in the design: a background of the built element's own shows unless it is the one behind it.
    say(MISMATCH, "background", "none", own);
  }
}

/** Compares a box's corners, each no rounder than half its box's shorter side, as a browser draws it. */
function compareCorners(design, built, say) {
  const stated = Array.isArray(design.radii) ? design.radii : design.radius ? Array(4).fill(design.radius) : null;
  const corners = stated ?? (DRAWN.has(design.type) ? [0, 0, 0, 0] : null);
  if (!corners) return;
  const half = (box) => (Array.isArray(box) ? Math.min(box[2], box[3]) / 2 : Infinity);
  const want = corners.map((r) => round(Math.min(r, half(design.box))));
  const got = built.radius.map((r) => round(Math.min(px(r) ?? 0, half(built.box))));
  say(levelOf(furthest(want, got), LIMITS.radius), "border-radius", want, got);
}

/** Compares a box's border: the design's stroke, or none where the node states its own look. */
function compareBorder(design, built, say) {
  const got = built.borderWidth.map((w) => px(w) ?? 0);
  const drawn = (w) => w > LIMITS.borderWidth.note;
  if (design.stroke) {
    const want = Array.isArray(design.strokeWeights) ? design.strokeWeights : Array(4).fill(design.strokeWeight ?? 1);
    const missing = want.some(drawn) && !got.some(drawn);
    say(missing ? MISMATCH : levelOf(furthest(want, got), LIMITS.borderWidth), "border-width", want, got);
    const colours = [...new Set(built.borderColor.filter((_, i) => got[i] > 0).map(cssHex))];
    say(worst(colours.map((c) => colourLevel(design.stroke, c))), "border-color", design.stroke, colours);
  } else if (DRAWN.has(design.type) && got.some(drawn)) say(MISMATCH, "border-width", "none", got);
}

/** Compares a box's shadows: the design's, or none where the node states its own look. */
function compareShadows(design, built, say) {
  const shadows = (design.effects ?? []).filter((e) => /^(box|text)-shadow:/.test(e)).map((e) => shadowOf(e));
  const none = !built.boxShadow || built.boxShadow === "none";
  if (shadows.length > 0 && design.type !== "TEXT") {
    const want = design.effects.filter((e) => e.startsWith("box-shadow:")).map((e) => e.slice(12));
    say(
      shadowLevel(shadows, none ? [] : splitList(built.boxShadow).map(shadowOf)),
      "box-shadow",
      want,
      built.boxShadow,
    );
  } else if (shadows.length === 0 && DRAWN.has(design.type) && !none)
    say(MISMATCH, "box-shadow", "none", built.boxShadow);
}

/** Compares how a measured node looks: its text style, colours, corners, border, opacity and shadows. */
function compareLook(design, built, say) {
  const font = isObject(design.font) ? design.font : null;
  if (design.type === "TEXT" && font) compareText(design, font, built, say);
  else compareBackground(design, built, say);
  // What a kit component draws is the kit's: a difference in it is never more than a note.
  const kit = KIT.has(design.type) ? (level, ...line) => say(Math.min(level, NOTE), ...line) : say;
  compareCorners(design, built, kit);
  compareBorder(design, built, kit);
  if (design.opacity !== undefined) {
    const off = Math.abs((px(built.opacity) ?? 1) - design.opacity);
    kit(levelOf(off, LIMITS.opacity), "opacity", design.opacity, built.opacity);
  }
  compareShadows(design, built, kit);
}

/** The node as placed: its design box and its built box from the frame's corner, how far it moved and grew. */
function place(design, built, corner) {
  // An auto-width text is as wide as its characters, which a block element is not: its x and width come from
  // the characters' box, its y and height (the line boxes) from the element's.
  const autoWidth = design.type === "TEXT" && design.font?.textAutoResize === "WIDTH_AND_HEIGHT";
  const own = autoWidth && built.textBox ? [built.textBox[0], built.box[1], built.textBox[2], built.box[3]] : built.box;
  // The node a comparison starts at is where it is: what is in it is measured from its corner.
  const from = corner ?? [own[0] - design.box[0], own[1] - design.box[1]];
  const at = [own[0] - from[0], own[1] - from[1], own[2], own[3]].map(round);
  const shift = [at[0] - design.box[0], at[1] - design.box[1]].map(round);
  const grow = [at[2] - design.box[2], at[3] - design.box[3]].map(round);
  return { id: design.id, design: design.box, built: at, shift, grow, from, autoWidth };
}

/**
 * Says how a placed node's box is off. `frame` is the frame's own node when that is the one placed: only its size is
 * compared. A node in another node than the frame is given from that node's corner (`box in <id>`).
 */
function compareBox(design, node, { container, peers, frame }, say) {
  const moved = frame ? [0, 0] : [0, 1].map((axis) => movedOn(axis, node, container, peers));
  const off = [...moved, ...[0, 1].map((axis) => grownOn(axis, node, container, peers))];
  const levels = off.map((o, i) => boxLevel(o, i, design, node.autoWidth));
  const which = ` (${off.flatMap((o, i) => (levels[i] > SAME ? [`${AXES[i]} ${signed(o)}`] : [])).join(", ")})`;
  if (frame) {
    say(worst(levels), "size", node.design.slice(2), node.built.slice(2), which);
    return;
  }
  const from = (box, c) => (c ? [round(box[0] - c[0]), round(box[1] - c[1]), box[2], box[3]] : box);
  const inside = container && !container.frame ? container : null;
  const property = inside ? `box in ${inside.id}` : "box";
  say(worst(levels), property, from(node.design, inside?.design), from(node.built, inside?.built), which);
}

/**
 * What differs between a frame's node tree and the measured page, for each tagged node: its box, text style, colours,
 * corners, border, opacity and shadows. `mismatches` are to fix; `notes` are small differences. A box is judged by
 * where the node's surroundings put it (`movedOn`, `grownOn`), so that one shifted or resized node counts once and
 * not again for what is beside it and in it. `within` names the nodes whose insides to compare instead of the whole
 * frame; the summary then says how much of the frame is outside them.
 */
export function compareFrame(tree, measured, { within = [] } = {}) {
  if (!isObject(tree) || !isObject(tree.root)) throw new Error("the frame tree has no root node");
  if (!isObject(measured) || !Array.isArray(measured.nodes)) throw new Error("the measurement has no nodes");
  const byId = measuredNodes(measured);
  const scopes = within.map((id) => {
    const node = find(tree.root, id);
    if (!node || !Array.isArray(node.box)) throw new Error(`--within ${id} is not a node of frame ${tree.id}`);
    if (!byId.has(id)) throw new Error(`--within ${id} is not tagged on the page: tag its element`);
    return node;
  });
  const mismatches = [];
  const notes = [];
  const unmeasured = [];
  const seen = new Set();
  let compared = 0;

  /**
   * Compares `design` and what is in it. `corner` is the page position of the frame's corner, null for the node a
   * comparison starts at; `container` is the nearest measured node around it and `peers` the measured nodes before it
   * in that container. `scope` says the node only bounds a comparison (`--within`): it is placed, not compared.
   */
  const visit = (design, corner, container, peers, scope = false) => {
    if (!isObject(design) || seen.has(design.id)) return;
    const built = byId.get(design.id);
    const say = (level, property, want, got, more = "") => {
      if (level === SAME) return;
      const lines = level === MISMATCH ? mismatches : notes;
      lines.push(`${named(design)} ${property}: design ${fmt(want)}, built ${fmt(got)}${more}`);
    };
    let placed = null;
    if (!built) {
      if (shows(design)) unmeasured.push(design);
    } else {
      seen.add(design.id);
      if (!scope) compared++;
      if (built.visible === false) say(MISMATCH, "visibility", "shown", "hidden");
      else {
        if (Array.isArray(design.box)) {
          placed = { ...place(design, built, corner), frame: design.id === tree.id };
          const frame = placed.frame && container === null;
          if (!scope) compareBox(design, placed, { container, peers: peers.slice(-PEERS), frame }, say);
        }
        if (!scope) compareLook(design, built, say);
      }
    }
    // What is in a node that was not measured stands in its place, among the same nodes.
    const inner = placed ? [] : peers;
    if (placed) peers.push(placed);
    for (const child of childrenOf(design)) visit(child, placed?.from ?? corner ?? [0, 0], placed ?? container, inner);
  };
  if (scopes.length === 0) visit(tree.root, null, null, []);
  for (const scope of scopes) visit(scope, null, null, [], true);

  if (unmeasured.length > 0) {
    const more = unmeasured.length - UNMEASURED_SHOWN;
    mismatches.unshift(
      `frame ${tree.id} not measured: ${unmeasured.length} node(s) of the design with text, a component or a colour: ` +
        unmeasured.slice(0, UNMEASURED_SHOWN).map(named).join(", ") +
        (more > 0 ? ` and ${more} more` : ""),
    );
  } else if (compared === 0) mismatches.unshift(`frame ${tree.id} not measured: no tagged node to compare`);
  const inFrame = nodesOf(tree.root, shows);
  const inScope = new Set(scopes.flatMap((scope) => nodesOf(scope, shows)).map((node) => node.id));
  const outside = inFrame.filter((node) => !inScope.has(node.id)).length;
  const only =
    scopes.length > 0
      ? `, only within ${scopes.map(named).join(", ")} (${outside} of the frame's ${inFrame.length} node(s) with ` +
        "text, a component or a colour are outside)"
      : "";
  const header =
    `frame ${named(tree)}${only}: ${compared} node(s) measured; ` +
    `${mismatches.length} mismatch(es) to fix; ${notes.length} note(s)`;
  const known = new Set(nodesOf(tree.root, () => true).map((node) => node.id));
  const unknown = [...byId.keys()].filter((id) => !known.has(id));
  const footer = unknown.length > 0 ? [`tagged but not in this frame: ${unknown.slice(0, 10).join(", ")}`] : [];
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

/** What the command prints: the summary, the mismatches, the notes (at most `NOTES_SHOWN`) and what it could not place. */
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

/** The node ids `--within` names among a command's arguments after the two files, or null when one is not understood. */
function withinOf(args) {
  if (args.length % 2 !== 0 || args.some((arg, i) => i % 2 === 0 && arg !== "--within")) return null;
  return args.filter((_, i) => i % 2 === 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [treePath, measuredPath, ...rest] = process.argv.slice(2);
  const within = withinOf(rest);
  if (!treePath || !measuredPath || within === null) {
    console.error("usage: node compare.mjs <frame tree .json> <measured .json> [--within <node id>]...");
    process.exit(2);
  }
  let result;
  try {
    const tree = JSON.parse(readFileSync(treePath, "utf8"));
    result = compareFrame(tree, readMeasured(readFileSync(measuredPath, "utf8")), { within });
  } catch (error) {
    console.error(`design check: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  console.log(printed(result));
  process.exit(result.mismatches.length > 0 ? 1 : 0);
}
