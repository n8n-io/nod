import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  Bot,
  Brain,
  Clock,
  Code,
  Database,
  ExternalLink,
  Filter,
  Globe,
  Hourglass,
  Merge,
  MessageCircle,
  MousePointerClick,
  PenLine,
  Repeat,
  Route,
  Scan,
  Sparkles,
  Split,
  Webhook,
  Wrench,
  X,
  type IconComponent,
} from './icons';
import { formatNumber } from '../lib/date-format';
import { safeMessageLink } from '../lib/message-links';
import { CodeView } from './attachment-code';
import { Button } from './ui';

type Category = 'trigger' | 'ai' | 'flow' | 'code' | 'http' | 'other';
type WorkflowNode = {
  name: string;
  type: string;
  typeVersion?: number;
  position: [number, number];
  parameters: Record<string, unknown>;
  disabled: boolean;
  notes?: string;
};
type Connection = { from: string; output: number; to: string; input: number; type: string };
type Workflow = {
  name: string;
  nodes: WorkflowNode[];
  connections: Connection[];
  url: string | null;
};
type Box = WorkflowNode & {
  x: number;
  y: number;
  w: number;
  h: number;
  category: Category;
  sticky: boolean;
  sub: boolean;
  inputs: number;
  outputs: number;
  slots: string[];
  labels: string[] | null;
};
type View = { x: number; y: number; k: number };

const stickyType = 'n8n-nodes-base.stickyNote';
const flowNodes = new Set(['if', 'switch', 'merge', 'filter', 'splitInBatches']);
const outputLabels: Record<string, string[]> = {
  if: ['true', 'false'],
  filter: ['kept', 'discarded'],
  splitInBatches: ['done', 'loop'],
};
const icons: Record<string, IconComponent> = {
  manualTrigger: MousePointerClick,
  scheduleTrigger: Clock,
  cron: Clock,
  webhook: Webhook,
  chatTrigger: MessageCircle,
  if: Split,
  switch: Route,
  filter: Filter,
  merge: Merge,
  splitInBatches: Repeat,
  wait: Hourglass,
  code: Code,
  function: Code,
  functionItem: Code,
  set: PenLine,
  httpRequest: Globe,
  agent: Bot,
};
const families: Array<[RegExp, IconComponent]> = [
  [/^lm/, Sparkles],
  [/^memory/, Brain],
  [/^vectorStore/, Database],
  [/^tool/, Wrench],
];
const readable = 0.75;

const record = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const size = (value: unknown, fallback: number) =>
  typeof value === 'number' && value > 0 ? value : fallback;
const range = (count: number) => Array.from({ length: count }, (_, index) => index);
const clip = (value: string, length: number) =>
  value.length > length ? `${value.slice(0, Math.max(1, length - 1))}…` : value;
const segment = (type: string) => type.slice(type.lastIndexOf('.') + 1);
const port = (box: Box, index: number, count: number) =>
  box.y + (box.h * (index + 1)) / (count + 1);
const slotX = (box: Box, index: number) => box.x + (box.w * (index + 1)) / (box.slots.length + 1);

