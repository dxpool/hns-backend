'use strict';

const EventEmitter = require('events');
const assert = require('bsert');

const { Network, Address } = require('hsd');
const consensus = require('hsd/lib/protocol/consensus');
const rules = require('hsd/lib/covenants/rules');
const { states } = require('hsd/lib/covenants/namestate');

const util = require('./util');
const pools = require('./configs/pool.json');
const Db = require('./db');

/**
 * Hnscan
 * @alias module:hnscan.hnscanDB
 * @extends EventEmitter
 */
class Hnscan extends EventEmitter {
  /**
   * Create a hnscan.
   * @constructor
   * @param {Object} options
   * @param {Db} options.db
   */
  constructor(options) {
    super();

    this.network = Network.get(options.network);
    this.logger = options.logger.context('hnscan');
    this.client = options.client;
    this.chain = options.chain;
    this.node = options.node;
    this.db = options.db;
    this.nameCount = {
      height: -1
    };

    this.checkNameCount();

    this.highBidNames = {
      month: null,
      week: null
    };
  }

  async init() {
    this.setCache();
    this.cacheInterval = setInterval(() => {
      this.setCache();
    }, 20 * 60 * 1000);
  }

  async setCache() {
    this.highBidNames.month = await this.getHighBidNames('monthBid', 10, 0, true);
    this.highBidNames.week = await this.getHighBidNames('weekBid', 10, 0, true);
  }

  async getTxs(height, address, offset, limit) {
    if (height) return this.getTransactionsByHeight(height, offset, limit);
    if (address) return this.getTransactionsByAddress(address, limit, offset);

    const result = await this.getTransactions(limit);
    return { result };
  }

  async getTransactions(limit = 25) {
    const txs = [];
    // 限制最大搜索高度范围，避免加载过多区块
    const MAX_SEARCH_HEIGHT = 100;
    const startHeight = this.chain.height;
    const endHeight = Math.max(-1, startHeight - MAX_SEARCH_HEIGHT);

    for (let i = startHeight; i > endHeight; i--) {
      const block = await this.chain.getBlock(i);
      if (!block) continue;

      for (const tx of block.txs) {
        const json = await this.getTx(tx.hash().toString('hex'), {
          height: i,
          index: tx.index,
          version: tx.version,
          witnessHash: tx.witnessHash().toString('hex'),
          time: block.time
        });
        if (json) txs.push(json);

        if (txs.length >= limit) break;
      }
    }

    return txs;
  }

  async getTransactionsByHeight(height, offset = 0, limit = 25) {
    const block = await this.chain.getBlock(height);
    let txs = [];

    let list = block.txs.slice(offset, offset + limit);

    for (const tx of list) {
      const json = await this.getTx(tx.hash().toString('hex'));
      txs.push(json);
    }

    return {
      limit,
      offset,
      total: block.txs.length,
      result: txs
    };
  }

  async getTransactionsByAddress(addr, limit = 25, offset = 0) {
    // 限制最大查询数量，避免内存溢出
    const MAX_LIMIT = 25;
    const actualLimit = Math.min(limit, MAX_LIMIT);
    const actualOffset = Math.max(0, offset);
    const height = this.chain.height;

    const address = Address.fromString(addr, this.network).getHash().toString('hex');
    console.log(address);

    // 先获取总数（使用索引优化）
    const count = await this.db.txDb.countDocuments({ addresses: address });

    // 限制查询范围，避免加载过多数据
    const items = this.db.txDb.find({ addresses: address })
      .sort({ height: -1 })
      .skip(actualOffset)
      .limit(actualLimit); // 只查询必要字段，减少内存占用

    const result = [];
    try {
      while (await items.hasNext()) {
        const item = await items.next();
        const data = await this.getTx(item.txid, item);
        result.push(data);
      }
    } finally {
      // 确保游标被关闭
      if (items && typeof items.close === 'function') {
        await items.close();
      }
    }

    return {
      limit: actualLimit,
      offset: actualOffset,
      total: count,
      result: result
    };
  }

  async getNames(type, status, offset, limit) {
    if (!type) return this.getNamesByStatus(status, limit, offset);

    switch (type) {
      case 'monthBid':
      case 'weekBid':
        return this.getHighBidNames(type, limit, offset);

      case 'value':
        return this.getHighValueNames(limit, offset);

      default:
        return {};
    }
  }

