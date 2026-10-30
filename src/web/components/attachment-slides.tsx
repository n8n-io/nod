import { useEffect, useState, type CSSProperties } from 'react';

type Box = {
  x: number;
  y: number;
  w: number;
  h: number;
  rotate: number;
  flipH: boolean;
  flipV: boolean;
};
type Run = {
  text: string;
  size: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  caps: boolean;
  color: string;
  font: string;
  breakLine?: boolean;
};
type Paragraph = {
  align: string;
  marginLeft: number;
  indent: number;
  bullet: string | null;
  runs: Run[];
  size: number;
  color: string;
  lineHeight: string;
  before: number;
  after: number;
};
type TextBody = {
  paragraphs: Paragraph[];
  anchor: string;
  insets: [number, number, number, number];
  wrap: boolean;
};
type Item =
  | {
      kind: 'shape';
      box: Box;
      fill?: string;
      line?: { color: string; width: number };
      radius?: number | 'round';
      text?: TextBody;
    }
  | { kind: 'image'; box: Box; src: string }
  | { kind: 'line'; box: Box; color: string; width: number }
  | {
      kind: 'table';
      box: Box;
      columns: number[];
      rows: { height: number; cells: { text: TextBody; fill?: string; span: number }[] }[];
    };
type Slide = { background: string; image?: string; items: Item[] };
type Deck = { width: number; height: number; slides: Slide[]; urls: string[] };

type Part = { path: string; doc: Document; rels: Map<string, string> };
type Theme = { colors: Record<string, string>; major: string; minor: string };
type Context = {
  theme: Theme;
  map: Record<string, string>;
  media(part: Part, id: string | null): string | undefined;
  defaults?: Element;
  layout?: Part;
  master?: Part;
};

const relationshipNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const colorTags = new Set(['srgbClr', 'schemeClr', 'sysClr', 'prstClr', 'scrgbClr']);
const presetColors: Record<string, string> = {
  black: '000000',
  white: 'FFFFFF',
  red: 'FF0000',
  green: '008000',
  blue: '0000FF',
  yellow: 'FFFF00',
  gray: '808080',
};
const imageTypes: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
};

const child = (node: Element | null | undefined, name: string) =>
  node ? Array.from(node.children).find((item) => item.localName === name) : undefined;
const children = (node: Element | null | undefined, name: string) =>
  node ? Array.from(node.children).filter((item) => item.localName === name) : [];
const descend = (node: Element | null | undefined, ...names: string[]) =>
  names.reduce<Element | undefined>((current, name) => child(current, name), node ?? undefined);
const numeric = (node: Element | null | undefined, name: string) => {
  const value = node?.getAttribute(name);
  return value === null || value === undefined || value === '' ? undefined : Number(value);
};

function resolvePath(directory: string, target: string) {
  const output: string[] = [];
  for (const part of (target.startsWith('/') ? target.slice(1) : `${directory}/${target}`).split(
    '/',
  ))
    if (part === '..') output.pop();
    else if (part && part !== '.') output.push(part);
  return output.join('/');
}

function hsl(hex: string) {
  const [r, g, b] = [0, 2, 4].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

function rgb([h, s, l]: number[]) {
  const channel = (t: number) => {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    t = (t + 1) % 1;
    return t < 1 / 6
      ? p + (q - p) * 6 * t
      : t < 1 / 2
        ? q
        : t < 2 / 3
          ? p + (q - p) * (2 / 3 - t) * 6
          : p;
  };
  return s === 0 ? [l, l, l] : [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)];
}

