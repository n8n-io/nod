import { createConnection } from 'node:net';

const alignment = {
  y: 1,
  b: 4,
  n: 2,
  q: 2,
  i: 4,
  u: 4,
  x: 8,
  t: 8,
  d: 8,
  s: 4,
  o: 4,
  g: 1,
  v: 1,
  a: 4,
  '(': 8,
  '{': 8,
};
const methodReturn = 2;
const error = 3;
const signalType = 4;
const field = {
  path: 1,
  interface: 2,
  member: 3,
  errorName: 4,
  replySerial: 5,
  destination: 6,
  signature: 8,
};

const align = (offset, size) => (offset + size - 1) & ~(size - 1);

function end(signature, start) {
  if (signature[start] === 'a') return end(signature, start + 1);
  if (signature[start] !== '(' && signature[start] !== '{') return start + 1;
  const close = signature[start] === '(' ? ')' : '}';
  let index = start + 1;
  while (signature[index] !== close) index = end(signature, index);
  return index + 1;
}

function read(cursor, signature, start = 0) {
  const { buffer } = cursor;
  const code = signature[start];
  cursor.at = align(cursor.at, alignment[code]);
  const number = (size, method) => {
    const value = buffer[method](cursor.at);
    cursor.at += size;
    return typeof value === 'bigint' ? Number(value) : value;
  };
  switch (code) {
    case 'y':
      return buffer[cursor.at++];
    case 'b':
      return number(4, 'readUInt32LE') !== 0;
    case 'n':
      return number(2, 'readInt16LE');
    case 'q':
      return number(2, 'readUInt16LE');
    case 'i':
      return number(4, 'readInt32LE');
    case 'u':
      return number(4, 'readUInt32LE');
    case 'x':
      return number(8, 'readBigInt64LE');
    case 't':
      return number(8, 'readBigUInt64LE');
    case 'd':
      return number(8, 'readDoubleLE');
    case 's':
    case 'o': {
      const length = number(4, 'readUInt32LE');
      const value = buffer.toString('utf8', cursor.at, cursor.at + length);
      cursor.at += length + 1;
      return value;
    }
    case 'g': {
      const length = buffer[cursor.at++];
      const value = buffer.toString('utf8', cursor.at, cursor.at + length);
      cursor.at += length + 1;
      return value;
    }
    case 'v':
      return read(cursor, read(cursor, 'g'));
    case 'a': {
      const length = number(4, 'readUInt32LE');
      const element = signature.slice(start + 1, end(signature, start + 1));
      cursor.at = align(cursor.at, alignment[element[0]]);
      const stop = cursor.at + length;
      const dictionary = element[0] === '{';
      const items = dictionary ? {} : [];
      while (cursor.at < stop) {
        const item = read(cursor, element);
        if (dictionary) items[item[0]] = item[1];
        else items.push(item);
      }
      return items;
    }
    case '(':
    case '{': {
      const items = [];
      for (
        let index = start + 1;
        signature[index] !== (code === '(' ? ')' : '}');
        index = end(signature, index)
      )
        items.push(read(cursor, signature, index));
      return items;
    }
    default:
      throw new Error(`The session bus sent an unsupported value type ${code}.`);
  }
}

function writer() {
  const parts = [];
  let length = 0;
  const bytes = (value) => {
    parts.push(value);
    length += value.length;
  };
  const pad = (size) => bytes(Buffer.alloc(align(length, size) - length));
  const u32 = (value) => {
    pad(4);
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(value);
    bytes(buffer);
  };
  const text = (value) => {
    const buffer = Buffer.from(value);
    u32(buffer.length);
    bytes(Buffer.concat([buffer, Buffer.alloc(1)]));
  };
  const signature = (value) =>
    bytes(Buffer.concat([Buffer.from([value.length]), Buffer.from(value), Buffer.alloc(1)]));
  return { bytes, pad, u32, text, signature, done: () => Buffer.concat(parts) };
}

function body(signature, values) {
  const out = writer();
  let index = 0;
  for (let at = 0; at < signature.length;) {
    if (signature[at] === 's') {
      out.text(values[index++]);
      at++;
    } else if (signature.startsWith('a{sv}', at) && Object.keys(values[index++]).length === 0) {
      out.u32(0);
      out.pad(8);
      at += 5;
    } else throw new Error('The session bus client sends only strings and empty dictionaries.');
  }
  return out.done();
}

