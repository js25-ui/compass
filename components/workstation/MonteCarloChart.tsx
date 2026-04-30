import type { BusinessLine, MonteCarloConfig } from '@/lib/demo-data';

interface MonteCarloChartProps {
  bl: BusinessLine;
  config: MonteCarloConfig;
}

const W = 800;
const H = 240;
const PAD = { top: 25, right: 30, bottom: 35, left: 40 };

export function MonteCarloChart({ bl, config }: MonteCarloChartProps) {
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const bins = 30;

  const heights: number[] = [];
  for (let i = 0; i < bins; i++) {
    const x = config.min + (i / (bins - 1)) * (config.max - config.min);
    const z = (x - config.median) / config.stdev;
    let val = Math.exp(-0.5 * z * z);
    if (z > 0) val *= 0.95;
    heights.push(val);
  }
  const maxHeight = Math.max(...heights);

  const numTicks = 6;
  const tickLabel = (tick: number) =>
    bl === 'dcm' ? `${tick.toFixed(1)}%` : `${tick > 0 ? '+' : ''}${Math.round(tick)}%`;

  const barWidth = innerW / bins - 1;

  const medianX = PAD.left + ((config.median - config.min) / (config.max - config.min)) * innerW;
  const medianLabel = bl === 'dcm' ? `${config.median.toFixed(2)}%` : `P50: ${config.median}%`;
  const hurdleX = PAD.left + ((config.hurdle - config.min) / (config.max - config.min)) * innerW;

  return (
    <svg className="mc-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      {Array.from({ length: 5 }, (_, i) => {
        const y = PAD.top + (i / 4) * innerH;
        return <line key={i} x1={PAD.left} y1={y} x2={W - PAD.right} y2={y} stroke="#1a1a1a" strokeWidth={1} />;
      })}
      {Array.from({ length: numTicks + 1 }, (_, i) => {
        const tick = config.min + (i / numTicks) * (config.max - config.min);
        const xCoord = PAD.left + (i / numTicks) * innerW;
        return (
          <g key={i}>
            <line x1={xCoord} y1={PAD.top + innerH} x2={xCoord} y2={PAD.top + innerH + 5} stroke="#444" strokeWidth={1} />
            <text x={xCoord} y={PAD.top + innerH + 18} fill="#888" fontSize={10} textAnchor="middle" fontFamily="-apple-system, sans-serif">
              {tickLabel(tick)}
            </text>
          </g>
        );
      })}
      {heights.map((h, i) => {
        const barH = (h / maxHeight) * innerH * 0.85;
        const x = PAD.left + (i / bins) * innerW + 0.5;
        const y = PAD.top + innerH - barH;
        const xCenter = config.min + ((i + 0.5) / bins) * (config.max - config.min);
        let color = '#4a90e2';
        if (xCenter < config.hurdle) color = '#666';
        if (bl !== 'dcm' && xCenter < 0) color = '#f87171';
        return <rect key={i} x={x} y={y} width={barWidth} height={barH} fill={color} opacity={0.85} />;
      })}
      <line x1={medianX} y1={PAD.top} x2={medianX} y2={PAD.top + innerH} stroke="#fff" strokeWidth={2} strokeDasharray="3,3" />
      <text x={medianX} y={PAD.top - 8} fill="#fff" fontSize={11} textAnchor="middle" fontWeight={600} fontFamily="-apple-system, sans-serif">
        {medianLabel}
      </text>
      <line x1={hurdleX} y1={PAD.top} x2={hurdleX} y2={PAD.top + innerH} stroke="#4ade80" strokeWidth={1.5} strokeDasharray="6,3" />
      <text x={hurdleX + 4} y={PAD.top + 12} fill="#4ade80" fontSize={10} fontWeight={600} fontFamily="-apple-system, sans-serif">
        {config.hurdleLabel}
      </text>
    </svg>
  );
}
