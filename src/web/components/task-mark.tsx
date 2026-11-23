export function TaskMark({
  status,
  size = 19,
}: {
  status: 'working' | 'needs_you' | 'done';
  size?: number;
}) {
  return (
    <svg
      className="task-mark"
      data-status={status}
      viewBox="0 0 32 32"
      width={size}
      height={size}
      role="img"
      aria-label={status === 'needs_you' ? 'Needs you' : status === 'done' ? 'Done' : 'Working'}
    >
      {status === 'needs_you' ? (
        <>
          <circle className="task-mark-fill" cx="16" cy="16" r="14" />
          <text
            className="task-mark-ask"
            x="16"
            y="16"
            textAnchor="middle"
            dominantBaseline="central"
          >
            ?
          </text>
        </>
      ) : (
        <circle className="task-mark-ring" cx="16" cy="16" r="10" />
      )}
      {status === 'working' && (
        <g className="task-mark-orbit">
          <circle className="task-mark-dot" cx="25" cy="6" r="4" />
        </g>
      )}
      {status === 'done' && <path className="task-mark-check" d="M11 16.5l3.5 3.5 6.5-7.5" />}
    </svg>
  );
}
