"use client";

import { memo, useId } from "react";
import type { BeadVisual, CabOutline } from "@/lib/bead-visual";

// Renders a bead from its stored visual spec. `Bead` is an SVG <g> at the
// origin (for composing into the strand SVG); `BeadSwatch` wraps it in a
// standalone <svg> for palettes and previews. The strand axis is horizontal:
// length_mm runs along x, width_mm along y.

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [160, 160, 160];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Mix a hex color toward white (amount > 0) or black (amount < 0). */
function shade(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  const t = amount > 0 ? 255 : 0;
  const a = Math.abs(clamp(amount, -1, 1));
  const mix = (c: number) => Math.round(c + (t - c) * a);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

/** Deterministic PRNG seeded from a string, so a bead always draws the same. */
function seededRandom(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 15), h | 1);
    h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
    return ((h ^ (h >>> 14)) >>> 0) / 4294967296;
  };
}

/** Scale points so their extent fills [0,L]×[0,W] — keeps irregular shapes
 * from leaving gaps between beads on the strand. */
function fillBounds(points: [number, number][], L: number, W: number): [number, number][] {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const sx = maxX > minX ? L / (maxX - minX) : 1;
  const sy = maxY > minY ? W / (maxY - minY) : 1;
  return points.map(([x, y]) => [(x - minX) * sx, (y - minY) * sy]);
}

/** Closed smooth path through irregular points (for chips/nuggets). */
function blobPath(points: [number, number][]): string {
  const n = points.length;
  let d = "";
  for (let i = 0; i < n; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % n];
    const mx = (x0 + x1) / 2;
    const my = (y0 + y1) / 2;
    d += i === 0 ? `M ${mx} ${my} ` : "";
    const [x2, y2] = points[(i + 2) % n];
    d += `Q ${x1} ${y1} ${(x1 + x2) / 2} ${(y1 + y2) / 2} `;
  }
  return d + "Z";
}

type ShapeProps = React.SVGAttributes<SVGElement>;

/** Regular polygon inscribed in the L×W box, with the first vertex on the
 * -x edge so pointed outlines (triangle, pentagon) aim toward x=0 — the
 * end nearest the bail once a pendant is rotated to hang. */
function polygonPoints(n: number, L: number, W: number): [number, number][] {
  return Array.from({ length: n }, (_, i) => {
    const angle = Math.PI + (i / n) * Math.PI * 2;
    return [L / 2 + (Math.cos(angle) * L) / 2, W / 2 + (Math.sin(angle) * W) / 2];
  });
}

/** Closed SVG path for a cabochon face (or bezel recess) outline filling the
 * L×W box. `rand` only matters for the irregular outlines. */
export function outlinePath(
  outline: CabOutline | null | undefined,
  L: number,
  W: number,
  rand: () => number
): string {
  const poly = (pts: [number, number][]) =>
    `M ${pts.map(([x, y]) => `${x} ${y}`).join(" L ")} Z`;
  switch (outline) {
    case "rectangle": {
      const r = Math.min(L, W) * 0.12;
      return `M ${r} 0 H ${L - r} A ${r} ${r} 0 0 1 ${L} ${r} V ${W - r} A ${r} ${r} 0 0 1 ${L - r} ${W} H ${r} A ${r} ${r} 0 0 1 0 ${W - r} V ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`;
    }
    case "triangle":
      return poly([
        [0, W / 2],
        [L, 0],
        [L, W],
      ]);
    case "pentagon":
      return poly(polygonPoints(5, L, W));
    case "hexagon":
      return poly(polygonPoints(6, L, W));
    case "teardrop": {
      const r = W * 0.35;
      return `M 0 ${W / 2} Q ${L * 0.35} ${W * 0.04} ${L * 0.7} ${W / 2 - r} A ${r} ${r} 0 1 1 ${L * 0.7} ${W / 2 + r} Q ${L * 0.35} ${W * 0.96} 0 ${W / 2} Z`;
    }
    case "marquise":
      return `M 0 ${W / 2} Q ${L / 2} ${-W * 0.5} ${L} ${W / 2} Q ${L / 2} ${W * 1.5} 0 ${W / 2} Z`;
    case "trapiche":
      // Slices are cut round-to-hexagonal; a soft hexagon reads as either.
      return blobPath(fillBounds(polygonPoints(6, L, W), L, W));
    case "stalactite":
    case "freeform": {
      // Lumpy outline: more, gentler bumps for a slice than for a freeform
      // cut, which tends to have a few decisive facets.
      const n = outline === "stalactite" ? 12 : 7;
      const depth = outline === "stalactite" ? 0.18 : 0.26;
      const points: [number, number][] = [];
      for (let i = 0; i < n; i++) {
        const angle = (i / n) * Math.PI * 2;
        const jitter = 1 - depth + rand() * depth;
        points.push([
          L / 2 + Math.cos(angle) * (L / 2) * jitter,
          W / 2 + Math.sin(angle) * (W / 2) * jitter,
        ]);
      }
      return blobPath(fillBounds(points, L, W));
    }
    // oval, round, unknown
    default:
      return `M 0 ${W / 2} A ${L / 2} ${W / 2} 0 1 1 ${L} ${W / 2} A ${L / 2} ${W / 2} 0 1 1 0 ${W / 2} Z`;
  }
}