  async getNamesByStatus(status, limit = 10, offset = 0) {
    const options = {};

    if (status) {
      const { max, min } = this.getRange(status);
      options.open = { $gt: min, $lte: max };
    }

    const count = await this.getNameCount(status);
    const items = this.db.nameDb.aggregate()
      .match(options)
      .sort({ open: -1 })
      .skip(offset).limit(limit);

    const result = [];
    try {
      while (await items.hasNext()) {
        const item = await items.next();
        const ns = await this.chain.db.getNameState(Buffer.from(item.nameHash, 'hex'));
        const info = await ns.getJSON(this.chain.height, this.network);

        result.push({
          name: item.name,
          nameHash: item.nameHash,
          height: item.open,
          state: info.state,
          value: info.value,
          highest: info.highest
        });
      }
    } finally {
      // 确保游标被关闭
      if (items && typeof items.close === 'function') {
        await items.close();
      }
    }

    return {
      limit,
      offset,
      total: count,
      result: result
    };
  }

  async getHighBidNames(type, limit = 10, offset = 0, force = false) {
    try {
      if (!force && this.highBidNames.month && this.highBidNames.week) {
        switch (type) {
          case 'monthBid':
            return this.highBidNames.month;
          case 'weekBid':
            return this.highBidNames.week;
          default:
            return {};
        }
      }

      let span = 7 * 24 * 60 * 60;
      switch (type) {
        case 'monthBid':
          span = 30 * 24 * 60 * 60;
          break;
        case 'weekBid':
          span = 7 * 24 * 60 * 60;
      }

      const time = Math.floor(Date.now() / 1000) - span;
      const items = this.db.coinDb.aggregate()
        .match({
          time: { $gte: time },
          type: rules.types.BID
        })
        .sort({ value: -1 })
        .limit(limit * 10); // 限制聚合结果数量，避免加载过多数据

      const result = [];
      let min = 0;
      try {
        while (await items.hasNext()) {
          const item = await items.next();
          if (item.value < min) continue;

          const data = result.find((e) => e.nameHash == item.nameHash);
          if (data && data.value < item.value) {
            data.value = item.value;
            continue;
          }

          const ns = await this.chain.db.getNameState(Buffer.from(item.nameHash, 'hex'));
          const info = await ns.getJSON(this.chain.height, this.network);

          result.push({
            name: info.name,
            nameHash: item.nameHash,
            highest: item.value
          });

          result.sort((a, b) => b.value - a.value);

          if (result.length > limit) result.splice(limit);
          if (result.length > 0) {
            min = result[result.length - 1].value;
          }
        }
      } finally {
        // 确保游标被关闭
        if (items && typeof items.close === 'function') {
          await items.close();
        }
      }

      return {
        limit: limit,
        offset: offset,
        total: result.length,
        result: result
      };
    } catch (error) {
      this.logger.error(error);
      return {
        limit: limit,
        offset: offset,
        total: 0,
        result: []
      };
    }

  }

  async getHighValueNames(limit = 10, offset = 0) {
    const items = this.db.nameDb
      .find().sort({ value: -1 }).skip(offset).limit(limit);

    const result = [];
    try {
      while (await items.hasNext()) {
        const item = await items.next();
        const ns = await this.chain.db.getNameState(Buffer.from(item.nameHash, 'hex'));
        const info = await ns.getJSON(this.chain.height, this.network);

        result.push({
          name: item.name,
          nameHash: item.nameHash,
          value: item.value,
          highest: info.highest,
          state: info.state
        });
      }
    } finally {
      // 确保游标被关闭
      if (items && typeof items.close === 'function') {
        await items.close();
      }
    }

    return {
      limit,
      offset,
      total: result.length,
      result: result
    };
  }

  getRange(status) {
    const height = this.chain.height;
    const treeInterval = this.network.names.treeInterval + 1;
    const openPeriod = treeInterval;
    const biddingPeriod = this.network.names.biddingPeriod;
    const revealPeriod = this.network.names.revealPeriod;

    switch (states[status.toUpperCase()]) {
      case states.OPENING:
        return {
          min: height - openPeriod,
          max: height
        };

      case states.BIDDING:
        return {
          min: height - openPeriod - biddingPeriod,
          max: height - openPeriod
        };

      case states.REVEAL:
        return {
          min: height - openPeriod - biddingPeriod - revealPeriod,
          max: height - openPeriod - biddingPeriod
        };

      case states.CLOSED:
        return {
          min: 0,
          max: height - openPeriod - biddingPeriod - revealPeriod
        };

      default:
        return { max: 0, min: 0 };
    }
  }

