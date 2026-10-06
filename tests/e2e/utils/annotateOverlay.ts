/**
 * The in-page half of the guide annotations: a self-contained DOM function
 * with no imports, so it can be stringified and run inside the app's WebView
 * by any driver — WebDriver on desktop (annotate.ts) or the DevTools protocol
 * on the Android emulator (tests/android/guide-shots/shots.ts).
 */
export type Mark = {
  /** CSS selector; the first visible match (or the `nth` one) is used. */
  selector: string;
  /** Pick the nth visible match instead of the first (0-based). */
  nth?: number;
  /** Only consider matches whose text contains this (case-insensitive). */
  text?: string;
  /** Number shown in the badge on the box's top-left corner. */
  n?: number;
  /** Short text drawn next to the mark. */
  caption?: string;
  /** Where the caption sits relative to the box. */
  side?: "top" | "bottom" | "left" | "right";
  /** Extra space around the element, in CSS px. */
  pad?: number;
  /** Draw a circle instead of a rounded rectangle. */
  circle?: boolean;
  /**
   * Where the number sits: on the box's top-left corner (default), or
   * centred above/below it — for rows of small buttons where corner badges
   * would land on the neighbour.
   */
  badge?: "corner" | "above" | "below";
  /** Skip the outline (badge/caption only). */
  noBox?: boolean;
};

export type AnnotateOptions = {
  style?: "callouts" | "spotlight";
};

export type Box = { x: number; y: number; w: number; h: number };

export const OVERLAY_ID = "lt-guide-annotations";

export const drawMarks = (marksArg: Mark[], style: string, overlayId: string) => {
  document.getElementById(overlayId)?.remove();
  const ns = "http://www.w3.org/2000/svg";
  const W = window.innerWidth;
  const H = window.innerHeight;
  const svg = document.createElementNS(ns, "svg");
  svg.id = overlayId;
  svg.setAttribute("width", String(W));
  svg.setAttribute("height", String(H));
  svg.setAttribute(
    "style",
    "position:fixed;inset:0;z-index:2147483647;pointer-events:none;" +
      "font-family:Inter,Segoe UI,system-ui,sans-serif",
  );
  // Mounted first: text can only be measured once it is in the document.
  document.body.appendChild(svg);
  const accent = "#FFC21A";
  const ink = "#111";
  const notFound: string[] = [];
  const drawn: Array<{ x: number; y: number; w: number; h: number }> = [];
  const add = (tag: string, attrs: Record<string, string | number>) => {
    const node = document.createElementNS(ns, tag);
    Object.keys(attrs).forEach((k) => node.setAttribute(k, String(attrs[k])));
    svg.appendChild(node);
    return node;
  };

  const boxes: Array<{ x: number; y: number; w: number; h: number; m: Mark }> = [];
  marksArg.forEach((m) => {
    const el = Array.from(document.querySelectorAll(m.selector)).filter((e) => {
      const r = e.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      return !m.text || (e.textContent ?? "").toLowerCase().includes(m.text.toLowerCase());
    })[m.nth ?? 0];
    if (!el) {
      notFound.push(m.selector);
      return;
    }
    const r = el.getBoundingClientRect();
    const p = m.pad ?? 4;
    const b = { x: r.left - p, y: r.top - p, w: r.width + 2 * p, h: r.height + 2 * p, m };
    boxes.push(b);
    drawn.push({ x: b.x, y: b.y, w: b.w, h: b.h });
  });

  if (style === "spotlight") {
    const defs = add("defs", {});
    const mask = document.createElementNS(ns, "mask");
    mask.id = `${overlayId}-mask`;
    defs.appendChild(mask);
    const hole = (attrs: Record<string, string | number>) => {
      const node = document.createElementNS(ns, "rect");
      Object.keys(attrs).forEach((k) => node.setAttribute(k, String(attrs[k])));
      mask.appendChild(node);
    };
    hole({ width: W, height: H, fill: "white" });
    boxes.forEach((b) => hole({ x: b.x, y: b.y, width: b.w, height: b.h, rx: 8, fill: "black" }));
    add("rect", { width: W, height: H, fill: "rgba(0,0,0,0.62)", mask: `url(#${overlayId}-mask)` });
  }

  boxes.forEach((b) => {
    const { m } = b;
    if (m.noBox) {
      // badge/caption only
    } else if (m.circle) {
      add("ellipse", {
        cx: b.x + b.w / 2,
        cy: b.y + b.h / 2,
        rx: b.w / 2 + 4,
        ry: b.h / 2 + 4,
        fill: "none",
        stroke: accent,
        "stroke-width": 3,
      });
    } else {
      add("rect", {
        x: b.x,
        y: b.y,
        width: b.w,
        height: b.h,
        rx: 8,
        fill: "none",
        stroke: accent,
        "stroke-width": 3,
      });
    }

    // Badge sits ON the top-left corner, so it can never be read as
    // belonging to a neighbouring box. Clamped to stay inside the frame.
    const R = 12;
    if (m.n !== undefined) {
      const where = m.badge ?? "corner";
      let cx = b.x;
      let cy = b.y;
      if (where !== "corner") cx = b.x + b.w / 2;
      if (where === "above") cy = b.y - R - 4;
      if (where === "below") cy = b.y + b.h + R + 4;
      cx = Math.min(Math.max(cx, R + 2), W - R - 2);
      cy = Math.min(Math.max(cy, R + 2), H - R - 2);
      add("circle", { cx, cy, r: R, fill: accent, stroke: ink, "stroke-width": 1.5 });
      const t = add("text", {
        x: cx,
        y: cy + 5,
        "text-anchor": "middle",
        "font-size": 14,
        "font-weight": 800,
        fill: ink,
      });
      t.textContent = String(m.n);
      drawn.push({ x: cx - R, y: cy - R, w: 2 * R, h: 2 * R });
    }

    if (m.caption) {
      const t = add("text", { "font-size": 15, "font-weight": 700, fill: ink }) as SVGTextElement;
      t.textContent = m.caption;
      const tw = t.getComputedTextLength();
      const bw = tw + 16;
      const bh = 26;
      const side = m.side ?? "bottom";
      let tx = b.x + b.w / 2 - bw / 2;
      let ty = b.y + b.h + 8;
      if (side === "top") ty = b.y - bh - 8;
      if (side === "left") {
        tx = b.x - bw - 10;
        ty = b.y + b.h / 2 - bh / 2;
      }
      if (side === "right") {
        tx = b.x + b.w + 10;
        ty = b.y + b.h / 2 - bh / 2;
      }
      tx = Math.min(Math.max(tx, 4), W - bw - 4);
      ty = Math.min(Math.max(ty, 4), H - bh - 4);
      const bg = document.createElementNS(ns, "rect");
      [
        ["x", tx],
        ["y", ty],
        ["width", bw],
        ["height", bh],
        ["rx", 6],
        ["fill", accent],
      ].forEach(([k, v]) => bg.setAttribute(String(k), String(v)));
      svg.insertBefore(bg, t);
      t.setAttribute("x", String(tx + 8));
      t.setAttribute("y", String(ty + 18));
      drawn.push({ x: tx, y: ty, w: bw, h: bh });
    }
  });

  return { notFound, drawn };
};
