'use strict';

const bdb = require('bdb');

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
  s: bdb.key('s')
};

module.exports = layout;
