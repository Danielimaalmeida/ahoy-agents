() => {
  // Ahoy design check: measures every element tagged data-figma-node="<Figma node id>" on the open page.
  // Pass this whole function to browser_evaluate, with filename set to .ahoy/design-check/<frame>.measured.json.
  const round = (n) => Math.round(n * 100) / 100;
  const transparent = (c) => !c || c === "transparent" || /^rgba\([^)]*,\s*0\)$/.test(c) || /\/\s*0\)$/.test(c);
  const backdrop = (el) => {
    for (let at = el.parentElement; at; at = at.parentElement) {
      const bg = getComputedStyle(at).backgroundColor;
      if (!transparent(bg)) return bg;
    }
    return "rgb(255, 255, 255)";
  };
  // The box of an element's characters, which an auto-width Figma text matches; null without text.
  const characters = (el) => {
    if (!(el.innerText || "").trim()) return null;
    const range = document.createRange();
    range.selectNodeContents(el);
    const t = range.getBoundingClientRect();
    return t.width > 0 ? [t.left + window.scrollX, t.top + window.scrollY, t.width, t.height].map(round) : null;
  };
  const nodes = [];
  for (const el of document.querySelectorAll("[data-figma-node]")) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    nodes.push({
      id: el.getAttribute("data-figma-node"),
      box: [r.left + window.scrollX, r.top + window.scrollY, r.width, r.height].map(round),
      textBox: characters(el),
      visible: cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0 && r.height > 0,
      color: cs.color,
      background: cs.backgroundColor,
      backdrop: backdrop(el),
      backgroundImage: cs.backgroundImage,
      fontFamily: cs.fontFamily,
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight,
      lineHeight: cs.lineHeight,
      letterSpacing: cs.letterSpacing,
      textTransform: cs.textTransform,
      textDecoration: cs.textDecorationLine,
      radius: [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius],
      borderWidth: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth],
      borderColor: [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor],
      opacity: cs.opacity,
      boxShadow: cs.boxShadow,
    });
  }
  return { v: 1, url: location.href, viewport: [window.innerWidth, window.innerHeight], nodes };
}