function color(node: Element | undefined, context: Context): string | undefined {
  const element =
    node && colorTags.has(node.localName)
      ? node
      : node && Array.from(node.children).find((item) => colorTags.has(item.localName));
  if (!element) return undefined;
  const value = element.getAttribute('val') ?? '';
  const hex =
    element.localName === 'srgbClr'
      ? value
      : element.localName === 'sysClr'
        ? (element.getAttribute('lastClr') ?? (value === 'window' ? 'FFFFFF' : '000000'))
        : element.localName === 'schemeClr'
          ? context.theme.colors[context.map[value] ?? value]
          : element.localName === 'prstClr'
            ? (presetColors[value] ?? '000000')
            : undefined;
  if (!hex || !/^[0-9a-f]{6}$/i.test(hex)) return undefined;
  let [h, s, l] = hsl(hex);
  let channels: number[] | undefined;
  let alpha = 1;
  for (const modifier of Array.from(element.children)) {
    const amount = Number(modifier.getAttribute('val') ?? 0) / 100_000;
    if (modifier.localName === 'lumMod') l *= amount;
    else if (modifier.localName === 'lumOff') l += amount;
    else if (modifier.localName === 'satMod') s *= amount;
    else if (modifier.localName === 'alpha') alpha = amount;
    else if (modifier.localName === 'tint' || modifier.localName === 'shade') {
      channels = (channels ?? rgb([h, s, l])).map((value) =>
        modifier.localName === 'tint' ? value * amount + (1 - amount) : value * amount,
      );
      [h, s, l] = hsl(
        channels
          .map((value) =>
            Math.round(value * 255)
              .toString(16)
              .padStart(2, '0'),
          )
          .join(''),
      );
    }
  }
  const [r, g, b] = rgb([h, Math.min(1, Math.max(0, s)), Math.min(1, Math.max(0, l))]).map(
    (value) => Math.round(value * 255),
  );
  return alpha < 1 ? `rgb(${r} ${g} ${b} / ${alpha})` : `rgb(${r} ${g} ${b})`;
}

function fill(properties: Element | undefined, context: Context, style?: Element) {
  for (const item of properties ? Array.from(properties.children) : []) {
    if (item.localName === 'noFill') return 'transparent';
    if (item.localName === 'solidFill') return color(item, context);
    if (item.localName === 'gradFill') {
      const stops = children(child(item, 'gsLst'), 'gs')
        .map(
          (stop) =>
            `${color(stop, context) ?? 'transparent'} ${(numeric(stop, 'pos') ?? 0) / 1000}%`,
        )
        .join(', ');
      const angle = (numeric(child(item, 'lin'), 'ang') ?? 0) / 60_000 + 90;
      return child(item, 'path')
        ? `radial-gradient(${stops})`
        : `linear-gradient(${angle}deg, ${stops})`;
    }
  }
  const reference = descend(style, 'fillRef');
  return reference && numeric(reference, 'idx') ? color(reference, context) : undefined;
}

function outline(properties: Element | undefined, context: Context, style?: Element) {
  const line = child(properties, 'ln');
  if (child(line, 'noFill')) return undefined;
  const width = numeric(line, 'w') ?? 9525;
  const solid = color(child(line, 'solidFill'), context);
  if (solid) return { color: solid, width };
  const reference = descend(style, 'lnRef');
  return reference && numeric(reference, 'idx') && !line
    ? { color: color(reference, context) ?? '#000', width }
    : undefined;
}

function frame(transform: Element | undefined): Box | undefined {
  const offset = child(transform, 'off');
  const extent = child(transform, 'ext');
  if (!offset || !extent) return undefined;
  return {
    x: numeric(offset, 'x') ?? 0,
    y: numeric(offset, 'y') ?? 0,
    w: numeric(extent, 'cx') ?? 0,
    h: numeric(extent, 'cy') ?? 0,
    rotate: (numeric(transform, 'rot') ?? 0) / 60_000,
    flipH: transform?.getAttribute('flipH') === '1',
    flipV: transform?.getAttribute('flipV') === '1',
  };
}

function placeholderOf(shape: Element) {
  const ph = descend(shape, 'nvSpPr', 'nvPr', 'ph') ?? descend(shape, 'nvPicPr', 'nvPr', 'ph');
  return ph ? { type: ph.getAttribute('type') ?? 'body', idx: ph.getAttribute('idx') } : undefined;
}

function findPlaceholder(part: Part | undefined, type: string, idx: string | null, master = false) {
  const shapes = children(descend(part?.doc.documentElement, 'cSld', 'spTree'), 'sp');
  const normal = (value: string) =>
    master
      ? value === 'ctrTitle'
        ? 'title'
        : value === 'subTitle' || value === 'obj'
          ? 'body'
          : value
      : value;
  return (
    (!master && idx !== null
      ? shapes.find((shape) => placeholderOf(shape)?.idx === idx)
      : undefined) ??
    shapes.find((shape) => {
      const ph = placeholderOf(shape);
      return ph && normal(ph.type) === normal(type);
    })
  );
}