function parseWorkflow(text: string): Workflow | null {
  let root: Record<string, unknown> | null;
  try {
    root = record(JSON.parse(text));
  } catch {
    return null;
  }
  const workflow = record(root?.workflow) ?? root;
  if (!workflow || !Array.isArray(workflow.nodes)) return null;
  const nodes = workflow.nodes.flatMap((value): WorkflowNode[] => {
    const node = record(value);
    const position = node?.position;
    if (
      !node ||
      typeof node.name !== 'string' ||
      typeof node.type !== 'string' ||
      !Array.isArray(position) ||
      !Number.isFinite(position[0]) ||
      !Number.isFinite(position[1])
    )
      return [];
    return [
      {
        name: node.name,
        type: node.type,
        typeVersion: typeof node.typeVersion === 'number' ? node.typeVersion : undefined,
        position: [position[0], position[1]],
        parameters: record(node.parameters) ?? {},
        disabled: node.disabled === true,
        notes: typeof node.notes === 'string' ? node.notes : undefined,
      },
    ];
  });
  if (!nodes.length || nodes.length > 400) return null;
  const names = new Set(nodes.map((node) => node.name));
  const connections = Object.entries(record(workflow.connections) ?? {}).flatMap(([from, types]) =>
    names.has(from)
      ? Object.entries(record(types) ?? {}).flatMap(([type, outputs]) =>
          (Array.isArray(outputs) ? outputs : []).flatMap((targets, output) =>
            (Array.isArray(targets) ? targets : []).flatMap((value): Connection[] => {
              const target = record(value);
              const input = target?.index ?? 0;
              return target &&
                typeof target.node === 'string' &&
                names.has(target.node) &&
                Number.isInteger(input) &&
                (input as number) >= 0 &&
                (input as number) < 64 &&
                output < 64
                ? [{ from, output, to: target.node, input: input as number, type }]
                : [];
            }),
          ),
        )
      : [],
  );
  const url = [root?.url, workflow.url].find((value) => typeof value === 'string');
  const link = typeof url === 'string' ? safeMessageLink(url, window.location.origin) : null;
  return {
    name: typeof workflow.name === 'string' && workflow.name.trim() ? workflow.name : 'Workflow',
    nodes,
    connections,
    url: link?.kind === 'external' ? link.href : null,
  };
}

function category(type: string): Category {
  const name = segment(type);
  if (/Trigger$/.test(name) || name === 'webhook') return 'trigger';
  if (type.startsWith('@n8n/n8n-nodes-langchain.')) return 'ai';
  if (flowNodes.has(name)) return 'flow';
  if (/^(?:code|function)/.test(name)) return 'code';
  if (/^http/i.test(name)) return 'http';
  return 'other';
}

function icon(type: string) {
  if (!/^(?:n8n-nodes-base|@n8n\/n8n-nodes-langchain)\./.test(type)) return undefined;
  const name = segment(type);
  const tool = name.replace(/^tool(?=[A-Z])/, '');
  return (
    icons[name] ??
    icons[tool.charAt(0).toLowerCase() + tool.slice(1)] ??
    families.find(([pattern]) => pattern.test(name))?.[1]
  );
}

function initials(type: string) {
  const words =
    segment(type)
      .replace(/(?:Trigger|Tool)$/, '')
      .replace(/^(?:lmChat|lm|tool)(?=[A-Z])/, '')
      .match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g) ?? [];
  if (words.length === 1 && words[0].length <= 2) return words[0].toUpperCase();
  return (
    words
      .slice(0, 2)
      .map((word) => word[0])
      .join('')
      .toUpperCase() || '?'
  );
}

function slotLabel(type: string) {
  const word = /([A-Z]?[a-z]+)$/.exec(type)?.[1] ?? type;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function wrap(text: string, length: number) {
  const lines = [''];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const line = lines[lines.length - 1];
    if (line && line.length + word.length >= length) lines.push(word);
    else lines[lines.length - 1] = line ? `${line} ${word}` : word;
  }
  return [lines[0], lines.slice(1).join(' ')].filter(Boolean).map((line) => clip(line, length));
}

