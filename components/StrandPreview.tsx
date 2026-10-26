"use client";

import { useMemo } from "react";
import { Bead } from "@/components/BeadSwatch";
import { stoneTurn, type BeadVisual } from "@/lib/bead-visual";
import { curveGeometry, curvePath } from "@/lib/strand-layout";
import {
  beadLengthMm,
  CABOCHON_BAIL_MM,
  hasBail,
  isPendant,
} from "@/lib/strand-spacing";

// A picture of the strand as it will look on the board's "as worn" view, drawn
// with the same curve, spacing and bead renderer so the owner can judge the
// piece before saving it. It works in millimetres (pxPerMm = 1), and the SVG
// scales to its container. Element faces (cabochon photos) aren't shown here:
// the preview uses the generated look.

export interface PreviewElement {
  key: string;
  visual: BeadVisual | null;
}

const PAD_MM = 15;
const DROP_PAD_MM = 60;

export default function StrandPreview({
  elements,
  targetMm,
}: {
  elements: PreviewElement[];
  targetMm: number;
}) {
  const layout = useMemo(() => {
    let x = 0;
    const placed = elements.map((e) => {
      const lengthMm = beadLengthMm({ visual: e.visual });
      const item = { ...e, xMm: x, lengthMm };
      x += lengthMm;
      return item;
    });
    const totalMm = x;
    const curve = curveGeometry(Math.max(targetMm, totalMm));
    // Necklaces are worn symmetric: the strand is centered on the curve.
    const wornOffsetMm = (curve.curveMm - totalMm) / 2;
    return { placed, curve, wornOffsetMm };
  }, [elements, targetMm]);

  const { placed, curve, wornOffsetMm } = layout;
  const width = curve.widthMm + PAD_MM * 2;
  const height = curve.heightMm + PAD_MM + DROP_PAD_MM;

  const pointAt = (sMm: number) => {
    const p = curve.pointAt(Math.min(Math.max(sMm, 0), curve.curveMm));
    return { x: PAD_MM + p.x, y: PAD_MM + p.y, tangentDeg: p.tangentDeg, hangDeg: p.hangDeg };
  };

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-auto w-full"
      role="img"
      aria-label="Preview of the strand as worn"
    >
      <path
        d={curvePath(curve)}
        transform={`translate(${PAD_MM} ${PAD_MM})`}
        fill="none"
        stroke="#a8a29e"
        strokeWidth={0.6}
      />
      {placed.map((p) => {
        const centerS = p.xMm + p.lengthMm / 2 + wornOffsetMm;
        const pt = pointAt(centerS);
        const v = p.visual;

        if (!v) {
          // Nothing to draw yet: a dashed placeholder keeps the count honest.
          return (
            <g key={p.key} transform={`translate(${pt.x} ${pt.y}) rotate(${pt.tangentDeg})`}>
              <ellipse rx={p.lengthMm / 2} ry={1.5} fill="#e5e7eb" stroke="#9ca3af" strokeWidth={0.3} strokeDasharray="1 1" />
            </g>
          );
        }

        if (isPendant(v)) {
          // A pendant hangs from its bail: its local +y points down, and the
          // stone is turned by its stored turn, as on the board.
          const turn = stoneTurn(v);
          const vertical = turn % 180 !== 0;
          const stoneL = vertical ? v.length_mm : v.width_mm;
          const bail = hasBail(v);
          const bailR = bail ? CABOCHON_BAIL_MM / 2 : 0;
          const stoneTop = bail ? bailR * 1.6 : 0;
          return (
            <g key={p.key} transform={`translate(${pt.x} ${pt.y}) rotate(${pt.hangDeg - 90})`}>
              {bail && (
                <circle cx={0} cy={bailR * 0.6} r={bailR} fill="none" stroke="#9ca3af" strokeWidth={0.4} />
              )}
              <g transform={`translate(0 ${stoneTop + stoneL / 2}) rotate(${turn}) translate(${-v.length_mm / 2} ${-v.width_mm / 2})`}>
                <Bead visual={v} pxPerMm={1} seed={p.key} />
              </g>
            </g>
          );
        }

        return (
          <g key={p.key} transform={`translate(${pt.x} ${pt.y}) rotate(${pt.tangentDeg})`}>
            <g transform={`translate(${-v.length_mm / 2} ${-v.width_mm / 2})`}>
              <Bead visual={v} pxPerMm={1} seed={p.key} />
            </g>
          </g>
        );
      })}
    </svg>
  );
}
