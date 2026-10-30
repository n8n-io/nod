import { crc32 } from 'node:zlib';

interface RasterImage {
  bytes: Uint8Array;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
}

const dimensions = (width: number, height: number) =>
  width > 0 && height > 0 && width <= 4096 && height <= 4096 && width * height <= 16000000;

function png(value: Buffer) {
  if (!value.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
  let header = false;
  let palette = false;
  let data = 0;
  let startedData = false;
  let afterData = false;
  let color = -1;
  let depth = 0;
  for (let offset = 8; offset + 12 <= value.length;) {
    const length = value.readUInt32BE(offset);
    if (length > value.length - offset - 12) return false;
    const kind = value.toString('latin1', offset + 4, offset + 8);
    const body = value.subarray(offset + 8, offset + 8 + length);
    if (
      !/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(kind) ||
      crc32(value.subarray(offset + 4, offset + 8 + length)) !==
        value.readUInt32BE(offset + 8 + length) ||
      ['acTL', 'fcTL', 'fdAT'].includes(kind)
    )
      return false;
    if (!header && kind !== 'IHDR') return false;
    if (kind === 'IHDR') {
      if (header || length !== 13 || !dimensions(body.readUInt32BE(0), body.readUInt32BE(4)))
        return false;
      depth = body[8];
      color = body[9];
      const depths: Record<number, number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (!depths[color]?.includes(depth) || body[10] !== 0 || body[11] !== 0 || body[12] > 1)
        return false;
      header = true;
    } else if (kind === 'PLTE') {
      if (
        palette ||
        startedData ||
        !length ||
        length % 3 ||
        length > 768 ||
        [0, 4].includes(color) ||
        (color === 3 && length / 3 > 2 ** depth)
      )
        return false;
      palette = true;
    } else if (kind === 'IDAT') {
      if (afterData || (color === 3 && !palette)) return false;
      startedData = true;
      data += length;
    } else if (kind === 'IEND') {
      return length === 0 && data > 0 && offset + 12 === value.length;
    } else {
      if (!(value[offset + 4] & 32)) return false;
      if (startedData) afterData = true;
    }
    offset += length + 12;
  }
  return false;
}

function jpeg(value: Buffer) {
  if (value[0] !== 255 || value[1] !== 216) return false;
  let offset = 2;
  let frame = false;
  let scans = 0;
  const components = new Set<number>();
  while (offset + 2 <= value.length) {
    if (value[offset++] !== 255) return false;
    while (value[offset] === 255) offset++;
    const marker = value[offset++];
    if (marker === 217) return frame && scans > 0 && offset === value.length;
    if (
      marker === 216 ||
      marker === 0 ||
      (marker >= 208 && marker <= 215) ||
      offset + 2 > value.length
    )
      return false;
    const length = value.readUInt16BE(offset);
    if (length < 2 || offset + length > value.length) return false;
    if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
      if (
        frame ||
        length < 11 ||
        !dimensions(value.readUInt16BE(offset + 5), value.readUInt16BE(offset + 3))
      )
        return false;
      const count = value[offset + 7];
      if (!count || length !== 8 + 3 * count || ![8, 12, 16].includes(value[offset + 2]))
        return false;
      for (let index = 0; index < count; index++) {
        const component = value[offset + 8 + index * 3];
        const sampling = value[offset + 9 + index * 3];
        if (
          components.has(component) ||
          !(sampling & 15) ||
          (sampling & 15) > 4 ||
          !(sampling >> 4) ||
          sampling >> 4 > 4
        )
          return false;
        components.add(component);
      }
      frame = true;
    }
    if (marker !== 218) {
      offset += length;
      continue;
    }
    const count = value[offset + 2];
    if (!frame || !count || count > 4 || length !== 6 + 2 * count) return false;
    const selected = new Set<number>();
    for (let index = 0; index < count; index++) {
      const component = value[offset + 3 + index * 2];
      if (!components.has(component) || selected.has(component)) return false;
      selected.add(component);
    }
    offset += length;
    let entropy = 0;
    while (offset < value.length) {
      if (value[offset] !== 255) {
        entropy++;
        offset++;
        continue;
      }
      const start = offset++;
      while (value[offset] === 255) offset++;
      if (value[offset] === 0) {
        entropy++;
        offset++;
      } else if (value[offset] >= 208 && value[offset] <= 215) offset++;
      else {
        offset = start;
        break;
      }
    }
    if (!entropy) return false;
    scans++;
  }
  return false;
}

function webp(value: Buffer) {
  if (
    value.length < 20 ||
    value.toString('latin1', 0, 4) !== 'RIFF' ||
    value.toString('latin1', 8, 12) !== 'WEBP' ||
    value.readUInt32LE(4) !== value.length - 8
  )
    return false;
  let canvas: [number, number] | undefined;
  let image = false;
  let alpha = false;
  for (let offset = 12; offset < value.length;) {
    if (offset + 8 > value.length) return false;
    const kind = value.toString('latin1', offset, offset + 4);
    const length = value.readUInt32LE(offset + 4);
    const end = offset + 8 + length;
    const paddedEnd = end + (length % 2);
    if (paddedEnd > value.length || (length % 2 && value[end] !== 0)) return false;
    const body = value.subarray(offset + 8, end);
    if (['ANIM', 'ANMF'].includes(kind)) return false;
    if (kind === 'VP8X') {
      if (offset !== 12 || length !== 10 || body[0] & 0xc3 || body[1] || body[2] || body[3])
        return false;
      canvas = [body.readUIntLE(4, 3) + 1, body.readUIntLE(7, 3) + 1];
      if (!dimensions(...canvas)) return false;
    } else if (kind === 'VP8 ' || kind === 'VP8L') {
      if (image || (!canvas && offset !== 12)) return false;
      let size: [number, number];
      if (kind === 'VP8 ') {
        if (
          length <= 10 ||
          body[0] & 1 ||
          !(body[0] & 16) ||
          ((body[0] >> 1) & 7) > 3 ||
          !body.subarray(3, 6).equals(Buffer.from([157, 1, 42])) ||
          body.readUIntLE(0, 3) >>> 5 > length - 10
        )
          return false;
        size = [body.readUInt16LE(6) & 16383, body.readUInt16LE(8) & 16383];
      } else {
        if (alpha || length <= 5 || body[0] !== 47 || body[4] >> 5) return false;
        const bits = body.readUInt32LE(1);
        size = [(bits & 16383) + 1, ((bits >>> 14) & 16383) + 1];
      }
      if (!dimensions(...size) || (canvas && (canvas[0] !== size[0] || canvas[1] !== size[1])))
        return false;
      image = true;
    } else if (kind === 'ALPH') {
      if (
        !canvas ||
        image ||
        alpha ||
        length <= 1 ||
        body[0] & 0xc0 ||
        (body[0] & 3) > 1 ||
        ((body[0] >> 4) & 3) > 1
      )
        return false;
      alpha = true;
    } else if (!canvas) return false;
    offset = paddedEnd;
  }
  return image;
}

export function rasterImageType(bytes: Uint8Array): RasterImage['mimeType'] | null {
  const value = Buffer.from(bytes);
  if (png(value)) return 'image/png';
  if (jpeg(value)) return 'image/jpeg';
  if (webp(value)) return 'image/webp';
  return null;
}
