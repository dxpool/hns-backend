'use strict';

/**
 * @exports util
 */

const util = exports;

util.now = function now() {
  return Math.floor(Date.now() / 1000);
};

util.fromU32 = function fromU32(num) {
  const data = Buffer.allocUnsafe(4);
  data.writeUInt32LE(num, 0, true);
  return data;
};

util.toU32 = function toU32(buf) {
  const num = buf.readUInt32LE(0, true);
  return num;
};

util.toDifficulty = function toDifficulty(bits) {
  let shift = (bits >>> 24) & 0xff;
  let diff = 0x0000ffff / (bits & 0x00ffffff);

  while (shift < 29) {
    diff *= 256.0;
    shift++;
  }

  while (shift > 29) {
    diff /= 256.0;
    shift--;
  }

  return diff;
};
