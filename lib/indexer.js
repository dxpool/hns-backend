'use strict';

const EventEmitter = require('events');
const { Network } = require('hsd');
const assert = require('bsert');
const poolData = require('./configs/pool.json');
const Db = require('./db/index.js');
const rules = require('hsd/lib/covenants/rules');
const { toDifficulty } = require('./util');

/**
 * Indexer
 * @alias module:hnscan.indexer
 * @extends EventEmitter
 */
class Indexer extends EventEmitter {
  /**
   * Create an indexer.
   * @constructor
   * @param {Object} options
   * @param {Db} options.db
   */
  constructor(options) {
    super();

    this.network = Network.get(options.network);
    this.logger = options.logger.context('hnscan');
    this.client = options.client;
    this.hnscan = options.hnscan;
    this.chain = options.chain;
    this.db = options.db;

    this.height = 0;
    this.scanning = false;
    this.pending = false;

    this.init();
  }

  /**
   * Initialize the indexer.
   * @private
   */
  init() {
    this._bind();
  }

  /**
   * Bind to node events.
   * @private
   */
  _bind() {
    this.client.on('error', e => this.emit('error', e));
    this.client.on('connect', async () => {
      try {
        await this.syncNode();
      } catch (e) {
        this.emit('error', e);
      }
    });

    this.client.bind('block connect', async (entry, block, view) => {
      this.syncChain(this.height + 1);
    });

    this.client.bind('chain reset', async tip => {
      try {
        await this.rollback(tip.height);
      } catch (e) {
        this.emit('error', e);
      }
    });
  }

  /**
   * Open the indexer.
   * @returns {Promise}
   */
  async open() {
    const tip = await this.client.getTip(); // Get tip of chain when starting
    const data = await this.db.blockDb.find().sort({ height: -1 }).limit(1).toArray();// Height of internal database.
    this.height = data && data[0] ? data[0].height : 0;

    this.logger.info('Hnscan initialized at height: %d, and chain tip: %d', this.height, tip.height);

    await this.connect(); // Connect to the daemon.
  }

  /**
   * Placeholder
   * @returns {Promise}
   */
  async close() {
    await this.disconnect();
    return;
  }

  /**
   * Connect to the node server (client required).
   * @returns {Promise}
   */
  async connect() {
    return this.client.open();
  }

  /**
   * Disconnect from chain server (client required).
   * @returns {Promise}
   */
  async disconnect() {
    return this.client.close();
  }

  /**
   * Sync state with server on every connect.
   * @returns {Promise}
   */
  async syncNode() {
    try {
      this.logger.info('Syncing from server...');
      await this.syncChain();
    } catch (e) {
      this.logger.error('Error syncing from server: %s', e.message);
    } finally {

    }
  }

  /**
   * Connect and sync with the chain server.
   * @private
   * @returns {Promise}
   */
  async syncChain(height) {
    if (this.scanning) {
      this.pending = true;
      return;
    }

    this.scanning = true;

    try {
      await this.scan(height);
    } catch (error) {
      this.logger.error('Error scanning chain: %s', error.message);
    } finally {
      this.scanning = false;
      if (this.pending) {
        this.pending = false;
        this.syncChain(this.height + 1);
      }
    }
  }

  /**
   * Rescan blockchain from a given height.
   * @private
   * @param {Number?} height
   * @returns {Promise}
   */
  async scan(height) {
    if (height == null) height = this.height;

    assert(height >>> 0 === height, 'Hnscan: Must pass in a height.');

    const tip = await this.client.getTip();
    if (tip.height < height) height = tip.height;

    await this.rollback(height);

    for (let i = height; i <= tip.height; i++) {
      const entry = await this.client.getEntry(i);
      const block = await this.client.getBlock(entry.hash);

      await this._indexBlock(entry, block);
      this.logger.info('Added block: %d.', entry.height);
    }
  }

  /**
   * Sync with chain height.
   * @param {Number} height
   * @returns {Promise}
   */
  //@todo Untested.
  async rollback(height) {
    const tip = this.client.getTip();

    if (height > tip.height) throw new Error('Hnscan: Cannot rollback to the future.');
    if (height === tip.height) {
      this.logger.info('Rolled back to same height (%d).', height);
      return;
    }

    this.logger.info('Rolling back %d HnscanDB blocks to height %d.', this.height - height, height);

    const entry = await this.client.getEntry(height);

    assert(entry);

    await this.setHeight(entry.height);
  }

  /**
   * Set internal indexer height.
   * @param {Number} height
   * @returns {Promise}
   */
  async setHeight(height) {
    this.height = height;
    return;
  }

  /**
   * Index a block with a lock
   * @param (ChainEntry) entry
   * @param (Block) block
   * @returns {Promise}
   */
  async indexBlock(entry, block) {
    const start = new Date().getTime() / 1000;
    try {
      this.logger.info('Adding block: %d.', entry.height);
      return await this._indexBlock(entry, block);
    } finally {
      this.logger.debug('Finished Adding block: %d. - %d seconds', entry.height, new Date().getTime() / 1000 - start);
    }
  }

