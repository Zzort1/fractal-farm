/**
 * A hand-drawn SVG sparkline with a gradient fill.
 * @param {{values: number[], colour: string, height?: number, max?: number}} props - Series and styling
 * @returns {JSX.Element} Chart
 */
export default function Sparkline({ values, colour, height = 44, max }) {
  const width = 240;
  const id = `spark-${colour.replace(/[^a-z0-9]/gi, "")}`;
  const peak = Math.max(max ?? 0, ...values, 1);
  const n = Math.max(values.length, 2);

  const points = values.map((value, i) => {
    const x = (i / (n - 1)) * width;
    const y = height - 2 - (value / peak) * (height - 6);
    return [x, y];
  });

  const line = points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  const area = points.length
    ? `${line}L${points.at(-1)[0].toFixed(1)},${height}L${points[0][0].toFixed(1)},${height}Z`
    : "";

  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={colour} stopOpacity="0.55" />
          <stop offset="100%" stopColor={colour} stopOpacity="0" />
        </linearGradient>
      </defs>
      {area && <path d={area} fill={`url(#${id})`} />}
      {line && <path d={line} fill="none" stroke={colour} strokeWidth="2" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}