function shapeElement(visual: BeadVisual, L: number, W: number, rand: () => number) {
  switch (visual.shape) {
    case "cabochon": {
      const d = outlinePath(visual.outline, L, W, rand);
      return { el: (props: ShapeProps) => <path d={d} {...props} /> };
    }
    case "bicone":
      return {
        el: (props: ShapeProps) => (
          <polygon
            points={`0,${W / 2} ${L / 2},0 ${L},${W / 2} ${L / 2},${W}`}
            {...props}
          />
        ),
      };
    case "tube":
    case "heishi":
      return {
        el: (props: ShapeProps) => (
          <rect x={0} y={0} width={L} height={W} rx={Math.min(L, W) * 0.2} {...props} />
        ),
      };
    case "cube":
      return {
        el: (props: ShapeProps) => (
          <rect x={0} y={0} width={L} height={W} rx={Math.min(L, W) * 0.12} {...props} />
        ),
      };
    case "octagon": {
      // Cornerless cube: a square silhouette with the corners cut off.
      const cx = L * 0.29;
      const cy = W * 0.29;
      const pts = `${cx},0 ${L - cx},0 ${L},${cy} ${L},${W - cy} ${L - cx},${W} ${cx},${W} 0,${W - cy} 0,${cy}`;
      return { el: (props: ShapeProps) => <polygon points={pts} {...props} /> };
    }
    case "flower": {
      // Scalloped outline: alternating outer/inner radii smoothed into petals.
      const petals = 8;
      const points: [number, number][] = [];
      for (let i = 0; i < petals * 2; i++) {
        const angle = (i / (petals * 2)) * Math.PI * 2;
        const r = i % 2 === 0 ? 1 : 0.78;
        points.push([
          L / 2 + Math.cos(angle) * (L / 2) * r,
          W / 2 + Math.sin(angle) * (W / 2) * r,
        ]);
      }
      const d = blobPath(fillBounds(points, L, W));
      return { el: (props: ShapeProps) => <path d={d} {...props} /> };
    }
    case "arrow": {
      // Chevron pointing along the strand (>), notched at the back so a run
      // of them nests the way arrow beads do when strung.
      const pts = `0,0 ${L * 0.62},0 ${L},${W / 2} ${L * 0.62},${W} 0,${W} ${L * 0.38},${W / 2}`;
      return { el: (props: ShapeProps) => <polygon points={pts} {...props} /> };
    }
    case "teardrop": {
      const r = W * 0.35;
      const d = `M 0 ${W / 2} Q ${L * 0.35} ${W * 0.04} ${L * 0.7} ${W / 2 - r} A ${r} ${r} 0 1 1 ${L * 0.7} ${W / 2 + r} Q ${L * 0.35} ${W * 0.96} 0 ${W / 2} Z`;
      return { el: (props: ShapeProps) => <path d={d} {...props} /> };
    }
    case "chip":
    case "nugget": {
      const n = 9;
      const points: [number, number][] = [];
      for (let i = 0; i < n; i++) {
        const angle = (i / n) * Math.PI * 2;
        const jitter = 0.78 + rand() * 0.22;
        points.push([
          L / 2 + Math.cos(angle) * (L / 2) * jitter,
          W / 2 + Math.sin(angle) * (W / 2) * jitter,
        ]);
      }
      const d = blobPath(fillBounds(points, L, W));
      return { el: (props: ShapeProps) => <path d={d} {...props} /> };
    }
    // round, rondelle, oval, seed
    default:
      return {
        el: (props: ShapeProps) => (
          <ellipse cx={L / 2} cy={W / 2} rx={L / 2} ry={W / 2} {...props} />
        ),
      };
  }
}

