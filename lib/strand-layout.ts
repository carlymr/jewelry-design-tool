// Geometry for the design board's "as worn" view: the strand is laid along
// a closed circle (bracelet lengths) or a hanging catenary drape (how a
// necklace actually falls). Coordinates are mm with the origin at the
// top-left of the curve's bounding box, y growing downward (SVG); angles
// are degrees for SVG rotate(). Everything is parameterized by arc length,
// which is exactly what a strand of beads advances by.

const MM_PER_INCH = 25.4;

/** Below this the piece closes into a circle (bracelet); at or above it
 * hangs as a drape (necklace). */
export const NECKLACE_MIN_MM = 12 * MM_PER_INCH;

export type CurveKind = "circle" | "drape";

export interface CurvePoint {
  x: number;
  y: number;
  /** Direction of travel along the strand, degrees. */
  tangentDeg: number;
  /** Where a pendant hangs from this point: radially outward on a bracelet
   * lying flat, straight down on a draped necklace. */
  hangDeg: number;
}

export interface CurveGeometry {
  kind: CurveKind;
  /** Full curve length — the target (or the strand, if it overran). */
  curveMm: number;
  widthMm: number;
  heightMm: number;
  pointAt(sMm: number): CurvePoint;
  /** Inverse: the arc length nearest a point in the same mm frame. */
  arcLengthAt(xMm: number, yMm: number): number;
}

// Catenary openness: smaller = narrower, deeper drape. curve/3 hangs like a
// worn chain.
const drapeA = (curveMm: number) => curveMm / 3;

export function curveGeometry(curveMm: number): CurveGeometry {
  const C = Math.max(curveMm, 1);

  if (C < NECKLACE_MIN_MM) {
    // Bracelet: full circle of circumference C, s = 0 at 12 o'clock, running
    // clockwise. Center at (r, r).
    const r = C / (2 * Math.PI);
    return {
      kind: "circle",
      curveMm: C,
      widthMm: 2 * r,
      heightMm: 2 * r,
      pointAt(s) {
        const theta = (s / C) * 2 * Math.PI - Math.PI / 2;
        const deg = (theta * 180) / Math.PI;
        return {
          x: r + r * Math.cos(theta),
          y: r + r * Math.sin(theta),
          tangentDeg: deg + 90,
          hangDeg: deg,
        };
      },
      arcLengthAt(x, y) {
        const theta = Math.atan2(y - r, x - r);
        let s = ((theta + Math.PI / 2) / (2 * Math.PI)) * C;
        if (s < 0) s += C;
        return s;
      },
    };
  }

  // Necklace: catenary, which is closed-form in arc length. With t the
  // signed arc length from the vertex (lowest point): x = a·asinh(t/a),
  // sag below the ends = √(a²+t²) − a, tangent slope = atan2(−t, a).
  const a = drapeA(C);
  const half = C / 2;
  const xHalf = a * Math.asinh(half / a);
  const depth = Math.sqrt(a * a + half * half) - a;
  return {
    kind: "drape",
    curveMm: C,
    widthMm: 2 * xHalf,
    heightMm: depth,
    pointAt(s) {
      const t = s - half;
      return {
        x: xHalf + a * Math.asinh(t / a),
        y: depth - (Math.sqrt(a * a + t * t) - a),
        tangentDeg: (Math.atan2(-t, a) * 180) / Math.PI,
        hangDeg: 90,
      };
    },
    arcLengthAt(x) {
      const t = a * Math.sinh((x - xHalf) / a);
      return Math.min(C, Math.max(0, t + half));
    },
  };
}

/** SVG path for the full curve (the "string"), sampled finely enough to
 * look smooth at any zoom. */
export function curvePath(curve: CurveGeometry): string {
  const steps = 96;
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const p = curve.pointAt((i / steps) * curve.curveMm);
    pts.push(`${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`);
  }
  return pts.join(" ") + (curve.kind === "circle" ? " Z" : "");
}
