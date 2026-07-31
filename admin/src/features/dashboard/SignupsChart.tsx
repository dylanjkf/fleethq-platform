import type { DailySignup } from '@/api/types';

/** A dependency-free SVG bar chart — same "no charting library" precedent as FleetHQ's Impact page. */
export function SignupsChart({ data }: { data: DailySignup[] }) {
  if (data.length === 0) return null;
  const max = Math.max(1, ...data.map((d) => d.count));
  const width = 100;
  const height = 32;
  const barWidth = width / data.length;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-24 w-full">
      {data.map((d, i) => {
        const barHeight = (d.count / max) * (height - 2);
        return (
          <rect
            key={d.date}
            x={i * barWidth + barWidth * 0.15}
            y={height - barHeight}
            width={barWidth * 0.7}
            height={barHeight}
            rx={0.5}
            className="fill-accent-500"
          >
            <title>
              {d.date}: {d.count}
            </title>
          </rect>
        );
      })}
    </svg>
  );
}