function call(serial, { destination, path, interface: name, member, signature = '', values = [] }) {
  const fields = writer();
  for (const [code, type, value] of [
    [field.path, 'o', path],
    [field.interface, 's', name],
    [field.member, 's', member],
    [field.destination, 's', destination],
    ...(signature ? [[field.signature, 'g', signature]] : []),
  ]) {
    fields.pad(8);
    fields.bytes(Buffer.from([code]));
    fields.signature(type);
    if (type === 'g') fields.signature(value);
    else fields.text(value);
  }
  const header = fields.done();
  const content = body(signature, values);
  const fixed = Buffer.alloc(16);
  fixed.write('l\x01\x00\x01', 0, 'latin1');
  fixed.writeUInt32LE(content.length, 4);
  fixed.writeUInt32LE(serial, 8);
  fixed.writeUInt32LE(header.length, 12);
  return Buffer.concat([
    fixed,
    header,
    Buffer.alloc(align(16 + header.length, 8) - 16 - header.length),
    content,
  ]);
}

export function parseMessages(buffer) {
  const messages = [];
  let offset = 0;
  while (buffer.length - offset >= 16) {
    const frame = buffer.subarray(offset);
    const fieldsEnd = align(16 + frame.readUInt32LE(12), 8);
    const total = fieldsEnd + frame.readUInt32LE(4);
    if (frame.length < total) break;
    const message = frame.subarray(0, total);
    const headers = {};
    for (const [code, value] of read({ buffer: message, at: 12 }, 'a(yv)')) headers[code] = value;
    const signature = headers[field.signature] ?? '';
    const cursor = { buffer: message, at: fieldsEnd };
    const values = [];
    for (let index = 0; index < signature.length; index = end(signature, index))
      values.push(read(cursor, signature, index));
    messages.push({
      type: message[1],
      path: headers[field.path],
      member: headers[field.member],
      errorName: headers[field.errorName],
      replySerial: headers[field.replySerial],
      values,
    });
    offset += total;
  }
  return { messages, rest: buffer.subarray(offset) };
}

export function connectSessionBus({ onSignal }) {
  const match = /(?:^|;)unix:(?:[^;,]*,)*path=([^;,]+)/.exec(
    process.env.DBUS_SESSION_BUS_ADDRESS ?? '',
  );
  const socket = createConnection(
    match ? decodeURIComponent(match[1]) : `${process.env.XDG_RUNTIME_DIR}/bus`,
  );
  const pending = new Map();
  let serial = 0;
  let received = Buffer.alloc(0);
  let authenticated = false;
  let failure;
  let accept;
  let refuse;
  const authentication = new Promise((resolve, reject) => {
    accept = resolve;
    refuse = reject;
  });
  const fail = (reason) => {
    failure ??= reason;
    refuse(failure);
    for (const { reject } of pending.values()) reject(failure);
    pending.clear();
  };
  const send = async (request) => {
    await authentication;
    if (failure) throw failure;
    const id = ++serial;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.write(call(id, request));
    });
  };
  socket.on('connect', () =>
    socket.write(
      Buffer.concat([
        Buffer.from('\0AUTH EXTERNAL '),
        Buffer.from(Buffer.from(String(process.getuid())).toString('hex')),
        Buffer.from('\r\n'),
      ]),
    ),
  );
  socket.on('error', (reason) =>
    fail(new Error(`The session bus connection failed: ${reason.message}`)),
  );
  socket.on('close', () => fail(new Error('The session bus connection closed.')));
  socket.on('data', (chunk) => {
    received = Buffer.concat([received, chunk]);
    if (!authenticated) {
      const line = received.indexOf('\r\n');
      if (line < 0) return;
      const reply = received.toString('latin1', 0, line);
      received = received.subarray(line + 2);
      if (!reply.startsWith('OK'))
        return fail(new Error(`The session bus refused the connection: ${reply}`));
      socket.write('BEGIN\r\n');
      authenticated = true;
      accept();
    }
    let parsed;
    try {
      parsed = parseMessages(received);
    } catch (reason) {
      socket.destroy();
      return fail(reason);
    }
    received = parsed.rest;
    for (const message of parsed.messages) {
      if (message.type === signalType) {
        try {
          onSignal(message);
        } catch {}
      }
      const request = pending.get(message.replySerial);
      if (!request || ![methodReturn, error].includes(message.type)) continue;
      pending.delete(message.replySerial);
      if (message.type === error)
        request.reject(new Error(`${message.errorName}: ${message.values[0] ?? ''}`));
      else request.resolve(message.values);
    }
  });
  const bus = {
    call: send,
    close: () => socket.destroy(),
  };
  return send({
    destination: 'org.freedesktop.DBus',
    path: '/org/freedesktop/DBus',
    interface: 'org.freedesktop.DBus',
    member: 'Hello',
  }).then(
    () => bus,
    (reason) => {
      socket.destroy();
      throw reason;
    },
  );
}