function stickyText(value: unknown) {
  return (
    String(value ?? '')
      .split('\n')
      .map((line) =>
        line
          .replace(/^[#>*\s-]+/, '')
          .replace(/[*_`]/g, '')
          .trim(),
      )
      .find(Boolean) ?? ''
  );
}

function layout({ nodes, connections }: Workflow): Box[] {
  const positions = new Map(nodes.map((node) => [node.name, node.position[0]]));
  return nodes.map((node) => {
    const sticky = node.type === stickyType;
    const outgoing = connections.filter((connection) => connection.from === node.name);
    const incoming = connections.filter((connection) => connection.to === node.name);
    const sub = outgoing.length > 0 && outgoing.every((connection) => connection.type !== 'main');
    const left = (type: string) =>
      Math.min(
        ...incoming
          .filter((connection) => connection.type === type)
          .map((connection) => positions.get(connection.from) ?? 0),
      );
    const slots = [
      ...new Set(
        incoming.filter((connection) => connection.type !== 'main').map(({ type }) => type),
      ),
    ].sort((a, b) => left(a) - left(b));
    const inputs = Math.max(
      1,
      ...incoming.filter(({ type }) => type === 'main').map(({ input }) => input + 1),
    );
    const labels = outputLabels[segment(node.type)];
    const outputs = Math.max(
      1,
      labels?.length ?? 0,
      ...outgoing.filter(({ type }) => type === 'main').map(({ output }) => output + 1),
    );
    return {
      ...node,
      x: node.position[0],
      y: node.position[1],
      w: sticky
        ? size(node.parameters.width, 240)
        : sub
          ? 80
          : slots.length
            ? Math.max(240, slots.length * 80)
            : 100,
      h: sticky
        ? size(node.parameters.height, 160)
        : sub
          ? 80
          : 100 + Math.max(0, Math.max(inputs, outputs) - 3) * 32,
      category: category(node.type),
      sticky,
      sub,
      inputs,
      outputs,
      slots,
      labels: labels?.length === outputs ? labels : null,
    };
  });
}

function shape(box: Box, grow: number) {
  const right = (box.sub ? box.w / 2 : 8) + grow;
  const left = box.category === 'trigger' && !box.sub ? 36 + grow : right;
  const x = box.x - grow;
  const y = box.y - grow;
  const w = box.w + grow * 2;
  const h = box.h + grow * 2;
  return `M${x + left},${y}H${x + w - right}A${right},${right} 0 0 1 ${x + w},${y + right}V${y + h - right}A${right},${right} 0 0 1 ${x + w - right},${y + h}H${x + left}A${left},${left} 0 0 1 ${x},${y + h - left}V${y + left}A${left},${left} 0 0 1 ${x + left},${y}Z`;
}

function diamond(x: number, y: number) {
  return `M${x},${y - 6}L${x + 6},${y}L${x},${y + 6}L${x - 6},${y}Z`;
}

function edgePath(connection: Connection, boxes: Map<string, Box>) {
  const from = boxes.get(connection.from)!;
  const to = boxes.get(connection.to)!;
  if (connection.type !== 'main') {
    const sx = from.x + from.w / 2;
    const tx = slotX(to, to.slots.indexOf(connection.type));
    const ty = to.y + to.h;
    const dy = Math.max(Math.abs(from.y - ty) / 2, 30);
    return `M${sx},${from.y}C${sx},${from.y - dy} ${tx},${ty + dy} ${tx},${ty}`;
  }
  const sx = from.x + from.w;
  const sy = port(from, connection.output, from.outputs);
  const tx = to.x - 5;
  const ty = port(to, connection.input, to.inputs);
  if (tx > sx + 40) {
    const dx = Math.max((tx - sx) / 2, 40);
    return `M${sx},${sy}C${sx + dx},${sy} ${tx - dx},${ty} ${tx},${ty}`;
  }
  const bottom = Math.max(from.y + from.h, to.y + to.h) + 60;
  return `M${sx},${sy}C${sx + 60},${sy} ${sx + 60},${bottom} ${sx},${bottom}L${tx},${bottom}C${tx - 60},${bottom} ${tx - 60},${ty} ${tx},${ty}`;
}

function Canvas({ workflow }: { workflow: Workflow }) {
  const id = `n8n-${useId().replace(/[^\w-]/g, '')}`;
  const frame = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const fitted = useRef<'start' | 'whole' | null>('start');
  const moved = useRef(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const [area, setArea] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<View | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const boxes = useMemo(() => layout(workflow), [workflow]);
  const named = useMemo(() => new Map(boxes.map((box) => [box.name, box])), [boxes]);
  const bounds = useMemo(() => {
    const xs = boxes.flatMap((box) => {
      const margin = box.sticky ? 0 : 40;
      return [box.x - margin, box.x + box.w + margin];
    });
    const ys = boxes.flatMap((box) => [box.y, box.y + box.h + (box.sticky ? 0 : 56)]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  }, [boxes]);
  const start = useMemo(() => {
    const nodes = boxes.filter((box) => !box.sticky && !box.sub);
    const triggers = nodes.filter((box) => box.category === 'trigger');
    return (triggers.length ? triggers : nodes.length ? nodes : boxes).reduce((left, box) =>
      box.x < left.x ? box : left,
    );
  }, [boxes]);
  const fit = useCallback(
    (whole = false) => {
      if (!area.width || !area.height) return;
      fitted.current = whole ? 'whole' : 'start';
      const k = Math.min(
        1,
        Math.max(
          whole ? 0.1 : readable,
          Math.min((area.width - 96) / bounds.width, (area.height - 96) / bounds.height),
        ),
      );
      const place = (size: number, from: number, length: number, wanted: number) =>
        length * k <= size - 96
          ? (size - length * k) / 2 - from * k
          : Math.min(48 - from * k, Math.max(size - 48 - (from + length) * k, wanted));
      setView({
        k,
        x: place(area.width, bounds.x, bounds.width, 48 - Math.max(bounds.x, start.x - 120) * k),
        y: place(
          area.height,
          bounds.y,
          bounds.height,
          area.height / 2 - (start.y + start.h / 2) * k,
        ),
      });
    },
    [area, bounds, start],
  );
  const zoom = useCallback((factor: number, x: number, y: number) => {
    fitted.current = null;
    setView((value) => {
      if (!value) return value;
      const k = Math.min(2, Math.max(0.1, value.k * factor));
      return { k, x: x - ((x - value.x) * k) / value.k, y: y - ((y - value.y) * k) / value.k };
    });
  }, []);
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const measure = () =>
      setArea((value) =>
        value.width === element.clientWidth && value.height === element.clientHeight
          ? value
          : { width: element.clientWidth, height: element.clientHeight },
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (fitted.current) fit(fitted.current === 'whole');
  }, [fit]);
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = element.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : 1);
      zoom(
        Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.002)),
        event.clientX - box.left,
        event.clientY - box.top,
      );
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [zoom]);
  const close = () => {
    const index = selected;
    setSelected(null);
    svg.current?.querySelector<SVGGElement>(`[data-node="${index}"]`)?.focus();
  };
  function pointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (!pointers.current.size) moved.current = false;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
  }
  function pointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const last = pointers.current.get(event.pointerId);
    if (!last) return;
    const next = { x: event.clientX, y: event.clientY };
    const other = [...pointers.current].find(([key]) => key !== event.pointerId)?.[1];
    if (!moved.current && !other && Math.hypot(next.x - last.x, next.y - last.y) < 4) return;
    if (!moved.current) event.currentTarget.setPointerCapture(event.pointerId);
    moved.current = true;
    fitted.current = null;
    pointers.current.set(event.pointerId, next);
    if (!other) {
      setView(
        (value) =>
          value && { ...value, x: value.x + next.x - last.x, y: value.y + next.y - last.y },
      );
      return;
    }
    const before = Math.hypot(last.x - other.x, last.y - other.y);
    const box = event.currentTarget.getBoundingClientRect();
    if (before > 0)
      zoom(
        Math.hypot(next.x - other.x, next.y - other.y) / before,
        (next.x + other.x) / 2 - box.left,
        (next.y + other.y) / 2 - box.top,
      );
  }
  function pointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    pointers.current.delete(event.pointerId);
  }
  function keyDown(event: ReactKeyboardEvent<SVGSVGElement>) {
    const pan = (
      {
        ArrowLeft: [48, 0],
        ArrowRight: [-48, 0],
        ArrowUp: [0, 48],
        ArrowDown: [0, -48],
      } as Record<string, [number, number] | undefined>
    )[event.key];
    if (pan) {
      fitted.current = null;
      setView((value) => value && { ...value, x: value.x + pan[0], y: value.y + pan[1] });
    } else if (event.key === '+' || event.key === '=') zoom(1.25, area.width / 2, area.height / 2);
    else if (event.key === '-') zoom(0.8, area.width / 2, area.height / 2);
    else if (event.key === '0') fit(true);
    else return;
    event.preventDefault();
  }
  const active = selected === null ? null : boxes[selected];
  return (
    <div
      ref={frame}
      className="n8n-canvas"
      data-artifact-scroll=""
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || selected === null) return;
        event.preventDefault();
        close();
      }}
    >
      <svg
        ref={svg}
        role="group"
        aria-label={workflow.name}
        tabIndex={0}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
        onKeyDown={keyDown}
        onClick={(event) => {
          if (!moved.current && !(event.target as Element).closest('.n8n-node')) setSelected(null);
        }}
      >
        <defs>
          <pattern
            id={`${id}-dots`}
            width={20}
            height={20}
            patternUnits="userSpaceOnUse"
            patternTransform={view ? `translate(${view.x} ${view.y}) scale(${view.k})` : undefined}
          >
            <circle className="n8n-canvas-dot" cx={1} cy={1} r={1} />
          </pattern>
          <marker
            id={`${id}-arrow`}
            viewBox="0 0 10 10"
            refX={10}
            refY={5}
            markerWidth={10}
            markerHeight={10}
            markerUnits="userSpaceOnUse"
            orient="auto"
          >
            <path className="n8n-canvas-arrow" d="M0,0L10,5L0,10Z" />
          </marker>
        </defs>
        <rect width="100%" height="100%" fill={`url(#${id}-dots)`} />
        {view && (
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {boxes.map(
              (box, index) =>
                box.sticky && (
                  <g key={index} className="n8n-sticky">
                    <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={8} />
                    <text x={box.x + 16} y={box.y + 30}>
                      {clip(stickyText(box.parameters.content), Math.floor((box.w - 32) / 9))}
                    </text>
                  </g>
                ),
            )}
            {workflow.connections.map((connection, index) => (
              <path
                key={index}
                className={`n8n-edge${connection.type === 'main' ? '' : ' is-ai'}`}
                d={edgePath(connection, named)}
                markerEnd={connection.type === 'main' ? `url(#${id}-arrow)` : undefined}
              />
            ))}
            {boxes.map((box, index) => {
              if (box.sticky) return null;
              const wide = box.w > 100 && !box.sub;
              const middle = box.y + box.h / 2;
              const center = wide ? box.x + 50 : box.x + box.w / 2;
              const Icon = icon(box.type);
              const glyph = box.sub ? 32 : 40;
              return (
                <g
                  key={index}
                  data-node={index}
                  className={`n8n-node is-${box.category}${box.sub ? ' is-sub' : ''}${box.disabled ? ' is-disabled' : ''}`}
                  role="button"
                  tabIndex={0}
                  aria-label={box.name}
                  aria-pressed={selected === index}
                  onClick={() => {
                    if (!moved.current) setSelected(index);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    setSelected(index);
                  }}
                >
                  <title>{box.name}</title>
                  <path className="n8n-node-ring" d={shape(box, 5)} />
                  <path className="n8n-node-box" d={shape(box, 0)} />
                  {!box.sub &&
                    box.category !== 'trigger' &&
                    range(box.inputs).map((input) => (
                      <rect
                        key={`in${input}`}
                        className="n8n-port"
                        x={box.x - 5}
                        y={port(box, input, box.inputs) - 8}
                        width={5}
                        height={16}
                        rx={1.5}
                      />
                    ))}
                  {!box.sub &&
                    range(box.outputs).map((output) => (
                      <circle
                        key={`out${output}`}
                        className="n8n-port"
                        cx={box.x + box.w}
                        cy={port(box, output, box.outputs)}
                        r={6}
                      />
                    ))}
                  {box.labels?.map((label, output) => (
                    <text
                      key={`label${output}`}
                      className="n8n-port-label"
                      x={box.x + box.w + 12}
                      y={port(box, output, box.outputs) - 10}
                    >
                      {label}
                    </text>
                  ))}
                  {box.sub && <path className="n8n-port" d={diamond(box.x + box.w / 2, box.y)} />}
                  {box.slots.map((type, slot) => (
                    <g key={type}>
                      <path className="n8n-port" d={diamond(slotX(box, slot), box.y + box.h)} />
                      <text
                        className="n8n-port-label"
                        x={slotX(box, slot)}
                        y={box.y + box.h + 26}
                        textAnchor="middle"
                      >
                        {slotLabel(type)}
                      </text>
                    </g>
                  ))}
                  {Icon ? (
                    <Icon
                      className="n8n-node-icon"
                      x={center - glyph / 2}
                      y={middle - glyph / 2}
                      size={glyph}
                    />
                  ) : (
                    <text
                      className="n8n-node-glyph"
                      x={center}
                      y={middle}
                      textAnchor="middle"
                      dominantBaseline="central"
                    >
                      {initials(box.type)}
                    </text>
                  )}
                  {wide ? (
                    <text
                      className="n8n-node-title"
                      x={box.x + 92}
                      y={middle}
                      dominantBaseline="central"
                    >
                      {clip(box.name, Math.floor((box.w - 108) / 9))}
                    </text>
                  ) : (
                    <text
                      className="n8n-node-label"
                      x={box.x + box.w / 2}
                      y={box.y + box.h + 26}
                      textAnchor="middle"
                    >
                      {wrap(box.name, box.sub ? 13 : 18).map((line, index) => (
                        <tspan key={index} x={box.x + box.w / 2} dy={index ? 20 : 0}>
                          {line}
                        </tspan>
                      ))}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        )}
      </svg>
      <div className="n8n-canvas-controls">
        <Button
          variant="outline"
          size="icon"
          aria-label="Fit to view"
          title="Fit (0)"
          onClick={() => fit(true)}
        >
          <Scan size={16} />
        </Button>
        {workflow.url && (
          <Button variant="outline" size="sm" asChild>
            <a href={workflow.url} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={16} aria-hidden="true" />
              Open in n8n
            </a>
          </Button>
        )}
      </div>
      {active && (
        <section className="n8n-canvas-details" aria-label={active.name}>
          <header>
            <div>
              <h3>{active.name}</h3>
              <span>
                {active.type}
                {active.typeVersion === undefined ? '' : ` · v${active.typeVersion}`}
              </span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close details"
              title="Close (Esc)"
              onClick={close}
            >
              <X size={16} />
            </Button>
          </header>
          {active.notes && <p>{active.notes}</p>}
          {Object.keys(active.parameters).length > 0 && (
            <CodeView
              text={JSON.stringify(active.parameters, null, 2)}
              language="json"
              wrap
              numbers={false}
            />
          )}
        </section>
      )}
    </div>
  );
}

export default function WorkflowCanvas({
  text,
  onDetail,
  fallback,
}: {
  text: string;
  onDetail(detail: string): void;
  fallback: ReactNode;
}) {
  const workflow = useMemo(() => parseWorkflow(text), [text]);
  const count = workflow?.nodes.filter((node) => node.type !== stickyType).length ?? 0;
  useEffect(() => {
    if (workflow) onDetail(`${formatNumber(count)} ${count === 1 ? 'node' : 'nodes'}`);
  }, [workflow, count, onDetail]);
  return workflow ? <Canvas workflow={workflow} /> : fallback;
}