  /**
   * Index a block
   * @param (ChainEntry) entry
   * @param (Block) block
   * @returns {Promise}
   */
  async _indexBlock(entry, block) {
    if (entry.height < this.height) {
      this.logger.warning('Hnscan is connecting low blocks (%d).', entry.height);
      return;
    }

    await this.indexTX(entry, block);
    const minerAddress = block.txs[0].outputs[0].address.toString('main');
    let miner = 'unknown';

    for (const item in poolData) {
      if (poolData[item].address.indexOf(minerAddress) !== -1) {
        miner = item;
        break;
      }
    }

    await this.setHeight(entry.height);
    await this.db.blockDb.updateOne({ height: entry.height }, {
      $set: {
        hash: entry.hash.toString('hex'),
        difficulty: toDifficulty(entry.bits),
        time: entry.time,
        txs: block.txs.length,
        miner: miner,
        minerAddress: minerAddress
      }
    }, {
      upsert: true
    });
  }

  async getCurrentSummary() {
    const item = await this.db.summaryDb.find().sort({ time: -1 }).limit(1).toArray();

    return item && item[0] ? item[0] : {
      time: 0,
      blocks: 0,
      difficulty: 0,
      txs: 0,
      totalTxs: 0,
      supply: 0,
      burned: 0
    };
  }

  /**
   * Index a transaction by txid.
   * @private
   * @param (ChainEntry) entry
   * @param {Block} block
   */
  async indexTX(entry, block) {
    const coins = [];
    const names = new Map();
    const txs = [];

    let supply = 0;
    let burned = 0;

    for (const tx of block.txs) {
      const addresses = new Set();
      let isCoinbase = false;

      for (let i = 0; i < tx.inputs.length; i++) {
        const input = tx.input(i);
        if (input.isCoinbase()) {
          isCoinbase = true;
          continue;
        }

        const item = await this.db.coinDb.findOne({
          txid: input.prevout.txid(),
          index: input.prevout.index
        });

        if (!item) continue;

        addresses.add(item.address);
        coins.push({
          updateOne: {
            filter: { txid: input.prevout.txid(), index: input.prevout.index },
            update: {
              $set: {
                spent: true,
                spentTxid: tx.txid(),
                spentIndex: i
              }
            }
          },
          upsert: true
        });
      }

      for (let o = 0; o < tx.outputs.length; o++) {
        const output = tx.outputs[o];

        if (isCoinbase) supply += output.value;

        const address = output.address.getHash().toString('hex');
        addresses.add(address);
        const value = parseInt(output.value);

        const item = {
          txid: tx.txid(),
          height: entry.height,
          time: entry.time,
          index: o,
          address: address,
          value: value,
          type: output.covenant.type,
          covenant: output.covenant.items.map(i => i.toString('hex'))
        };

        if (output.covenant.isName()) {
          const nameHash = output.covenant.getHash(0);
          const type = output.covenant.type;

          item.nameHash = nameHash.toString('hex');
          switch (type) {
            case rules.types.CLAIM:
            case rules.types.OPEN:
              names.set(item.nameHash, {
                updateOne: {
                  filter: { nameHash: item.nameHash },
                  update: {
                    $set: {
                      name: output.covenant.items[2].toString('ascii'),
                      open: entry.height,
                      value: 0,
                      highest: 0
                    }
                  },
                  upsert: true
                }
              });
              break;

            case rules.types.REVEAL:
              let data = names.get(item.nameHash);
              if (!data) {
                const result = await this.db.nameDb.findOne({ nameHash: item.nameHash });
                if (!result) break;

                data = {
                  updateOne: {
                    filter: { nameHash: item.nameHash },
                    update: {
                      $set: {
                        value: result.value,
                        highest: result.highest
                      }
                    },
                    upsert: true
                  }
                };
              }

              if (value <= data.updateOne.update.$set.value) break;
              if (value <= data.updateOne.update.$set.highest) {
                data.updateOne.update.$set.value = value;
              } else {
                data.updateOne.update.$set.value = data.updateOne.update.$set.highest;
                data.updateOne.update.$set.highest = value;
              }

              names.set(item.nameHash, data);
              break;

            case rules.types.REGISTER:
              burned += output.value;
              break;
          }
        }

        coins.push({
          updateOne: {
            filter: { txid: tx.txid(), index: o },
            update: {
              $setOnInsert: { spent: false },
              $set: item
            },
            upsert: true
          }
        });
      }

      txs.push({
        updateOne: {
          filter: { txid: tx.txid() },
          update: {
            $set: {
              height: entry.height,
              hash: entry.hash.toString('hex'),
              time: entry.time,
              addresses: Array.from(addresses)
            }
          },
          upsert: true
        }
      });
    }

    if (coins.length > 0) await this.db.coinDb.bulkWrite(coins);
    if (names.size > 0) await this.db.nameDb.bulkWrite(Array.from(names.values()));
    if (txs.length > 0) await this.db.txDb.bulkWrite(txs);

    const current = await this.getCurrentSummary();
    const dayTime = entry.time - entry.time % (24 * 60 * 60);
    const data = {
      blocks: 1,
      txs: block.txs.length,
      totalTxs: block.txs.length,
      difficulty: toDifficulty(entry.bits),
      supply: supply / Math.pow(10, 6),
      burned: burned / Math.pow(10, 6)
    };

    if (current.time < dayTime) {
      data.totalTxs += current.totalTxs;
      data.supply += current.supply;
      data.burned += current.burned;
    }

    await this.db.summaryDb.updateOne({ time: dayTime }, { $inc: data }, { upsert: true });

    return;
  }
}

module.exports = Indexer;
