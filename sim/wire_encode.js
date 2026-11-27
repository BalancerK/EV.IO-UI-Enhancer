

// wire_encode.js — the msgpack encoder for state packets.
//
// Byte-for-byte the same output as @msgpack/msgpack's encode() for everything a state packet holds,
// with one difference: a non-integer number that float32 represents EXACTLY (Math.fround(v) === v)
// is written as a 5-byte float32 instead of a 9-byte float64. That is lossless (the decoder reads it
// back as the identical double), so it is safe for every value, comparator-checked or not. Values
// that are deliberately reduced to float32 precision before sending (peer positions, velocities and
// view angles: see _f32PeerKinematics) are what make it pay: 4 bytes saved per number.
//
// Anything this does not know (Map, Date, typed arrays other than bytes...) is handed to
// @msgpack/msgpack and its bytes are copied in, so the output is never wrong, only sometimes slower.
//
// Same code as the Node server's wire_encode.js (CommonJS there); change both.

import { encode as msgpackEncode } from './msgpack/index.mjs';

let buf = new Uint8Array(16384);
let view = new DataView(buf.buffer);
let pos = 0;

function ensure(n) {
  if (pos + n <= buf.length) return;
  let size = buf.length * 2;
  while (size < pos + n) size *= 2;
  const next = new Uint8Array(size);
  next.set(buf.subarray(0, pos));
  buf = next;
  view = new DataView(buf.buffer);
}

function writeNumber(v) {
  if (Number.isSafeInteger(v)) {
    if (v >= 0) {
      if (v < 0x80) { ensure(1); buf[pos++] = v; }
      else if (v < 0x100) { ensure(2); buf[pos++] = 0xcc; buf[pos++] = v; }
      else if (v < 0x10000) { ensure(3); buf[pos++] = 0xcd; view.setUint16(pos, v); pos += 2; }
      else if (v < 0x100000000) { ensure(5); buf[pos++] = 0xce; view.setUint32(pos, v); pos += 4; }
      else { ensure(9); buf[pos++] = 0xcf; view.setBigUint64(pos, BigInt(v)); pos += 8; }
    } else {
      if (v >= -0x20) { ensure(1); buf[pos++] = (v + 0x100) & 0xff; }
      else if (v >= -0x80) { ensure(2); buf[pos++] = 0xd0; view.setInt8(pos, v); pos += 1; }
      else if (v >= -0x8000) { ensure(3); buf[pos++] = 0xd1; view.setInt16(pos, v); pos += 2; }
      else if (v >= -0x80000000) { ensure(5); buf[pos++] = 0xd2; view.setInt32(pos, v); pos += 4; }
      else { ensure(9); buf[pos++] = 0xd3; view.setBigInt64(pos, BigInt(v)); pos += 8; }
    }
    return;
  }
  if (Math.fround(v) === v) { ensure(5); buf[pos++] = 0xca; view.setFloat32(pos, v); pos += 4; return; }
  ensure(9); buf[pos++] = 0xcb; view.setFloat64(pos, v); pos += 8;
}

function writeString(s) {
  const n = s.length;
  // ASCII fast path (every opcode string we send in practice); anything else via TextEncoder.
  let ascii = true;
  for (let i = 0; i < n; i++) if (s.charCodeAt(i) > 0x7f) { ascii = false; break; }
  const bytes = ascii ? null : new TextEncoder().encode(s);
  const len = ascii ? n : bytes.length;
  if (len < 32) { ensure(1 + len); buf[pos++] = 0xa0 | len; }
  else if (len < 0x100) { ensure(2 + len); buf[pos++] = 0xd9; buf[pos++] = len; }
  else if (len < 0x10000) { ensure(3 + len); buf[pos++] = 0xda; view.setUint16(pos, len); pos += 2; }
  else { ensure(5 + len); buf[pos++] = 0xdb; view.setUint32(pos, len); pos += 4; }
  if (ascii) { for (let i = 0; i < n; i++) buf[pos++] = s.charCodeAt(i); }
  else { buf.set(bytes, pos); pos += len; }
}

function writeHeader(len, fix, fixMax, c16, c32) {
  if (len < fixMax) { ensure(1); buf[pos++] = fix | len; }
  else if (len < 0x10000) { ensure(3); buf[pos++] = c16; view.setUint16(pos, len); pos += 2; }
  else { ensure(5); buf[pos++] = c32; view.setUint32(pos, len); pos += 4; }
}

function writeBytes(u8) {
  const len = u8.byteLength;
  if (len < 0x100) { ensure(2 + len); buf[pos++] = 0xc4; buf[pos++] = len; }
  else if (len < 0x10000) { ensure(3 + len); buf[pos++] = 0xc5; view.setUint16(pos, len); pos += 2; }
  else { ensure(5 + len); buf[pos++] = 0xc6; view.setUint32(pos, len); pos += 4; }
  buf.set(u8, pos); pos += len;
}

function write(v, depth) {
  if (depth > 100) throw new Error('wire_encode: too deeply nested');
  switch (typeof v) {
    case 'number': writeNumber(v); return;
    case 'string': writeString(v); return;
    case 'boolean': ensure(1); buf[pos++] = v ? 0xc3 : 0xc2; return;
    case 'undefined': ensure(1); buf[pos++] = 0xc0; return;
    case 'object':
      if (v === null) { ensure(1); buf[pos++] = 0xc0; return; }
      if (Array.isArray(v)) {
        writeHeader(v.length, 0x90, 16, 0xdc, 0xdd);
        for (let i = 0; i < v.length; i++) write(v[i], depth + 1);
        return;
      }
      if (v instanceof Uint8Array) { writeBytes(v); return; }
      if (Object.getPrototypeOf(v) === Object.prototype) {
        const keys = Object.keys(v);
        writeHeader(keys.length, 0x80, 16, 0xde, 0xdf);
        for (const k of keys) { writeString(k); write(v[k], depth + 1); }
        return;
      }
      break;
    default: break;
  }
  const raw = msgpackEncode(v);   // anything unusual: let the reference encoder do it
  ensure(raw.byteLength); buf.set(raw, pos); pos += raw.byteLength;
}

function encodeWire(value) {
  pos = 0;
  write(value, 0);
  return buf.slice(0, pos);   // a copy: the scratch buffer is reused by the next call
}

export { encodeWire };
