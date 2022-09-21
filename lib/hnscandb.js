'use strict';

const EventEmitter = require('events');
const path = require('path');
const bdb = require('bdb');
const layout = require('./layout');
const blake2b = require('bcrypto/lib/blake2b');
const { ChainState } = require('./types');
const { types } = require('hsd/lib/covenants/rules');

/**
 * HnscanDB
 * @alias module:hnscan.hnscanDB
 * @extends EventEmitter
 */
class HnscanDB extends EventEmitter {
  /**
   * Create a hnscan db.
   * @constructor
   * @param {Object} options
   */
  constructor(options) {
    super();

    this.network = options.network;
    this.logger = options.logger.context('hnscan');
    this.client = options.client;
    options.location = path.join(this.prefix, 'hnscan');

    this.db = bdb.create(options);
    this.state = new ChainState();
    this.pending = new ChainState();
  }

  /**
   * Open the hnscandb, wait for the database to load.
   * @returns {Promise}
   */
  async open() {
    await this.db.open();
    await this.db.verify(layout.V.encode(), 'hnscan', 0);
    const state = await this.getState();

    if (state) this.state = state;
  }

  /**
   * Return header from the database.
   * @returns {Promise}
   */
  async getHeaders(height) {
    return this.db.get(layout.h.encode(height));
  }

  async getHashByHeight(height) {
    const header = await this.db.get(layout.h.encode(height));
    return blake2b.digest(header);
  }

  /**
   * Verify network.
   * @returns {Promise}
   */
  async verifyNetwork() {
    const raw = await this.db.get(layout.O.encode());

    if (!raw) {
      const b = this.db.batch();
      b.put(layout.O.encode(), fromU32(this.network.magic));
      return b.write();
    }

    const magic = raw.readUInt32LE(0, true);
    if (magic !== this.network.magic) throw new Error('Network mismatch for HnscanDB.');

    return undefined;
  }

  /**
   * Close the hnscandb, wait for the database to close.
   * @returns {Promise}
   */
  async close() {
    return this.db.close();
  }

  batch() {
    return this.db.batch();
  }

  async saveEntry(entry, block, view) {
    this.pending = this.state.clone();
    const hash = block.hash();
    this.pending.connect(block);

    // Update chain state value.
    for (let i = 0; i < block.txs.length; i++) {
      const tx = block.txs[i];

      if (i > 0) {
        for (const { prevout } of tx.inputs) {
          this.pending.spend(view.getOutput(prevout));
        }
      }

      for (let i = 0; i < tx.outputs.length; i++) {
        const output = tx.outputs[i];

        if (output.isUnspendable()) continue;

        // Registers are burned.
        if (output.covenant.isRegister()) {
          this.pending.burn(output);
          continue;
        }

        if (output.covenant.type >= types.UPDATE && output.covenant.type <= types.REVOKE) continue;

        this.pending.add(output);
      }
    }

    this.pending.commit(hash);
    this.state = this.pending;
    this.pending = null;
  }

  async saveState() {
    this.db.put(layout.s.encode(), this.state.encode());
  }

  //Need to edit this function - add more error checking
  async setHeight(height) {
    this.height = height;

    //Insert into DB.
    await this.db.put(layout.H.encode(), fromU32(height));

    return;
  }

  async getHeight() {
    const height = await this.db.get(layout.H.encode());

    if (height == null) return 0;
    return toU32(height);
  }

  async getState() {
    const data = await this.db.get(layout.s.encode());

    if (!data) return null;

    return ChainState.decode(data);
  }
}

/*
 * Helpers
 */
function fromU32(num) {
  const data = Buffer.allocUnsafe(4);
  data.writeUInt32LE(num, 0, true);
  return data;
}

function toU32(buf) {
  const num = buf.readUInt32LE(0, true);
  return num;
}

module.exports = HnscanDB;
