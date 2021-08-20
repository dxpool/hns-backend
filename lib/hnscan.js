'use strict';

const EventEmitter = require('events');
const Logger = require('blgr');
const assert = require('bsert');
const geoip = require('geoip-lite');

const { Network, Address } = require('hsd');
const consensus = require('hsd/lib/protocol/consensus');
const rules = require('hsd/lib/covenants/rules');
const NameState = require('hsd/lib/covenants/namestate');

const util = require('./util');
const pools = require('./configs/pool.json');
const Cache = require('./utils/cache');

/**
 * Hnscan
 * @alias module:hnscan.hnscanDB
 * @extends EventEmitter
 */

class Hnscan extends EventEmitter {
  /**
   * Create a hnscan .
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    super();
    this.options = new HnscanOptions(options);

    this.network = this.options.network;
    this.logger = this.options.logger.context('hnscan');
    this.client = this.options.client;
    this.chain = this.options.chain;
    this.hdb = this.options.hdb;
    this.node = this.options.node;

    this.cache = new Cache(60);
    this.nameList = [];
    this.statusNames = { OPENING: [], BIDDING: [], REVEAL: [], CLOSED: [], LOCKED: [], RENEWAL: [] };
    this.highValueNames = [];
    this.bidNames = { month: [], week: [] };

    setTimeout(() => {
      this.getNameList();
      this.getRecentHighestNames();
    }, 10 * 1000);
  }

  async getTxs(height, address, offset, limit) {
    if (height) {
      const [result, total] = await this.getTransactionsByHeight(height, offset, limit);
      return { total, result, limit, offset };
    }

    if (address) {
      const addr = Address.fromString(address, this.network.type);
      const [result, total] = await this.getTransactionsByAddress(addr, offset, limit);
      return { total, result, limit, offset };
    }

    const result = await this.getTransactions(limit);
    return { result };
  }

  async getNames(type, status, offset, limit) {
    let data = this.nameList;
    if (type) {
      switch (type) {
        case 'value':
          data = this.highValueNames;
          break;
        case 'monthBid':
          data = this.bidNames.month;
          break;
        case 'weekBid':
          data = this.bidNames.week;
          break;
      }
    } else if (status) {
      data = this.statusNames[status.toUpperCase()] || [];
    }

    let result = data.slice(offset, offset + limit);

    if (type && (type === 'monthBid' || type === 'weekBid')) {
      for (let i = 0; i < result.length; i++) {
        result[i] = { name: result[i][0], highest: result[i][1] };
      }
    }

    return { total: data.length, offset, limit, result };
  }

  async getTransactions(limit = 25) {
    const txs = [];

    for (let i = this.chain.height; i > -1; i--) {
      const block = await this.chain.getBlock(i);

      for (let tx of block.txs) {
        let json = await this.getTransaction(tx.hash());

        txs.push(json);

        if (txs.length === limit) {
          return txs;
        }
      }
    }
  }

  async getTransactionsByHeight(height, offset = 0, limit = 25) {
    const block = await this.chain.getBlock(height);
    let txs = [];

    let list = block.txs.slice(offset, offset + limit);

    for (const tx of list) {
      const json = await this.getTransaction(tx.hash());
      txs.push(json);
    }

    return [txs, block.txs.length];
  }

  async getTransactionsByAddress(addr, offset = 0, limit = 25) {
    let raw = this.cache.get(addr + ':txs');
    if (!raw) {
      raw = await this.hdb.addressHistory(addr);
      raw.sort((a, b) => {
        return b.height - a.height;
      });

      this.cache.set(addr + ':txs', raw);
    }

    const list = raw.slice(offset, offset + limit);

    let txs = [];

    for (let i = 0; i < list.length; i++) {
      let tx = await this.getTransaction(Buffer.from(list[i].tx_hash, 'hex'));
      txs.push(tx);
    }

    return [txs, raw.length];
  }

  async getAddress(addr) {
    let address = await this.hdb.addressBalance(addr);
    address.hash = addr.toString(this.network.type);

    return address;
  }

  async recoverPoolData(height) {
    try {
      const block = await this.chain.getBlock(height);
      if (!block) throw 'Block not found';

      const entry = await this.chain.getEntryByHeight(height);
      if (!entry) throw 'Entry not found';

      const miner = block.txs[0].outputs[0].address.toString(this.network.type);
      let poolName = 'unknown';
      for (const item in pools) {
        if (pools[item].address.indexOf(miner) !== -1) {
          poolName = item;
          break;
        }
      }
      console.log(entry.time, height, poolName, miner);

      await this.hdb.setPoolData(entry.time, height, poolName);
    } catch (error) {
      console.error(error);
    } finally {
      if (height < this.chain.height) {
        this.recoverPoolData(height + 1);
      }
    }
  }

  async getBlock(height, details = true) {
    const block = await this.chain.getBlock(height);
    const view = await this.chain.getBlockView(block);
    if (!view) return;

    const entry = await this.chain.getEntryByHeight(height);
    if (!entry) return;

    const mtp = await this.chain.getMedianTime(entry);
    const next = await this.chain.getNextHash(entry.hash);

    let cbOutput = block.txs[0].outputs[0].value;

    //Need to get reward here.
    let reward = consensus.getReward(height, this.network.halvingInterval);
    let fees = cbOutput - reward;
    let miner = block.txs[0].outputs[0].address.toString(this.network.type);

    let pool = {};
    for (const item in pools) {
      const match = pools[item].address.indexOf(miner);
      if (match !== -1) {
        pool = {
          url: pools[item].url,
          name: item
        }
      }
    }

    let txs = [];

    if (details) {
      for (const tx of block.txs) {
        const json = await this.getTransaction(tx.hash());
        txs.push(json);
      }
    }

    return {
      hash: entry.hash.toString('hex'),
      confirmations: this.chain.height - entry.height + 1,
      strippedSize: block.getBaseSize(),
      size: block.getSize(),
      weight: block.getWeight(),
      height: entry.height,
      version: entry.version,
      merkleRoot: entry.merkleRoot.toString('hex'),
      witnessRoot: entry.witnessRoot.toString('hex'),
      treeRoot: entry.treeRoot.toString('hex'),
      mask: entry.mask.toString('hex'),
      reservedRoot: entry.reservedRoot.toString('hex'),
      coinbase: details ? block.txs[0].inputs[0].witness.toJSON() : undefined,
      tx: details ? txs : undefined,
      txs: block.txs.length,
      reward: cbOutput,
      fees,
      miner,
      pool,
      averageFee: fees / block.txs.length,
      time: entry.time,
      medianTime: mtp,
      bits: entry.bits,
      difficulty: util.toDifficulty(entry.bits),
      chainwork: entry.chainwork.toString('hex', 64),
      prevBlock: !entry.prevBlock.equals(consensus.ZERO_HASH) ? entry.prevBlock.toString('hex') : null,
      nextHash: next ? next.toString('hex') : null,
      nonce: entry.nonce
    };
  }

  async getTransaction(hash) {
    const meta = await this.node.getMeta(hash);
    if (!meta) return;

    const view = await this.node.getMetaView(meta);
    let tx = meta.getJSON(this.network.type, view, this.chain.height);

    //Might want index in both inputs and outputs
    const inputs = [];

    let index = 0;
    for (const input of tx.inputs) {
      const json = {
        airdrop: undefined,
        coinbase: undefined,
        value: undefined,
        address: undefined
      };

      if (!input.coin) {
        if (index === 0) {
          json.value = consensus.getReward(tx.height, this.network.halvingInterval);
          json.coinbase = true;
        } else {
          json.airdrop = true;
        }
      } else {
        json.value = input.coin.value;
        json.address = input.coin.address;
      }

      inputs.push(json);
      index++;
    }

    //@todo break this into it's own function, along with the input one.
    const outputs = [];

    for (let i = 0; i < tx.outputs.length; i++) {
      const output = tx.outputs[i];

      const json = {
        action: output.covenant.action,
        address: output.address,
        value: undefined,
        name: undefined,
        nameHash: undefined
      };

      switch (json.action) {
        case 'NONE':
          json.value = output.value;
          break;

        case 'OPEN':
          json.name = Buffer.from(output.covenant.items[2], 'hex').toString();
          break;

        case 'BID':
          json.name = Buffer.from(output.covenant.items[2], 'hex').toString();
          json.value = output.value;
          break;

        case 'REVEAL':
          json.nonce = output.covenant.items[2];
          json.value = output.value;
          break;

        case 'REDEEM':
          break;
      }

      if (json.action != 'NONE') {
        json.nameHash = output.covenant.items[0];
        if (!json.name) {
          const ns = await this.chain.db.getNameState(Buffer.from(json.nameHash, 'hex'));
          if (ns) json.name = ns.name.toString('binary');
        }
      }
      outputs.push(json);
    }

    tx.inputs = inputs;
    tx.outputs = outputs;

    return tx;
  }

  async getName(name) {
    const height = this.chain.height;
    const nameHash = rules.hashName(name);
    const reserved = rules.isReserved(nameHash, height + 1, this.network);
    const [start, week] = rules.getRollout(nameHash, this.network);
    const ns = await this.chain.db.getNameState(nameHash);

    let info = null;

    if (ns) {
      if (!ns.isExpired(height, this.network))
        info = ns.getJSON(height, this.network.type);
    }

    const bidData = await this.hdb.getNameBids(nameHash, info ? info.owner : null);

    const data = {
      name: name,
      reserved: reserved,
      hash: nameHash.toString('hex'),
      release: start,
      bids: bidData,
      state: info ? info.state : 'INACTIVE',
      height: start,
      value: info ? info.value : 0,
      renewal: info ? info.renewal : 0,
      renewals: info ? info.renewals : 0,
      weak: info ? info.weak : false,
      transfer: info ? info.transfer : 0,
      highest: info ? info.highest : 0,
      revoked: info ? info.revoked : 0,
      blocksUntil: info ? Object.values(info.stats)[2] : null
    };

    switch (data.state) {
      case 'OPENING':
        data.nextState = 'BIDDING';
        break;
      case 'BIDDING':
        data.nextState = 'REVEAL';
        break;
      case 'REVEAL':
        data.nextState = 'CLOSED';
        break;
      case 'CLOSED':
        data.nextState = 'RENEWAL';
      default:
        data.nextState = 'OPENING';
    }

    return data;
  }

  async getPeers(offset = 0, limit = 10) {
    let peers = [];

    for (let peer = this.node.pool.peers.head(); peer; peer = peer.next) {
      const offset = this.network.time.known.get(peer.hostname()) || 0;
      const hashes = [];

      for (const hash in peer.blockMap.keys())
        hashes.push(hash.toString('hex'));

      peer.getName();

      peers.push({
        id: peer.id,
        addr: peer.hostname(),
        name: peer.name || undefined,
        services: hex32(peer.services),
        relaytxes: !peer.noRelay,
        lastSend: (peer.lastSend / 1000) | 0,
        lastRecv: (peer.lastRecv / 1000) | 0,
        bytesSent: peer.socket.bytesWritten,
        bytesRecv: peer.socket.bytesRead,
        connTime: peer.time !== 0 ? ((Date.now() - peer.time) / 1000) | 0 : 0,
        timeOffset: offset,
        pingTime: peer.lastPong !== -1 ? (peer.lastPong - peer.lastPing) / 1000 : -1,
        minPing: peer.minPing !== -1 ? peer.minPing / 1000 : -1,
        version: peer.version,
        agent: peer.agent,
        inbound: !peer.outbound,
        startingHeight: peer.height,
        bestHash: peer.bestHash.toString('hex'),
        bestHeight: peer.bestHeight,
        banScore: peer.banScore,
        inflight: hashes,
        whitelisted: false
      });
    }

    //@todo optimize both of these by doing them before pushing all the data above.
    let total = peers.length;

    peers = peers.slice(offset, offset + limit);

    return [peers, total];
  }

  async getPeersLocation() {
    let peers = [];

    for (let peer = this.node.pool.peers.head(); peer; peer = peer.next) {
      let ip = peer.address.host;
      peers.push(geoip.lookup(ip));
    }

    return peers;
  }

  async getNameHistory(name, offset = 0, limit = 25) {
    const nameHash = rules.hashName(name);
    let entireList = await this.hdb.nameHistory(nameHash);
    entireList.sort((a, b) => (a.height < b.height ? 1 : -1));

    let total = entireList.length;

    let list = entireList.slice(offset, offset + limit);

    let history = [];
    for (let i = 0; i < list.length; i++) {
      let meta = await this.node.getMeta(Buffer.from(list[i].tx_hash, 'hex'));
      let tx = meta.tx;
      let j = 0;
      for (let o of meta.tx.outputs) {
        let newTx = {};
        let cov = o.covenant;

        if (cov.isName()) {
          if (cov.get(0).toString('hex') === nameHash.toString('hex')) {
            if (cov.isOpen()) newTx.action = 'Opened';

            if (cov.isBid()) {
              newTx.action = 'Bid';
              newTx.value = o.value;
            }

            if (cov.isReveal()) {
              newTx.action = 'Reveal';
              newTx.value = o.value;
            }

            if (cov.isRegister()) newTx.action = 'Register';

            if (cov.isRedeem()) {
              newTx.action = 'Redeem';
              newTx.value = o.value;
            }

            if (cov.isUpdate()) newTx.action = 'Update';
            if (cov.isRenew()) newTx.action = 'Renew';

            newTx.time = meta.mtime;
            newTx.height = list[i].height;
            newTx.txid = list[i].tx_hash;
            newTx.index = j;
            history.push(newTx);
          }
        }
        j++;
      }
    }
    return [history, total];
  }

  async getPoolCount(startTime, endTime) {
    const data = await this.hdb.getPoolData(startTime, endTime);
    let total = 0;
    const items = [];
    for (let poolName in data) {
      total += data[poolName];
      items.push({
        poolName,
        url: pools[poolName] ? pools[poolName].url : '',
        count: data[poolName]
      });
    }
    items.sort((a, b) => { return b.count - a.count });

    return { total, items };
  }

  async getNameList() {
    try {
      const height = this.chain.height;
      const txn = this.chain.db.txn;
      const items = [];
      const states = {};

      const iter = txn.iterator();

      while (await iter.next()) {
        const { key, value } = iter;
        const ns = NameState.decode(value);
        ns.nameHash = key;

        const info = ns.getJSON(height, this.network);
        if (info.state == 'INACTIVE') continue;

        items.push({
          name: info.name,
          state: info.state,
          height: info.height,
          highest: info.highest,
          value: info.value
        });
      }

      items.sort((a, b) => {
        if (b.height !== a.height) return b.height - a.height;
        if (a.name === b.name) return 0;

        return a.name > b.name ? 1 : -1;
      });

      this.nameList = Array.from(items);

      const statusItems = Array.from(items);
      for (const item of statusItems) {
        if (!states[item.state]) states[item.state] = [];

        states[item.state].push(item);
      }
      this.statusNames = states;

      items.sort((a, b) => b.value - a.value);
      this.highValueNames = Array.from(items).slice(0, 50);

      this.logger.info('Finished sort names.');

    } catch (error) {
      console.error(error);
    } finally {
      setTimeout(() => {
        this.getNameList();
      }, 20 * 60 * 1000);
    }
  }

  async getRecentHighestNames() {
    try {
      const now = new Date().getTime() / 1000;
      const start = now - 30 * 24 * 60 * 60;
      const weekStart = now - 7 * 24 * 60 * 60;

      const names = new Map();
      const weekNames = new Map();

      for (let i = this.chain.height; i >= -1; i--) {
        const data = await this.chain.getBlock(i);

        const info = {};
        for (const tx of data.txs) {
          for (const output of tx.outputs) {
            if (output.covenant.type != 3) continue;

            const name = output.covenant.items[2].toString('binary');
            const value = output.value;

            if (!info[name] || info[name] < value) info[name] = value;
          }
        }

        const block = { time: data.time, info: info };

        if (block.time < start) break;

        for (const name in block.info) {
          if (!name) continue;

          const setValue = names.get(name);
          if (!setValue || setValue < block.info[name]) {
            names.set(name, block.info[name]);
          }

          if (block.time < weekStart) continue;

          const weekValue = weekNames.get(name);
          if (!weekValue || weekValue < block.info[name]) {
            weekNames.set(name, block.info[name]);
          }
        }
      }

      const namesArr = Array.from(names);
      namesArr.sort((a, b) => { return b[1] - a[1] });
      this.bidNames.month = namesArr;

      const weekNamesArr = Array.from(weekNames);
      weekNamesArr.sort((a, b) => { return b[1] - a[1] });
      this.bidNames.week = weekNamesArr;

      this.logger.info('Finished sort high bid names.');
    } catch (error) {
      console.error(error);
    } finally {
      setTimeout(() => {
        this.getRecentHighestNames();
      }, 20 * 60 * 1000);
    }
  }
}

class HnscanOptions {
  /**
   * Create hnscan options.
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    this.network = Network.primary;
    this.logger = Logger.global;
    this.client = null;
    this.prefix = null;
    this.location = null;
    this.memory = true;
    this.maxFiles = 64;
    this.cacheSize = 16 << 20;
    this.compression = true;

    if (options) this._fromOptions(options);
  }

  /**
   * Inject properties from object.
   * @private
   * @param {Object} options
   * @returns {HnscanOptions}
   */

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

    if (options.chain != null) {
      assert(typeof options.chain === 'object');
      this.chain = options.chain;
    }

    if (options.hdb != null) {
      assert(typeof options.hdb === 'object');
      this.hdb = options.hdb;
    }

    if (options.node != null) {
      assert(typeof options.node === 'object');
      this.node = options.node;
    }

    assert(this.client);

    return this;
  }

  /**
   * Instantiate chain options from object.
   * @param {Object} options
   * @returns {HnscanOptions}
   */

  static fromOptions(options) {
    return new this()._fromOptions(options);
  }
}

/*
 * Helpers
 */

function hex32(num) {
  assert(num >= 0);

  num = num.toString(16);

  assert(num.length <= 8);

  while (num.length < 8) num = '0' + num;

  return num;
}

module.exports = Hnscan;