function textStyle(type: string | undefined, context: Context) {
  const styles = descend(context.master?.doc.documentElement, 'txStyles');
  if (!type) return context.defaults ?? child(styles, 'otherStyle');
  if (type === 'title' || type === 'ctrTitle') return child(styles, 'titleStyle');
  if (['body', 'subTitle', 'obj'].includes(type)) return child(styles, 'bodyStyle');
  return child(styles, 'otherStyle');
}

function readText(
  chain: Element[],
  type: string | undefined,
  context: Context,
): TextBody | undefined {
  const body = child(chain[0], 'txBody');
  if (!body) return undefined;
  const bodyProperties = chain
    .map((shape) => descend(shape, 'txBody', 'bodyPr'))
    .filter(Boolean) as Element[];
  const attribute = (name: string) =>
    bodyProperties.map((item) => item.getAttribute(name)).find((value) => value !== null);
  const autofit = child(child(body, 'bodyPr'), 'normAutofit');
  const scale = (numeric(autofit, 'fontScale') ?? 100_000) / 100_000;
  const spacing = 1 - (numeric(autofit, 'lnSpcReduction') ?? 0) / 100_000;
  const lists = [
    ...chain.map((shape) => descend(shape, 'txBody', 'lstStyle')),
    textStyle(type, context),
  ];
  const counters: number[] = [];
  const paragraphs = children(body, 'p').map((paragraph): Paragraph => {
    const properties = child(paragraph, 'pPr');
    const level = (numeric(properties, 'lvl') ?? 0) + 1;
    const levels = [properties, ...lists.map((list) => child(list, `lvl${level}pPr`))].filter(
      Boolean,
    ) as Element[];
    const pick = (name: string) =>
      levels.map((item) => item.getAttribute(name)).find((value) => value !== null);
    const nested = (name: string) => levels.map((item) => child(item, name)).find(Boolean);
    const defaults = levels.map((item) => child(item, 'defRPr')).filter(Boolean) as Element[];
    const runProperties = (own?: Element) => {
      const sources = [own, ...defaults].filter(Boolean) as Element[];
      const value = (name: string) =>
        sources.map((item) => item.getAttribute(name)).find((entry) => entry !== null);
      const typeface = sources
        .map((item) => child(item, 'latin')?.getAttribute('typeface'))
        .find(Boolean);
      return {
        size: (Number(value('sz') ?? 1800) / 100) * scale,
        bold: ['1', 'true'].includes(value('b') ?? ''),
        italic: ['1', 'true'].includes(value('i') ?? ''),
        underline: Boolean(value('u')) && value('u') !== 'none',
        caps: value('cap') === 'all',
        color:
          sources.map((item) => color(child(item, 'solidFill'), context)).find(Boolean) ??
          `#${context.theme.colors[context.map.tx1 ?? 'dk1'] ?? '000000'}`,
        font:
          typeface === '+mj-lt'
            ? context.theme.major
            : !typeface || typeface === '+mn-lt'
              ? context.theme.minor
              : typeface,
      };
    };
    const runs: Run[] = [];
    for (const item of Array.from(paragraph.children)) {
      if (item.localName === 'r' || item.localName === 'fld')
        runs.push({
          text: child(item, 't')?.textContent ?? '',
          ...runProperties(child(item, 'rPr')),
        });
      else if (item.localName === 'br')
        runs.push({ text: '', breakLine: true, ...runProperties(child(item, 'rPr')) });
    }
    const end = runProperties(child(paragraph, 'endParaRPr'));
    const bulletNode = levels
      .map((item) =>
        Array.from(item.children).find((entry) =>
          ['buNone', 'buChar', 'buAutoNum', 'buBlip'].includes(entry.localName),
        ),
      )
      .find(Boolean);
    const hasText = runs.some((run) => run.text.trim());
    counters.length = level;
    counters[level - 1] = (counters[level - 1] ?? 0) + (hasText ? 1 : 0);
    const bullet = !hasText
      ? null
      : bulletNode?.localName === 'buChar'
        ? (bulletNode.getAttribute('char') ?? '•')
        : bulletNode?.localName === 'buAutoNum'
          ? `${(numeric(bulletNode, 'startAt') ?? 1) + counters[level - 1] - 1}.`
          : bulletNode?.localName === 'buBlip'
            ? '•'
            : null;
    const lineSpacing = nested('lnSpc');
    const space = (name: string, size: number) => {
      const node = nested(name);
      const points = numeric(child(node, 'spcPts'), 'val');
      if (points !== undefined) return points / 100;
      return ((numeric(child(node, 'spcPct'), 'val') ?? 0) / 100_000) * size;
    };
    const size = runs[0]?.size ?? end.size;
    const linePoints = numeric(child(lineSpacing, 'spcPts'), 'val');
    return {
      align:
        { ctr: 'center', r: 'right', just: 'justify', dist: 'justify' }[pick('algn') ?? ''] ??
        'left',
      marginLeft: Number(pick('marL') ?? 0),
      indent: Number(pick('indent') ?? 0),
      bullet,
      runs,
      size,
      color: runs[0]?.color ?? end.color,
      lineHeight:
        linePoints !== undefined
          ? `${linePoints / 100}pt`
          : String(
              ((numeric(child(lineSpacing, 'spcPct'), 'val') ?? 100_000) / 100_000) * 1.2 * spacing,
            ),
      before: space('spcBef', size),
      after: space('spcAft', size),
    };
  });
  return {
    paragraphs,
    anchor: attribute('anchor') ?? 't',
    insets: [
      Number(attribute('lIns') ?? 91_440),
      Number(attribute('tIns') ?? 45_720),
      Number(attribute('rIns') ?? 91_440),
      Number(attribute('bIns') ?? 45_720),
    ],
    wrap: attribute('wrap') !== 'none',
  };
}

