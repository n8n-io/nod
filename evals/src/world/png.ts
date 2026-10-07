import { crc32, deflateSync } from 'node:zlib';

const font = Object.fromEntries(
  'Aehhvhhh Buhhuhhu Cehggghe Duhhhhhu Evgguggv Fvgguggg Gehgnhhf Hhhhvhhh Ie44444e J72222ic Khikokih Lggggggv Mhrllhhh Nhhpljhh Oehhhhhe Puhhuggg Qehhhlid Ruhhukih Sfgge11u Tv444444 Uhhhhhhe Vhhhhha4 Whhhllla Xhha4ahh Yhha4444 Zv1248gv 0ehjlphe 14c4444e 2eh1248v 3v2421he 426aiv22 5vgu11he 668guhhe 7v124888 8ehhehhe 9ehhf12c :0cc0cc0 -000v000 .00000cc ?eh12404'
    .split(' ')
    .map((glyph) => [glyph[0]!, [...glyph.slice(1)].map((row) => parseInt(row, 32))]),
);
const scale = 5;
const margin = 40;

function chunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

export function textPng(lines: string[]) {
  const text = lines.map((line) => line.toUpperCase());
  const width = margin * 2 + Math.max(...text.map((line) => line.length)) * 6 * scale;
  const height = margin * 2 + text.length * 10 * scale;
  const pixels = Buffer.alloc((width + 1) * height, 255);
  for (let row = 0; row < height; row++) pixels[row * (width + 1)] = 0;
  text.forEach((line, lineIndex) =>
    [...line].forEach((character, column) => {
      const glyph = font[character] ?? [0, 0, 0, 0, 0, 0, 0];
      glyph.forEach((bits, y) => {
        for (let x = 0; x < 5; x++) {
          if (!(bits & (16 >> x))) continue;
          for (let dy = 0; dy < scale; dy++)
            for (let dx = 0; dx < scale; dx++) {
              const px = margin + (column * 6 + x) * scale + dx;
              const py = margin + (lineIndex * 10 + y) * scale + dy;
              pixels[py * (width + 1) + 1 + px] = 0;
            }
        }
      });
    }),
  );
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
