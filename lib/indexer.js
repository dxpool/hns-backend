'use strict';

const EventEmitter = require('events');
const { Network } = require('hsd');
const Logger = require('blgr');
const assert = require('bsert');
const layout = require('./layout.js');
const util = require('./util.js');
const mutexify = require('mutexify/promise');
const { ChartData } = require('./types');
const poolData = require('./configs/pool.json');

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
   */

  constructor(options) {
    super();

    this.options = new IndexerOptions(options);

    this.network = this.options.network;
    this.logger = this.options.logger.context('hnscan');
    this.client = this.options.client;
    this.hnscan = this.options.hnscan;
    this.chain = this.options.chain;
    this.hdb = this.options.hdb;
    this.height = 0;

    this.lock = mutexify();

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
    this.client.on('error', e => {
      this.emit('error', e);
    });

    this.client.on('connect', async () => {
      try {
        await this.syncNode();
      } catch (e) {
        this.emit('error', e);
      }
    });

    this.client.bind('block connect', async (entry, block, view) => {
      try {
        await this.indexBlock(entry, block, view);
      } catch (e) {
        this.emit('error', e);
      }
    });

    this.client.bind('block disconnect', async (entry, block, view) => {
      try {
        //@todo
        await this.unindexBlock(entry, block, view);
      } catch (e) {
        this.emit('error', e);
      }
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
    await this.hdb.verifyNetwork();

    //Get tip of chain when starting
    let tip = await this.client.getTip();

    //Height of internal database.
    this.height = await this.hdb.getHeight();

    this.logger.info(
      'Hnscan initialized at height: %d, and chain tip: %d',
      this.height,
      tip.height
    );

    //Connect to the daemon.
    await this.connect();
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
    const unlock = await this.lock();
    let start = process.hrtime();
    try {
      this.logger.info('Resyncing from server...');
      await this.syncChain();
    } finally {
      // Add time here
      let end = process.hrtime(start);
      this.logger.info('Hnscan fully synced in %d seconds', end[0]);
      await this.hdb.saveState();
      unlock();
    }
  }

  /**
   * Connect and sync with the chain server.
   * @private
   * @returns {Promise}
   */
  async syncChain() {
    return this.scan();
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

    if (tip.height < height) {
      height = tip.height;
    }

    await this.rollback(height);

    this.logger.info('Hnscan is scanning %d blocks.', tip.height - height + 1);

    for (let i = height; i <= tip.height; i++) {
      const entry = await this.client.getEntry(i);
      assert(entry);

      const block = await this.client.getBlock(entry.hash);
      assert(block);

      const view = await this.client.getBlockView(block);
      assert(view);

      await this._indexBlock(entry, block, view);
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

    if (height > tip.height)
      throw new Error('Hnscan: Cannot rollback to the future.');

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

    //Insert into DB.
    await this.hdb.setHeight(height);

    return;
  }

  /**
   * Index a block with a lock
   * @param (ChainEntry) entry
   * @param (Block) block
   * @param (CoinView) view
   * @returns {Promise}
   */
  async indexBlock(entry, block, view) {
    const unlock = await this.lock();
    const start = new Date().getTime() / 1000;
    try {
      this.logger.info('Adding block: %d.', entry.height);
      return await this._indexBlock(entry, block, view);
    } finally {
      await this.hdb.saveState();
      unlock();
      this.logger.debug('Finished Adding block: %d. - %d seconds', entry.height, new Date().getTime() / 1000 - start);
    }
  }

  /**
   * Index a block
   * @param (ChainEntry) entry
   * @param (Block) block
   * @param (CoinView) view
   * @returns {Promise}
   */
  async _indexBlock(entry, block, view) {
    if (entry.height < this.height) {
      this.logger.warning('Hnscan is connecting low blocks (%d).', entry.height);
      return;
    }

    await this.indexTX(entry, block);
    await this.hdb.saveEntry(entry, block, view);

    const state = await this.hdb.state;
    let chartData = ChartData.fromBlockData(entry, block, state);

    const minerAddress = block.txs[0].outputs[0].address.toString('main');
    let miner = 'unknown';

    //Index the chart data
    await this.hdb.setChartData(chartData);

    for (const item in poolData) {
      if (poolData[item].address.indexOf(minerAddress) !== -1) {
        miner = item;
        break;
      }
    }

    await this.hdb.setPoolData(entry.time, entry.height, miner);

    // Sync the new tip.
    await this.setHeight(entry.height);
  }

  /**
   * Index a transaction by txid.
   * @private
   * @param (ChainEntry) entry
   * @param (Block) block
   * @param (CoinView) view
   */
  async indexTX(entry, block) {
    const b = this.hdb.batch();

    for (let tx of block.txs) {
      let txid = Buffer.from(tx.txid(), 'hex');

      for (let input of tx.inputs) {
        if (input.isCoinbase()) {
          continue;
        }

        let previousHashPrefix = Buffer.from(input.prevout.txid(), 'hex').slice(0, 8);
        let previousIndex = input.prevout.index;

        b.put(layout.i.encode(previousHashPrefix, previousIndex), txid);
      }

      for (let i = 0; i < tx.outputs.length; i++) {
        const output = tx.outputs[i];

        let address = Buffer.from(output.address.getHash(), 'hex');

        if (output.covenant.isName()) {
          const nameHash = output.covenant.getHash(0);
          const type = output.covenant.type;

          b.put(layout.n.encode(nameHash, txid), util.fromU32(entry.height));


          const data = [output.value, block.time];
          if (tx.inputs[i]) {
            data.push(tx.inputs[i].prevout.txid(), tx.inputs[i].prevout.index);
          }

          b.put(layout.a.encode(nameHash, type, txid, i), Buffer.from(JSON.stringify(data)));
        }

        b.put(layout.o.encode(address, txid), util.fromU32(entry.height));
      }

      b.put(layout.t.encode(txid), util.fromU32(entry.height));
    }

    await b.write();

    return;
  }
}

class IndexerOptions {
  /**
   * Create indexer options.
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    //TODO review these to see if they are all needed.
    this.network = Network.primary;
    this.logger = Logger.global;
    this.client = null;
    this.chain = null;
    this.prefix = null;
    this.location = null;
    this.memory = true;
    this.maxFiles = 64;
    this.cacheSize = 16 << 20;
    this.compression = true;

    if (options) this._fromOptions(options);
  }

  _fromOptions(options) {
    if (options.network != null) this.network = Network.get(options.network);

    if (options.logger != null) {
      assert(typeof options.logger === 'object');
      this.logger = options.logger;
    }

    if (options.client != null) {
      assert(typeof options.client === 'object');
      this.client = options.client;
    }

    assert(this.client);

    if (options.hdb != null) {
      assert(typeof options.hdb === 'object');
      this.hdb = options.hdb;
    }

    if (options.chain != null) {
      assert(typeof options.chain === 'object');
      this.chain = options.chain;
    }

    assert(this.hdb);

    if (options.hnscan != null) {
      assert(typeof options.hnscan === 'object');
      this.hnscan = options.hnscan;
    }

    if (options.prefix != null) {
      assert(typeof options.prefix === 'string');
      this.prefix = options.prefix;
      this.location = path.join(this.prefix, 'hnscan');
    }

    if (options.location != null) {
      assert(typeof options.location === 'string');
      this.location = options.location;
    }

    if (options.memory != null) {
      assert(typeof options.memory === 'boolean');
      this.memory = options.memory;
    }

    if (options.maxFiles != null) {
      assert(options.maxFiles >>> 0 === options.maxFiles);
      this.maxFiles = options.maxFiles;
    }

    if (options.cacheSize != null) {
      assert(Number.isSafeInteger(options.cacheSize) && options.cacheSize >= 0);
      this.cacheSize = options.cacheSize;
    }

    if (options.compression != null) {
      assert(typeof options.compression === 'boolean');
      this.compression = options.compression;
    }

    return this;
  }

  /**
   * Instantiate chain options from object.
   * @param {Object} options
   * @returns {IndexerOptions}
   */

  static fromOptions(options) {
    return new this()._fromOptions(options);
  }
}

module.exports = Indexer;
