//@ts-check

import {
  NULL,
  BOOLEAN,
  NUMBER,
  STRING,
  ARRAY,
  OBJECT,
  BUFFER,
  TYPED,
  RECURSIVE,
  BIGINT,
  ERROR,
  REGEXP,
  SET,
  MAP,
  DATE,
} from './constants.js';

import { toASCII } from './utils/ascii.js';
import { toLength } from './utils/length.js';

/** @typedef {Map<any,number[]>} Cache */

/**
 * @typedef {object} Options
 * @prop {'all' | 'some' | 'none'} recursion With `all`, the default, everything but `null`, `boolean` and empty `string` will be tracked recursively. With `some`, all primitives get ignored. With `none`, no recursion is ever tracked, leading to *maximum callstack* if present in the encoded data.
 */

const MAX_PUSH = 1 << 16;

const { isArray } = Array;
const { isFinite } = Number;
const { toStringTag } = Symbol;
const { entries, getPrototypeOf } = Object;

const TypedArray = getPrototypeOf(Uint8Array);
const encoder = new TextEncoder;
const shared = new Uint8Array(MAX_PUSH);

/**
 * @param {any} value
 * @returns
 */
const asValid = value => {
  const type = typeof value;
  switch (type) {
    case 'symbol':
    case 'function':
    case 'undefined': return '';
    default: return type;
  }
};

class Encoder {
  /**
   * @param {Options} options
   */
  constructor(options) {
    const r = options.recursion;
    /** @type {0 | 1 | 2} */
    this.r = r === 'all' ? 2 : (r === 'none' ? 0 : 1);
    /** @type {number[]} */
    this.a = [];
    /** @type {Cache?} */
    this.m = this.r > 0 ? new Map : null;
  }

  /**
   * @param {any} value
   * @param {boolean} asNull
   */
  encode(value, asNull) {
    const known = this.r > 0 && /** @type {Cache} */(this.m).get(value);
    if (known) {
      this.a.push(...known);
      return;
    }

    switch (asValid(value)) {
      case 'object': {
        switch (true) {
          case value === null: {
            this.a.push(NULL);
            break;
          }
          case value.constructor === Object: {
            this.generic(value);
            break;
          }
          case isArray(value): {
            this.array(value);
            break;
          }
          case value instanceof ArrayBuffer: {
            this.buffer(value);
            break;
          }
          case value instanceof Date: {
            this.track(0, value);
            toASCII(this.a, DATE, value.toISOString());
            break;
          }
          case value instanceof Map: {
            this.map(value);
            break;
          }
          case value instanceof Set: {
            this.set(value);
            break;
          }
          case value instanceof RegExp: {
            this.track(0, value);
            this.simple(REGEXP, value.source, value.flags);
            break;
          }
          case value instanceof TypedArray:
          case value instanceof DataView: {
            this.track(0, value);
            this.simple(TYPED, value[toStringTag], value.buffer);
            break;
          }
          case value instanceof Error: {
            this.track(0, value);
            this.simple(ERROR, value.name, value.message);
            break;
          }
          default: {
            this.generic(value);
            break;
          }
        }
        break;
      }
      case 'string': {
        this.string(value);
        break;
      }
      case 'number': {
        if (isFinite(value)) {
          this.track(1, value);
          toASCII(this.a, NUMBER, String(value));
        }
        else this.a.push(NULL);
        break;
      }
      case 'boolean': {
        this.a.push(BOOLEAN, value ? 1 : 0);
        break;
      }
      case 'bigint': {
        this.track(1, value);
        toASCII(this.a, BIGINT, String(value));
        break;
      }
      default: {
        if (asNull) this.a.push(NULL);
        break;
      }
    }
  }

  /**
   * @param {0 | 1 | 2} level
   * @param {any} value
   */
  track(level, value) {
    if (this.r > level) {
      const r = [];
      toLength(r, RECURSIVE, this.a.length);
      /** @type {Cache} */(this.m).set(value, r);
    }
  }

  /**
   * @param {any[]} value
   */
  array(value) {
    this.track(0, value);
    this.null = true;
    const { length } = value;
    toLength(this.a, ARRAY, length);
    for (let i = 0; i < length; i++)
      this.encode(value[i], true);
    this.null = false;
  }

  /**
   * @param {ArrayBuffer} value
   */
  buffer(value) {
    this.track(0, value);
    const ui8a = new Uint8Array(value);
    const { length } = ui8a;
    if (toLength(this.a, BUFFER, length) < 4)
      this.a.push(...ui8a);
    else {
      for (let i = 0; i < length; i += MAX_PUSH)
        this.a.push(...ui8a.subarray(i, i + MAX_PUSH));
    }
  }

  /**
   * @param {object} value
   */
  generic(value) {
    this.track(0, value);
    const values = [];
    for (const [k, v] of entries(value)) {
      if (asValid(v)) values.push(k, v);
    }
    this.object(OBJECT, values);
  }

  /**
   * @param {Map} value
   */
  map(value) {
    this.track(0, value);
    const values = [];
    for (const [k, v] of value) {
      if (asValid(k) && asValid(v)) values.push(k, v);
    }
    this.object(MAP, values);
  }

  /**
   * @param {Set} value
   */
  set(value) {
    this.track(0, value);
    const values = [];
    for (const v of value) {
      if (asValid(v)) values.push(v);
    }
    this.object(SET, values);
  }

  /**
   * @param {string} value
   */
  string(value) {
    if (value.length) {
      this.track(1, value);
      let { length } = this.a;
      // grant enough entries to optimize strings up to 255 chars
      // that is [type, 1, X]
      this.a.push(0, 0, 0);
      let total = 0, read = 0, written = 0;
      do {
        if (read) value = value.slice(read);
        ({ read, written } = encoder.encodeInto(value, shared));
        if (written) {
          let codes = shared;
          if (written < MAX_PUSH) codes = shared.subarray(0, written);
          total += written;
          this.a.push(...codes);
        }
      }
      while (written);
      const info = [];
      if (1 === toLength(info, STRING, total)) {
        for (let i = 0; i < 3; i++)
          this.a[length++] = info[i];
      }
      else this.a.splice(length, 3, ...info);
    }
    else this.a.push(STRING, 0);
  }

  /**
   * @param {number} type
   * @param {any[]} values
   */
  object(type, values) {
    const { length } = values;
    if (length) {
      toLength(this.a, type, length);
      for (let i = 0; i < length; i++)
        this.encode(values[i], false);
    }
    else
      this.a.push(type, 0);
  }

  /**
   * @param {number} type
   * @param {any} key
   * @param {any} value
   */
  simple(type, key, value) {
    this.a.push(type);
    this.encode(key, false);
    this.encode(value, false);
  }
}

/**
 * @template T
 * @param {T extends undefined ? never : T extends Function ? never : T extends symbol ? never : T} value
 * @param {Options?} options
 * @returns
 */
export default (value, options = null) => {
  const encoder = new Encoder({ recursion: 'all', ...options });
  encoder.encode(value, false);
  return new Uint8Array(encoder.a);
};