  async getAddress(addr) {
    const address = addr.getHash().toString('hex');

    // 使用更高效的聚合查询，限制内存使用
    // 使用 allowDiskUse 选项，允许MongoDB使用磁盘进行大型聚合
    const items = await this.db.coinDb.aggregate([
      { $match: { address: address } },
      {
        $group: {
          _id: '$address',
          received: { $sum: '$value' },
          sent: {
            $sum: {
              $cond: {
                if: { $eq: ['$spent', true] },
                then: '$value',
                else: 0
              }
            }
          }
        }
      },
      { $limit: 1 }
    ], { allowDiskUse: true }).toArray();

    const item = items && items[0] ? items[0] : { received: 0, sent: 0 };
    return {
      hash: addr.toString(this.network.type),
      received: item.received,
      spent: item.sent,
      confirmed: item.received - item.sent,
      unconfirmed: 0
    };
  }

  async getBlock(height) {
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

  async getTx(txid, data) {
    if (!data) {
      data = await this.db.txDb.findOne({ txid });
      if (!data) return { hash: txid };
    }

    const inputCoins = await this.db.coinDb.find({ spentTxid: txid }).toArray();
    const outputCoins = await this.db.coinDb.find({ txid: txid }).toArray();

    let fee = 0;
    const inputs = [];
    const outputs = [];

    for (const input of inputCoins) {
      fee += input.value;
      inputs.push({
        value: input.value,
        address: Address.fromHash(Buffer.from(input.address, 'hex')).toString(this.network)
      });
    }

    for (const output of outputCoins) {
      fee -= output.value;
      let name = undefined;
      const action = rules.typesByVal[output.type];
      if (action != 'NONE' && output.covenant && output.covenant.length > 0) {
        const nameData = await this.db.nameDb.findOne({ nameHash: output.covenant[0] });
        if (nameData) name = nameData.name;
      }

      outputs.push({
        action: rules.typesByVal[output.type],
        name: name,
        address: Address.fromHash(Buffer.from(output.address, 'hex')).toString(this.network),
        value: output.value
      });
    }

    return {
      hash: txid,
      witnessHash: data.witnessHash,
      fee: fee,
      rate: 0,
      mtime: data.time,
      height: data.height,
      block: data.hash,
      time: data.time,
      index: data.index,
      version: data.version,
      inputs: inputs,
      outputs: outputs,
      locktime: 0,
      confirmations: this.chain.height - data.height + 1
    };
  }

  async getName(name) {
    const height = this.chain.height;
    const nameHash = rules.hashName(name);
    const reserved = rules.isReserved(nameHash, height + 1, this.network);
    const [start, week] = rules.getRollout(nameHash, this.network);
    const ns = await this.chain.db.getNameState(nameHash);

    let info = null;

    if (ns) {
      if (!ns.isExpired(height, this.network)) info = ns.getJSON(height, this.network.type);
    }

    const bidData = await this.getNameBids(nameHash.toString('hex'), start);

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

  async getNameBids(nameHash, open) {
    const items = this.db.coinDb.aggregate().match({ nameHash: nameHash });

    const bids = [];
    const winner = { txid: '', index: -1, value: -1 };

    try {
      while (await items.hasNext()) {
        const item = await items.next();
        if (item.type != rules.types.BID) continue;

        const data = {
          txid: item.txid,
          index: item.index,
          lockup: parseInt(item.value),
          reveal: {},
          revealed: false,
          time: item.time,
          value: 0,
          win: false
        };

        if (item.spent && item.spentTxid) {
          const reveal = await this.db.coinDb.findOne({
            txid: item.spentTxid,
            index: item.spentIndex
          });

          if (reveal) {
            data.revealed = true;
            data.reveal.txid = reveal.txid;
            data.reveal.index = reveal.index;
            data.value = reveal.value;

            if (item.height > open && reveal.value > winner.value) {
              winner.txid = reveal.txid;
              winner.index = reveal.index;
              winner.value = reveal.value;
            }
          }
        }

        bids.push(data);
      }
    } finally {
      // 确保游标被关闭
      if (items && typeof items.close === 'function') {
        await items.close();
      }
    }

    if (winner.value >= 0) {
      for (const bid of bids) {
        if (bid.txid !== winner.txid || bid.index !== winner.index) continue;
        bid.win = true;
      }
    }

    return bids;
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

  async getNameHistory(name, offset = 0, limit = 25) {
    const nameHash = rules.hashName(name);

    const total = await this.db.coinDb.countDocuments({ nameHash: nameHash.toString('hex') });
    const items = this.db.coinDb
      .find({ nameHash: nameHash.toString('hex') })
      .sort({ time: -1 }).skip(offset).limit(limit);

    const result = [];
    try {
      while (await items.hasNext()) {
        const item = await items.next();

        const data = {
          action: '',
          time: item.time,
          height: item.height,
          txid: item.txid,
          index: item.index
        };

        const status = rules.typesByVal[item.type].toLocaleLowerCase();
        switch (item.type) {
          case rules.types.OPEN:
            data.action = 'Opened';
            break;

          case rules.types.BID:
          case rules.types.REVEAL:
            data.action = status.replace(/^\S/, (s) => s.toUpperCase());
            data.value = item.value;
            break;

          default:
            data.action = status.replace(/^\S/, (s) => s.toUpperCase());
            break;
        }

        result.push(data);
      }
    } finally {
      // 确保游标被关闭
      if (items && typeof items.close === 'function') {
        await items.close();
      }
    }

    return [result, total];
  }

  async getPoolData(start, end) {
    const items = this.db.blockDb.aggregate()
      .match({ time: { $gt: start, $lte: end } })
      .group({
        _id: '$miner',
        count: { $sum: 1 }
      });

    const result = [];
    let total = 0;
    try {
      while (await items.hasNext()) {
        const item = await items.next();
        total += item.count;

        result.push({
          poolName: item._id,
          count: item.count,
          url: pools[item._id] ? pools[item._id].url : ''
        });
      }
    } finally {
      // 确保游标被关闭
      if (items && typeof items.close === 'function') {
        await items.close();
      }
    }

    return {
      total: total,
      items: result
    };
  }

  async getNameCount(status) {
    if (!status) return this.db.nameDb.estimatedDocumentCount();


    const height = this.chain.height;
    status = status.toUpperCase();
    if (height == this.nameCount.height && this.nameCount[status]) return this.nameCount[status];

    const { max, min } = this.getRange(status);
    return this.db.nameDb.countDocuments({ open: { $gt: min, $lte: max } });
  }

  async checkNameCount() {
    try {
      if (this.nameCount.height == this.chain.height) return;

      this.nameCount.height = this.chain.height;
      const items = ['OPENING', 'BIDDING', 'REVEAL', 'CLOSED'];
      for (const item of items) {
        const { max, min } = this.getRange(item);
        this.nameCount[item] = await this.db.nameDb.countDocuments({ open: { $gt: min, $lte: max } });
      }
    } catch (error) {
      this.logger.error(error);
    } finally {
      this.nameCountTimer = setTimeout(() => {
        this.checkNameCount();
      }, 8 * 60 * 1000);
    }
  }

  /**
   * Clean up resources
   */
  async close() {
    if (this.cacheInterval) {
      clearInterval(this.cacheInterval);
      this.cacheInterval = null;
    }
    if (this.nameCountTimer) {
      clearTimeout(this.nameCountTimer);
      this.nameCountTimer = null;
    }
  }

  async getSeries(type, start, end) {
    const items = this.db.summaryDb.aggregate().match({
      time: { $gte: start, $lte: end }
    });

    const result = [];

    try {
      switch (type) {
        case 'difficulty':
          while (await items.hasNext()) {
            const item = await items.next();
            result.push({
              date: item.time * 1000,
              value: parseFloat((item.difficulty / item.blocks).toFixed(8))
            });
          }
          break;

        case 'dailyTransactions':
          while (await items.hasNext()) {
            const item = await items.next();
            result.push({
              date: item.time * 1000,
              value: item.txs
            });
          }
          break;

        case 'dailyTotalTransactions':
          while (await items.hasNext()) {
            const item = await items.next();
            result.push({
              date: item.time * 1000,
              value: item.totalTxs
            });
          }
          break;

        case 'supply':
          while (await items.hasNext()) {
            const item = await items.next();
            result.push({
              date: item.time * 1000,
              value: item.supply.toFixed(2)
            });
          }
          break;

        case 'burned':
          while (await items.hasNext()) {
            const item = await items.next();
            result.push({
              date: item.time * 1000,
              value: item.burned.toFixed(2)
            });
          }
          break;
      }
    } finally {
      // 确保游标被关闭
      if (items && typeof items.close === 'function') {
        await items.close();
      }
    }

    return result;
  }
}

function hex32(num) {
  assert(num >= 0);
  num = num.toString(16);
  assert(num.length <= 8);

  while (num.length < 8) num = '0' + num;

  return num;
}

module.exports = Hnscan;
