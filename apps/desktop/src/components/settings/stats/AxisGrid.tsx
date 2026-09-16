import { formatAxis } from "./format";
import { ACTIVITY_VIEW } from "./geometry";

/** Shared y-axis: a gridline per stop, with its label in the left gutter. */
export function AxisGrid({ ticks }: { ticks: Array<{ value: number; y: number }> }) {
  return (
    <>
      {ticks.map((tick) => (
        <g key={tick.value}>
          <line
            className="stats-trend-axis"
            x1={ACTIVITY_VIEW.left}
            y1={tick.y}
            x2={ACTIVITY_VIEW.right}
            y2={tick.y}
          />
          <text
            className="stats-trend-tick"
            x={ACTIVITY_VIEW.left - 8}
            y={tick.y + 3}
            textAnchor="end"
          >
            {formatAxis(tick.value)}
          </text>
        </g>
      ))}
    </>
  );
}
