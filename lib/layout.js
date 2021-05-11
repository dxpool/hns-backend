/*!
 * layout.js - key layouts for leveldb database.
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * Copyright (c) 2018-2019, Handshake Alliance Developers (MIT License).
 * https://github.com/handshakealliance/
 */

'use strict';

const bdb = require('bdb');

//@todo remove the key for saving headers
//TODO finish documenting this.
/*
 *  V -> db version
 *  O -> flags
 *  H -> Last Sync Height
 *
 *  Transactions Output's Index
 *  o[SHA256(hash)(:8)] -> [txid(:8)]
 *  Code: o, Address Hash Prefix: hash(:8) -> Funding TxID Prefix: txid[:8]
 *
 *  Transactions Input Index
 *  i[txid(:8)][uint16][txid(:8)] -> Transaction inputs row.
 *  Code: i, Funding TxID Prefix: txid(8), Funding Output Index: uint, Spending TxID Prefix: txid(8)
 *
 *  Full Transaction IDs
 *  t[txid][uint32]
 *
 *  NameHash Transaction Index
 *
 *
 *  Block Difficulty Historical Data
 *  d[block_timestamp] -> hash rate
 *
 */

const layout = {
  V: bdb.key('V'),
  O: bdb.key('O'),
  H: bdb.key('H'),
  h: bdb.key('h', ['uint32']),
  o: bdb.key('o', ['hash', 'hash']),
  i: bdb.key('i', ['hash', 'uint32']),
  t: bdb.key('t', ['hash']),
  n: bdb.key('n', ['hash', 'hash']),
  d: bdb.key('d', ['uint32']),
  s: bdb.key('s'),
  m: bdb.key('m', ['uint32']),
  a: bdb.key('a', ['hash', 'uint32', 'hash', 'uint32'])
};

module.exports = layout;