function readShapes(
  tree: Element | undefined,
  part: Part,
  context: Context,
  placeholders: boolean,
  place: (box: Box) => Box = (box) => box,
): Item[] {
  const items: Item[] = [];
  for (const shape of tree ? Array.from(tree.children) : []) {
    const properties = child(shape, 'spPr') ?? child(shape, 'grpSpPr');
    const style = child(shape, 'style');
    if (shape.localName === 'grpSp') {
      const transform = child(properties, 'xfrm');
      const box = frame(transform);
      const origin = child(transform, 'chOff');
      const extent = child(transform, 'chExt');
      if (!box || !origin || !extent) continue;
      const scaleX = box.w / (numeric(extent, 'cx') || box.w || 1);
      const scaleY = box.h / (numeric(extent, 'cy') || box.h || 1);
      items.push(
        ...readShapes(shape, part, context, placeholders, (inner) =>
          place({
            ...inner,
            x: box.x + (inner.x - (numeric(origin, 'x') ?? 0)) * scaleX,
            y: box.y + (inner.y - (numeric(origin, 'y') ?? 0)) * scaleY,
            w: inner.w * scaleX,
            h: inner.h * scaleY,
          }),
        ),
      );
      continue;
    }
    const placeholder = placeholderOf(shape);
    if (placeholder && !placeholders) continue;
    const chain = [shape];
    if (placeholder && part.path.startsWith('ppt/slides/')) {
      const layout = findPlaceholder(context.layout, placeholder.type, placeholder.idx);
      if (layout) chain.push(layout);
      const master = findPlaceholder(context.master, placeholder.type, placeholder.idx, true);
      if (master) chain.push(master);
    }
    const box = chain
      .map((item) =>
        frame(child(child(item, 'spPr') ?? child(item, 'grpSpPr'), 'xfrm') ?? child(item, 'xfrm')),
      )
      .find(Boolean);
    if (!box) continue;
    const placed = place(box);
    if (shape.localName === 'pic') {
      const embed =
        descend(shape, 'blipFill', 'blip')?.getAttributeNS(relationshipNs, 'embed') ?? null;
      const src = context.media(part, embed);
      if (src) items.push({ kind: 'image', box: placed, src });
    } else if (shape.localName === 'cxnSp') {
      const line = outline(properties, context, style);
      if (line) items.push({ kind: 'line', box: placed, ...line });
    } else if (shape.localName === 'graphicFrame') {
      const table = descend(shape, 'graphic', 'graphicData', 'tbl');
      if (!table) continue;
      items.push({
        kind: 'table',
        box: placed,
        columns: children(child(table, 'tblGrid'), 'gridCol').map(
          (column) => numeric(column, 'w') ?? 0,
        ),
        rows: children(table, 'tr').map((row) => ({
          height: numeric(row, 'h') ?? 0,
          cells: children(row, 'tc')
            .filter(
              (cell) => cell.getAttribute('hMerge') !== '1' && cell.getAttribute('vMerge') !== '1',
            )
            .map((cell) => ({
              text: readText([cell], undefined, context) ?? {
                paragraphs: [],
                anchor: 't',
                insets: [91_440, 45_720, 91_440, 45_720],
                wrap: true,
              },
              fill: fill(child(cell, 'tcPr'), context),
              span: numeric(cell, 'gridSpan') ?? 1,
            })),
        })),
      });
    } else if (shape.localName === 'sp') {
      const text = readText(chain, placeholder?.type, context);
      const background = fill(properties, context, style);
      const hasText = text?.paragraphs.some((paragraph) =>
        paragraph.runs.some((run) => run.text.trim()),
      );
      if (placeholder && !hasText && (!background || background === 'transparent')) continue;
      const geometry = child(properties, 'prstGeom')?.getAttribute('prst');
      items.push({
        kind: 'shape',
        box: placed,
        fill: background,
        line: outline(properties, context, style),
        radius:
          geometry === 'ellipse'
            ? 'round'
            : geometry === 'roundRect'
              ? Math.min(placed.w, placed.h) * 0.16667
              : undefined,
        text: hasText ? text : undefined,
      });
    }
  }
  return items;
}

