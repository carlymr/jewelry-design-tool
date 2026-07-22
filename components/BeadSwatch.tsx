"use client";

import { useId } from "react";
import type { BeadVisual } from "@/lib/bead-visual";

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

function shapeElement(visual: BeadVisual, L: number, W: number, rand: () => number) {
  switch (visual.shape) {
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
        const jitter = 0.68 + rand() * 0.32;
        points.push([
          L / 2 + Math.cos(angle) * (L / 2) * jitter,
          W / 2 + Math.sin(angle) * (W / 2) * jitter,
        ]);
      }
      const d = blobPath(points);
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

interface BeadProps {
  visual: BeadVisual;
  pxPerMm: number;
  /** Seed for deterministic irregularity — pass the material id. */
  seed?: string;
}

/** The bead itself, as a <g> with its top-left at the origin. */
export function Bead({ visual, pxPerMm, seed = "bead" }: BeadProps) {
  const uid = useId().replace(/[^a-zA-Z0-9-]/g, "");
  const L = Math.max(1, visual.length_mm * pxPerMm);
  const W = Math.max(1, visual.width_mm * pxPerMm);
  const rand = seededRandom(seed + visual.shape);
  const { el: Shape } = shapeElement(visual, L, W, rand);

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

  // Inscribed hexagon suggests facets without real geometry.
  const facetPoints = Array.from({ length: 6 }, (_, i) => {
    const angle = (i / 6) * Math.PI * 2 + Math.PI / 6;
    return `${L / 2 + Math.cos(angle) * L * 0.33},${W / 2 + Math.sin(angle) * W * 0.33}`;
  }).join(" ");

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
      <g clipPath={`url(#${clipId})`}>{patternMarks}</g>
      {visual.faceted && (
        <polygon
          points={facetPoints}
          fill="none"
          stroke="white"
          strokeOpacity={0.35}
          strokeWidth={0.75}
        />
      )}
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
}

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