/** Non-bead components (chain, clasps, rings, connectors) are mostly open
 * metal shapes — strokes and bars, not filled silhouettes — so they bypass
 * the gradient/pattern/facet pipeline and draw themselves directly. Returns
 * null for bead shapes. Cabochons deliberately fall through to the bead
 * pipeline: a flat-backed stone reads like a large domed bead cut to its
 * face outline (`outlinePath`).
 * Bezels and bails are open metal like the rest and draw here. */
function componentElement(
  visual: BeadVisual,
  L: number,
  W: number,
  paint: string
): React.ReactNode | null {
  switch (visual.shape) {
    case "chain": {
      // Alternating wide/narrow oval links to suggest interlocking.
      const linkL = Math.min(W * 1.5, Math.max(4, L / 4));
      const n = Math.max(2, Math.round(L / (linkL * 0.72)));
      const stride = n > 1 ? (L - linkL) / (n - 1) : 0;
      const sw = Math.max(0.8, W * 0.14);
      return (
        <g>
          {Array.from({ length: n }, (_, i) => (
            <ellipse
              key={i}
              cx={linkL / 2 + i * stride}
              cy={W / 2}
              rx={i % 2 === 0 ? linkL / 2 - sw / 2 : linkL * 0.3}
              ry={i % 2 === 0 ? W / 2 - sw / 2 : W * 0.3}
              fill="none"
              stroke={paint}
              strokeWidth={sw}
            />
          ))}
        </g>
      );
    }
    case "jump-ring": {
      const sw = Math.max(0.8, Math.min(L, W) * 0.16);
      return (
        <ellipse
          cx={L / 2}
          cy={W / 2}
          rx={L / 2 - sw / 2}
          ry={W / 2 - sw / 2}
          fill="none"
          stroke={paint}
          strokeWidth={sw}
        />
      );
    }
    case "toggle-clasp": {
      // Ring on the left, T-bar on the right.
      const ringR = Math.min(L * 0.3, W / 2);
      const barH = Math.max(1.5, W * 0.18);
      return (
        <g>
          <circle
            cx={ringR}
            cy={W / 2}
            r={Math.max(0.5, ringR - Math.max(0.8, ringR * 0.18) / 2)}
            fill="none"
            stroke={paint}
            strokeWidth={Math.max(0.8, ringR * 0.3)}
          />
          <rect
            x={L * 0.55}
            y={W / 2 - barH / 2}
            width={L * 0.45}
            height={barH}
            rx={barH / 2}
            fill={paint}
          />
          <line
            x1={ringR * 2}
            y1={W / 2}
            x2={L * 0.62}
            y2={W / 2}
            stroke={paint}
            strokeWidth={Math.max(0.8, barH * 0.4)}
          />
        </g>
      );
    }
    case "lobster-clasp": {
      // Small ring, then the claw body with its characteristic hook notch.
      const ringR = Math.min(L * 0.12, W * 0.26);
      const x0 = ringR * 2;
      return (
        <g>
          <circle
            cx={ringR}
            cy={W / 2}
            r={Math.max(1, ringR - 0.5)}
            fill="none"
            stroke={paint}
            strokeWidth={Math.max(0.8, ringR * 0.5)}
          />
          <path
            d={`M ${x0} ${W * 0.5}
                C ${x0} ${W * 0.18} ${L * 0.55} ${W * 0.02} ${L * 0.78} ${W * 0.16}
                C ${L * 0.98} ${W * 0.3} ${L * 0.98} ${W * 0.52} ${L * 0.8} ${W * 0.55}
                L ${L * 0.72} ${W * 0.42}
                L ${L * 0.68} ${W * 0.58}
                C ${L * 0.72} ${W * 0.88} ${L * 0.45} ${W * 1.0} ${L * 0.3} ${W * 0.88}
                C ${x0} ${W * 0.78} ${x0} ${W * 0.62} ${x0} ${W * 0.5} Z`}
            fill={paint}
          />
        </g>
      );
    }
    case "figure-eight": {
      // Two elliptical lobes that overlap at the center (infinity links,
      // double-ring connectors). Each lobe spans half the length so their
      // strokes cross at L/2 instead of leaving a gap.
      const sw = Math.max(0.8, Math.min(L, W) * 0.14);
      const rx = L / 4 - sw / 4;
      const ry = W / 2 - sw / 2;
      if (rx <= 0 || ry <= 0) return null;
      return (
        <g fill="none" stroke={paint} strokeWidth={sw}>
          <ellipse cx={L * 0.25} cy={W / 2} rx={rx} ry={ry} />
          <ellipse cx={L * 0.75} cy={W / 2} rx={rx} ry={ry} />
        </g>
      );
    }
    case "bezel": {
      // Empty setting: the bezel wall as a thick outer rim with a thin inner
      // lip, sized to the recess so it reads as the frame a cab drops into.
      // Rim clamped so the recess always exists — a null here would fall
      // back to the filled bead pipeline and look like a cabochon.
      const sw = Math.min(Math.max(1, Math.min(L, W) * 0.12), Math.min(L, W) * 0.3);
      // The rim follows the recess outline, inset so the stroke stays in the box.
      const d = outlinePath(visual.outline, L - sw, W - sw, seededRandom("bezel"));
      const lip = Math.max(0.05, 1 - (sw * 2.8) / Math.min(L, W));
      return (
        <g fill="none" stroke={paint} transform={`translate(${sw / 2}, ${sw / 2})`}>
          {/* a faint fill in the well keeps it from reading as a jump ring */}
          <path d={d} fill={paint} fillOpacity={0.18} strokeWidth={sw} strokeLinejoin="round" />
          <path
            d={d}
            transform={`translate(${(L - sw) / 2}, ${(W - sw) / 2}) scale(${lip}) translate(${-(L - sw) / 2}, ${-(W - sw) / 2})`}
            strokeWidth={Math.max(0.4, sw * 0.35)}
            opacity={0.7}
          />
        </g>
      );
    }
    case "bail": {
      // Pinch bail: a loop on top with two prongs pinching down to a point.
      const r = Math.max(0.8, Math.min(L * 0.42, W * 0.3));
      const sw = Math.max(0.8, r * 0.45);
      return (
        <g fill="none" stroke={paint} strokeWidth={sw} strokeLinecap="round">
          <circle cx={L / 2} cy={r + sw / 2} r={r} />
          <path
            d={`M ${L / 2 - r * 0.9} ${r * 2} Q ${L * 0.15} ${W * 0.7} ${L / 2} ${W - sw}
                Q ${L * 0.85} ${W * 0.7} ${L / 2 + r * 0.9} ${r * 2}`}
          />
        </g>
      );
    }
    case "triangle": {
      // Open triangle outline (triangle charms, geometric connectors).
      const sw = Math.max(0.8, Math.min(L, W) * 0.14);
      const i = sw;
      return (
        <polygon
          points={`${L / 2},${i} ${L - i},${W - i} ${i},${W - i}`}
          fill="none"
          stroke={paint}
          strokeWidth={sw}
          strokeLinejoin="round"
        />
      );
    }
    case "connector": {
      // A bar with a loop at each end (spacer bars, chandelier links).
      // Capped at L/4 so the loops stay inside the element's footprint.
      const r = Math.min(Math.max(1.5, Math.min(L * 0.12, W * 0.4)), L / 4);
      const barH = Math.max(1.5, W * 0.2);
      return (
        <g>
          <circle
            cx={r}
            cy={W / 2}
            r={r - Math.max(0.6, r * 0.25) / 2}
            fill="none"
            stroke={paint}
            strokeWidth={Math.max(0.6, r * 0.5)}
          />
          <circle
            cx={L - r}
            cy={W / 2}
            r={r - Math.max(0.6, r * 0.25) / 2}
            fill="none"
            stroke={paint}
            strokeWidth={Math.max(0.6, r * 0.5)}
          />
          <rect
            x={r * 2}
            y={W / 2 - barH / 2}
            width={Math.max(1, L - r * 4)}
            height={barH}
            rx={barH / 2}
            fill={paint}
          />
        </g>
      );
    }
    default:
      return null;
  }
}