function background(part: Part | undefined, context: Context) {
  const node = descend(part?.doc.documentElement, 'cSld', 'bg');
  if (!node || !part) return undefined;
  const properties = child(node, 'bgPr');
  const embed = descend(properties, 'blipFill', 'blip')?.getAttributeNS(relationshipNs, 'embed');
  if (embed) return { image: context.media(part, embed) };
  const value = properties ? fill(properties, context) : color(child(node, 'bgRef'), context);
  return value ? { color: value } : undefined;
}

async function readDeck(buffer: ArrayBuffer): Promise<Deck> {
  const { unzipSync, strFromU8 } = await import('fflate');
  const files = unzipSync(new Uint8Array(buffer), {
    filter: (file) =>
      file.originalSize < 60_000_000 &&
      /^ppt\/(?:presentation\.xml|_rels\/presentation\.xml\.rels|slides\/|slideLayouts\/|slideMasters\/|theme\/|media\/)/.test(
        file.name,
      ),
  });
  const parser = new DOMParser();
  const parts = new Map<string, Part>();
  const urls: string[] = [];
  const media = new Map<string, string>();
  const relationships = (path: string) => {
    const directory = path.slice(0, path.lastIndexOf('/'));
    const file = files[`${directory}/_rels/${path.slice(directory.length + 1)}.rels`];
    const map = new Map<string, string>();
    if (!file) return map;
    for (const item of Array.from(
      parser.parseFromString(strFromU8(file), 'application/xml').documentElement.children,
    ))
      if (item.getAttribute('TargetMode') !== 'External')
        map.set(
          item.getAttribute('Id') ?? '',
          resolvePath(directory, item.getAttribute('Target') ?? ''),
        );
    return map;
  };
  const part = (path: string | undefined) => {
    if (!path || !files[path]) return undefined;
    if (!parts.has(path))
      parts.set(path, {
        path,
        doc: parser.parseFromString(strFromU8(files[path]), 'application/xml'),
        rels: relationships(path),
      });
    return parts.get(path);
  };
  const presentation = part('ppt/presentation.xml');
  if (!presentation) throw new Error('Not a presentation.');
  const size = child(presentation.doc.documentElement, 'sldSz');
  const width = numeric(size, 'cx') ?? 12_192_000;
  const height = numeric(size, 'cy') ?? 6_858_000;
  const slides: Slide[] = [];
  for (const entry of children(child(presentation.doc.documentElement, 'sldIdLst'), 'sldId').slice(
    0,
    300,
  )) {
    const slide = part(presentation.rels.get(entry.getAttributeNS(relationshipNs, 'id') ?? ''));
    if (!slide) continue;
    const layout = part(
      Array.from(slide.rels.values()).find((target) => target.includes('slideLayouts/')),
    );
    const master = part(
      Array.from(layout?.rels.values() ?? []).find((target) => target.includes('slideMasters/')),
    );
    const themeDoc = part(
      Array.from(master?.rels.values() ?? []).find((target) => target.includes('theme/')),
    )?.doc;
    const scheme = descend(themeDoc?.documentElement, 'themeElements', 'clrScheme');
    const fonts = descend(themeDoc?.documentElement, 'themeElements', 'fontScheme');
    const map = Object.fromEntries(
      Array.from(child(master?.doc.documentElement, 'clrMap')?.attributes ?? []).map(
        (attribute) => [attribute.name, attribute.value],
      ),
    );
    const context: Context = {
      theme: {
        colors: Object.fromEntries(
          Array.from(scheme?.children ?? []).map((item) => {
            const value = item.firstElementChild;
            return [
              item.localName,
              value?.getAttribute('lastClr') ?? value?.getAttribute('val') ?? '000000',
            ];
          }),
        ),
        major: descend(fonts, 'majorFont', 'latin')?.getAttribute('typeface') ?? 'Calibri',
        minor: descend(fonts, 'minorFont', 'latin')?.getAttribute('typeface') ?? 'Calibri',
      },
      map: { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2', ...map },
      defaults: child(presentation.doc.documentElement, 'defaultTextStyle'),
      layout,
      master,
      media(owner, id) {
        const target = id ? owner.rels.get(id) : undefined;
        const type = imageTypes[target?.split('.').pop()?.toLowerCase() ?? ''];
        if (!target || !type || !files[target]) return undefined;
        if (!media.has(target)) {
          const url = URL.createObjectURL(new Blob([files[target]], { type }));
          urls.push(url);
          media.set(target, url);
        }
        return media.get(target);
      },
    };
    const visible = (owner: Part | undefined) =>
      owner?.doc.documentElement.getAttribute('showMasterSp') !== '0';
    const fill =
      background(slide, context) ?? background(layout, context) ?? background(master, context);
    slides.push({
      background: fill && 'color' in fill ? (fill.color ?? '#fff') : '#fff',
      image: fill && 'image' in fill ? fill.image : undefined,
      items: [
        ...(visible(slide) && visible(layout) && master
          ? readShapes(
              descend(master.doc.documentElement, 'cSld', 'spTree'),
              master,
              context,
              false,
            )
          : []),
        ...(visible(slide) && layout
          ? readShapes(
              descend(layout.doc.documentElement, 'cSld', 'spTree'),
              layout,
              context,
              false,
            )
          : []),
        ...readShapes(descend(slide.doc.documentElement, 'cSld', 'spTree'), slide, context, true),
      ],
    });
  }
  return { width, height, slides, urls };
}

function SlideText({ text, deck }: { text: TextBody; deck: Deck }) {
  const unit = (emu: number) => `${(emu / deck.width) * 100}cqw`;
  const points = (value: number) => unit(value * 12_700);
  return (
    <span
      className="slide-text"
      style={{
        justifyContent:
          text.anchor === 'ctr' ? 'center' : text.anchor === 'b' ? 'flex-end' : 'flex-start',
        padding: text.insets.map(unit).join(' '),
        whiteSpace: text.wrap ? 'pre-wrap' : 'pre',
      }}
    >
      {text.paragraphs.map((paragraph, index) => (
        <span
          className="slide-paragraph"
          key={index}
          style={{
            textAlign: paragraph.align as CSSProperties['textAlign'],
            paddingLeft: unit(paragraph.marginLeft),
            textIndent: unit(paragraph.indent),
            fontSize: points(paragraph.size),
            color: paragraph.color,
            lineHeight: paragraph.lineHeight.endsWith('pt')
              ? points(Number(paragraph.lineHeight.slice(0, -2)))
              : paragraph.lineHeight,
            marginTop: points(paragraph.before),
            marginBottom: points(paragraph.after),
          }}
        >
          {paragraph.bullet && (
            <span
              className="slide-bullet"
              style={{ minWidth: unit(Math.max(0, -paragraph.indent)) }}
            >
              {paragraph.bullet}
            </span>
          )}
          {paragraph.runs.length === 0 && ' '}
          {paragraph.runs.map((run, position) =>
            run.breakLine ? (
              <br key={position} />
            ) : (
              <span
                key={position}
                style={{
                  fontSize: points(run.size),
                  fontWeight: run.bold ? 700 : undefined,
                  fontStyle: run.italic ? 'italic' : undefined,
                  textDecoration: run.underline ? 'underline' : undefined,
                  textTransform: run.caps ? 'uppercase' : undefined,
                  color: run.color,
                  fontFamily: `"${run.font}", "Geist", system-ui, sans-serif`,
                }}
              >
                {run.text}
              </span>
            ),
          )}
        </span>
      ))}
    </span>
  );
}

function SlideItem({ item, deck }: { item: Item; deck: Deck }) {
  const unit = (emu: number) => `${(emu / deck.width) * 100}cqw`;
  const { box } = item;
  const position: CSSProperties = {
    left: `${(box.x / deck.width) * 100}%`,
    top: `${(box.y / deck.height) * 100}%`,
    width: `${(box.w / deck.width) * 100}%`,
    height: `${(box.h / deck.height) * 100}%`,
    transform:
      [
        box.rotate ? `rotate(${box.rotate}deg)` : '',
        item.kind !== 'shape' || !item.text
          ? `${box.flipH ? 'scaleX(-1)' : ''} ${box.flipV ? 'scaleY(-1)' : ''}`
          : '',
      ]
        .join(' ')
        .trim() || undefined,
  };
  if (item.kind === 'image')
    return <img className="slide-item" src={item.src} alt="" style={position} />;
  if (item.kind === 'line')
    return (
      <svg
        className="slide-item"
        style={{ ...position, overflow: 'visible' }}
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        <line
          x1="0"
          y1="0"
          x2="100"
          y2="100"
          stroke={item.color}
          strokeWidth={unit(item.width)}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    );
  if (item.kind === 'table') {
    const total = item.columns.reduce((sum, value) => sum + value, 0) || 1;
    return (
      <table className="slide-item slide-table" style={position}>
        <colgroup>
          {item.columns.map((column, index) => (
            <col key={index} style={{ width: `${(column / total) * 100}%` }} />
          ))}
        </colgroup>
        <tbody>
          {item.rows.map((row, rowIndex) => (
            <tr key={rowIndex} style={{ height: unit(row.height) }}>
              {row.cells.map((cell, cellIndex) => (
                <td key={cellIndex} colSpan={cell.span} style={{ background: cell.fill }}>
                  <SlideText text={cell.text} deck={deck} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <span
      className="slide-item slide-shape"
      style={{
        ...position,
        background: item.fill && item.fill !== 'transparent' ? item.fill : undefined,
        border: item.line ? `${unit(item.line.width)} solid ${item.line.color}` : undefined,
        borderRadius: item.radius === 'round' ? '50%' : item.radius ? unit(item.radius) : undefined,
      }}
    >
      {item.text && <SlideText text={item.text} deck={deck} />}
    </span>
  );
}

export function SlidesView({
  buffer,
  onDetail,
  onError,
}: {
  buffer: ArrayBuffer;
  onDetail(detail: string): void;
  onError(): void;
}) {
  const [deck, setDeck] = useState<Deck | null>(null);
  useEffect(() => {
    let active = true;
    let loaded: Deck | undefined;
    void readDeck(buffer)
      .then((value) => {
        loaded = value;
        if (!active) return value.urls.forEach((url) => URL.revokeObjectURL(url));
        if (!value.slides.length) return onError();
        setDeck(value);
        onDetail(`${value.slides.length} ${value.slides.length === 1 ? 'slide' : 'slides'}`);
      })
      .catch(() => {
        if (active) onError();
      });
    return () => {
      active = false;
      loaded?.urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [buffer, onDetail, onError]);
  if (!deck) return null;
  return (
    <div className="artifact-slides" tabIndex={0} data-artifact-scroll="">
      {deck.slides.map((slide, index) => (
        <figure className="artifact-slide" key={index}>
          <div
            className="slide-canvas"
            role="img"
            aria-label={`Slide ${index + 1}`}
            style={{
              aspectRatio: `${deck.width} / ${deck.height}`,
              background: slide.image
                ? `center / cover no-repeat url("${slide.image}")`
                : slide.background,
            }}
          >
            {slide.items.map((item, position) => (
              <SlideItem key={position} item={item} deck={deck} />
            ))}
          </div>
          <figcaption>{index + 1}</figcaption>
        </figure>
      ))}
    </div>
  );
}