interface BeadProps {
  visual: BeadVisual;
  pxPerMm: number;
  /** Seed for deterministic irregularity — pass the material id. */
  seed?: string;
}

/** The bead itself, as a <g> with its top-left at the origin. Memoized so
 * strand-wide re-renders (selection, caret moves) skip unchanged beads. */
export const Bead = memo(function Bead({ visual, pxPerMm, seed = "bead" }: BeadProps) {
  const uid = useId().replace(/[^a-zA-Z0-9-]/g, "");
  const L = Math.max(1, visual.length_mm * pxPerMm);
  const W = Math.max(1, visual.width_mm * pxPerMm);
  const c = visual.color;
  const gradId = `bg-${uid}`;
  const clipId = `bc-${uid}`;

  const gradient =
    visual.finish === "metallic" ? (
      <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={shade(c, 0.55)} />
        <stop offset="35%" stopColor={shade(c, -0.1)} />
        <stop offset="52%" stopColor={shade(c, 0.45)} />
        <stop offset="72%" stopColor={shade(c, -0.35)} />
        <stop offset="100%" stopColor={shade(c, 0.1)} />
      </linearGradient>
    ) : visual.finish === "matte" ? (
      <radialGradient id={gradId} cx="40%" cy="35%" r="80%">
        <stop offset="0%" stopColor={shade(c, 0.12)} />
        <stop offset="100%" stopColor={shade(c, -0.15)} />
      </radialGradient>
    ) : visual.finish === "pearl" ? (
      <radialGradient id={gradId} cx="35%" cy="30%" r="80%">
        <stop offset="0%" stopColor={shade(c, 0.6)} />
        <stop offset="55%" stopColor={c} />
        <stop offset="100%" stopColor={shade(c, -0.12)} />
      </radialGradient>
    ) : (
      // glossy and transparent
      <radialGradient id={gradId} cx="35%" cy="30%" r="80%">
        <stop offset="0%" stopColor={shade(c, 0.42)} />
        <stop offset="45%" stopColor={c} />
        <stop offset="100%" stopColor={shade(c, -0.28)} />
      </radialGradient>
    );

  const component = componentElement(visual, L, W, `url(#${gradId})`);
  if (component) {
    return (
      <g>
        <defs>{gradient}</defs>
        {component}
      </g>
    );
  }

  const rand = seededRandom(seed + visual.shape);
  const { el: Shape } = shapeElement(visual, L, W, rand);

  const sec = visual.color_secondary;
  const patternMarks: React.ReactNode[] = [];
  if (sec && visual.pattern === "marbled") {
    for (let i = 0; i < 3; i++) {
      patternMarks.push(
        <ellipse
          key={i}
          cx={rand() * L}
          cy={rand() * W}
          rx={L * (0.18 + rand() * 0.22)}
          ry={W * (0.1 + rand() * 0.16)}
          transform={`rotate(${rand() * 180} ${L / 2} ${W / 2})`}
          fill={sec}
          opacity={0.45}
        />
      );
    }
  } else if (sec && visual.pattern === "speckled") {
    const count = 8 + Math.floor(rand() * 6);
    for (let i = 0; i < count; i++) {
      patternMarks.push(
        <circle
          key={i}
          cx={rand() * L}
          cy={rand() * W}
          r={Math.max(0.6, Math.min(L, W) * 0.05)}
          fill={sec}
          opacity={0.8}
        />
      );
    }
  } else if (sec && visual.pattern === "banded") {
    const count = 2 + Math.floor(rand() * 3);
    for (let i = 0; i < count; i++) {
      const x = rand() * L;
      patternMarks.push(
        <rect
          key={i}
          x={x}
          y={0}
          width={L * (0.08 + rand() * 0.1)}
          height={W}
          fill={sec}
          opacity={0.45}
        />
      );
    }
  }

  // Slice signatures: stalactite slices grow in concentric rings around an
  // off-center core; trapiche slices carry six radial spokes from the center.
  const sliceInk = sec ?? shade(c, -0.4);
  const outline = visual.shape === "cabochon" ? visual.outline : null;
  const sliceOverlay =
    outline === "stalactite" ? (
      <g fill="none" stroke={sliceInk} strokeOpacity={0.55} strokeWidth={0.6}>
        {[0.82, 0.64, 0.46, 0.28].map((k) => {
          const d = outlinePath("stalactite", L * k, W * k, seededRandom(seed + k));
          return (
            <path
              key={k}
              d={d}
              transform={`translate(${L * 0.5 - (L * k) / 2 + L * 0.06 * (1 - k)}, ${W * 0.5 - (W * k) / 2 - W * 0.08 * (1 - k)})`}
            />
          );
        })}
        <circle cx={L * 0.56} cy={W * 0.42} r={Math.max(0.6, Math.min(L, W) * 0.06)} fill={sliceInk} />
      </g>
    ) : outline === "trapiche" ? (
      <g stroke={sliceInk} strokeOpacity={0.75} strokeWidth={Math.max(0.6, Math.min(L, W) * 0.05)} strokeLinecap="round">
        {Array.from({ length: 6 }, (_, i) => {
          const angle = Math.PI + (i / 6) * Math.PI * 2;
          return (
            <line
              key={i}
              x1={L / 2}
              y1={W / 2}
              x2={L / 2 + (Math.cos(angle) * L) / 2}
              y2={W / 2 + (Math.sin(angle) * W) / 2}
            />
          );
        })}
        <circle cx={L / 2} cy={W / 2} r={Math.max(0.8, Math.min(L, W) * 0.09)} fill={sliceInk} stroke="none" />
      </g>
    ) : null;

  // Suggest facets without real geometry: an inscribed hexagon with short
  // radial cuts toward the edge; for octagons (cornerless cubes) an inscribed
  // diamond echoes the corner-cut faces instead.
  const facetVertices = Array.from({ length: 6 }, (_, i) => {
    const angle = (i / 6) * Math.PI * 2 + Math.PI / 6;
    return [Math.cos(angle), Math.sin(angle)] as const;
  });
  const facetOverlay = !visual.faceted ? null : visual.shape === "octagon" ? (
    <polygon
      points={`${L / 2},${W * 0.1} ${L * 0.9},${W / 2} ${L / 2},${W * 0.9} ${L * 0.1},${W / 2}`}
      fill="none"
      stroke="white"
      strokeOpacity={0.3}
      strokeWidth={0.75}
    />
  ) : (
    <g stroke="white" strokeOpacity={0.35} strokeWidth={0.75} fill="none">
      <polygon
        points={facetVertices
          .map(([cx, cy]) => `${L / 2 + cx * L * 0.3},${W / 2 + cy * W * 0.3}`)
          .join(" ")}
      />
      {facetVertices.map(([cx, cy], i) => (
        <line
          key={i}
          x1={L / 2 + cx * L * 0.3}
          y1={W / 2 + cy * W * 0.3}
          x2={L / 2 + cx * L * 0.46}
          y2={W / 2 + cy * W * 0.46}
        />
      ))}
    </g>
  );

  return (
    <g>
      <defs>
        {gradient}
        <clipPath id={clipId}>
          <Shape />
        </clipPath>
      </defs>
      <Shape
        fill={`url(#${gradId})`}
        fillOpacity={visual.finish === "transparent" ? 0.7 : 1}
        stroke={shade(c, -0.35)}
        strokeOpacity={0.5}
        strokeWidth={0.75}
      />
      <g clipPath={`url(#${clipId})`}>
        {patternMarks}
        {sliceOverlay}
        {facetOverlay}
      </g>
      {(visual.finish === "glossy" ||
        visual.finish === "pearl" ||
        visual.finish === "transparent") && (
        <ellipse
          cx={L * 0.32}
          cy={W * 0.26}
          rx={L * 0.14}
          ry={W * 0.1}
          fill="white"
          opacity={visual.finish === "pearl" ? 0.35 : 0.55}
        />
      )}
    </g>
  );
});

interface BeadSwatchProps {
  visual: BeadVisual | null;
  /** Max rendered size in px; the bead is scaled to fit. */
  size?: number;
  seed?: string;
  className?: string;
}

/** Standalone swatch for palettes and previews, scaled to fit `size`. */
export default function BeadSwatch({
  visual,
  size = 28,
  seed,
  className,
}: BeadSwatchProps) {
  if (!visual) {
    return (
      <svg width={size} height={size} className={className} aria-label="No visual yet">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={size / 2 - 2}
          fill="#f3f4f6"
          stroke="#d1d5db"
          strokeDasharray="3 2"
        />
        <text
          x="50%"
          y="54%"
          dominantBaseline="middle"
          textAnchor="middle"
          fontSize={size * 0.5}
          fill="#9ca3af"
        >
          ?
        </text>
      </svg>
    );
  }

  const pxPerMm = size / Math.max(visual.length_mm, visual.width_mm, 1);
  const w = Math.max(2, visual.length_mm * pxPerMm);
  const h = Math.max(2, visual.width_mm * pxPerMm);
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className={className}
      overflow="visible"
    >
      <Bead visual={visual} pxPerMm={pxPerMm} seed={seed} />
    </svg>
  );
}
