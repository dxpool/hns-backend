'use strict';

const { Server } = require('bweb');
const Validator = require('bval');
const { base58 } = require('bstring');
const random = require('bcrypto/lib/random');
const sha256 = require('bcrypto/lib/sha256');
const assert = require('bsert');

const Network = require('hsd').protocol.Network;
const { Address } = require('hsd');
const rules = require('hsd/lib/covenants/rules');
const pkg = require('hsd').pkg;

const util = require('./util');
const Cache = require('./utils/cache');

/**
 * HTTP
 * @alias module:hnscan.HTTP
 */

class HTTP extends Server {
  /**
   * Create an http server.
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    super(new HTTPOptions(options));

    this.network = this.options.network;
    this.logger = this.options.logger.context('hnscan-http');
    this.client = this.options.client;
    this.host = this.options.host;
    this.port = this.options.port;
    this.ssl = this.options.ssl;
    this.node = this.options.node;
    this.chain = this.node.chain;
    this.fees = this.node.fees;
    this.mempool = this.node.mempool;
    this.hnscan = this.options.hnscan;

    this.cache = new Cache(60);

    this.init();
  }

  /**
   * Initialize http server.
   * @private
   */

  init() {
    this.on('request', (req, res) => {
      if (req.method === 'POST' && req.pathname === '/') return;

      this.logger.debug('%s %s (%s).', req.method, req.pathname, req.socket.remoteAddress);
    });

    this.on('listening', address => {
      this.logger.info('Hnscan HTTP server listening on %s (port=%d).', address.address, address.port);
    });

    this.initRouter();
  }

  /**
   * Initialize routes.
   * @private
   */

  initRouter() {
    if (this.options.cors) this.use(this.cors());

    if (!this.options.noAuth) {
      this.use(
        this.basicAuth({
          hash: sha256.digest,
          password: this.options.apiKey,
          realm: 'hnscan'
        })
      );
    }

    this.use(this.bodyParser({ type: 'json' }));
    this.use(this.jsonRPC());
    this.use(this.router());

    this.error((err, req, res) => {
      const code = err.statusCode || 500;
      res.json(code, {
        error: {
          type: err.type,
          code: err.code,
          message: err.message
        }
      });
    });

    this.get('/summary', async (req, res) => {
      const totalTX = this.mempool ? this.mempool.map.size : 0;
      const size = this.mempool ? this.mempool.getSize() : 0;
      const names = await this.hnscan.getNameCount();

      res.json(200, {
        network: this.network.type,
        chainWork: this.chain.tip.chainwork.toString('hex', 64),
        difficulty: util.toDifficulty(this.chain.tip.bits),
        hashrate: await this.getHashRate(120),
        unconfirmed: totalTX,
        unconfirmedSize: size,
        registeredNames: names
      });
    });

    this.get('/status', async (req, res) => {
      let addr = this.node.pool.hosts.getLocal();

      if (!addr) addr = this.node.pool.hosts.address;

      let sent = 0;
      let recv = 0;

      for (let peer = this.node.pool.peers.head(); peer; peer = peer.next) {
        sent += peer.socket.bytesWritten;
        recv += peer.socket.bytesRead;
      }

      res.json(200, {
        host: addr.host,
        port: addr.port,
        key: addr.getKey('base32'),
        network: this.network.type,
        progress: this.chain.getProgress(),
        version: pkg.version,
        agent: this.node.pool.options.agent,
        connections: this.node.pool.peers.size(),
        height: this.chain.height,
        difficulty: util.toDifficulty(this.chain.tip.bits),
        uptime: this.node.uptime(),
        totalBytesRecv: recv,
        totalBytesSent: sent
      });
    });

    this.get('/mempool', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const limit = valid.uint('limit', 25);
      const offset = valid.uint('offset', 0);

      let history = this.cache.get('mempool');

      if (!history) {
        history = this.mempool.getHistory();
        this.cache.set('mempool', history);
      }

      const result = history.slice(offset, offset + limit);
      const items = [];
      for (const item of result) {
        const tx = await this.hnscan.getTransaction(item.hash());
        items.push(tx);
      }

      res.json(200, {
        total: history.length,
        limit,
        offset,
        items
      });
    });

    this.get('/blocks', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const tip = this.chain.height;
      const limit = valid.uint('limit', 25);
      const offset = valid.uint('offset', 0);
      const start = tip - offset;

      enforce(limit <= 50, 'Too many blocks requested. Max of 50.');
      enforce(start >= 0, 'Offset too large.');
      enforce(!this.chain.options.spv, 'Cannot get block in SPV mode.');

      let end = start - limit;
      if (end < 0) end = -1;

      const blocks = [];
      for (let i = start; i > end; i--) {
        const block = await this.hnscan.getBlock(i, false);
        blocks.push(block);
      }

      res.json(200, {
        total: tip + 1,
        offset,
        limit,
        result: blocks
      });
    });

    this.get('/blocks/:height', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const height = valid.u32('height');

      enforce(height != null, 'height required.');

      const block = await this.hnscan.getBlock(height, false);

      if (!block) {
        res.json(404);
        return;
      }

      res.json(200, block);
    });

    this.get('/txs', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const height = valid.u32('height');
      const address = valid.str('address');
      const offset = valid.u32('offset', 0);
      const limit = valid.u32('limit', 25);

      const data = await this.hnscan.getTxs(height, address, offset, limit);
      res.json(200, data);
    });

    this.get('/txs/:hash', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const hash = valid.bhash('hash');

      enforce(hash != null, 'tx hash required.');

      const tx = await this.hnscan.getTransaction(hash);

      if (!tx) {
        res.json(404);
        return;
      }

      res.json(200, tx);
    });

    this.get('/names', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const limit = valid.uint('limit', 25);
      const offset = valid.uint('offset', 0);
      const type = valid.str('type');
      const status = valid.str('status');

      enforce(limit <= 50, 'Too many names requested. Max of 50.');
      enforce(!this.chain.options.spv, 'Cannot get names in SPV mode.');

      const data = await this.hnscan.getNames(type, status, offset, limit);

      res.json(200, data);
    });

    this.get('/names/:name', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const name = valid.str('name');

      enforce(name != null, 'name required.');

      const nameData = await this.hnscan.getName(name);

      if (!nameData) {
        res.json(404);
        return;
      }

      res.json(200, nameData);
    });

    this.get('/names/:name/history', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const name = valid.str('name');

      enforce(name != null, 'name required.');

      //@todo implement offset and limit here.
      const [history, total] = await this.hnscan.getNameHistory(name, 0, 100);

      if (!history) {
        res.json(404);
        return;
      }

      res.json(200, {
        total,
        offset: 0,
        limit: 25,
        result: history
      });
    });

    this.get('/addresses/:hash', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const hash = valid.str('hash');

      enforce(hash != null, 'address required.');

      const addr = Address.fromString(hash, this.network.type);
      const balance = await this.hnscan.getAddress(addr);

      if (!balance) {
        res.json(404);
        return;
      }

      res.json(200, balance);
    });

    this.get('/peers', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const page = valid.uint('page', 1);
      const limit = valid.uint('limit', 10);
      const offset = (page - 1) * limit;

      const [peers, total] = await this.hnscan.getPeers(offset, limit);

      res.json(200, {
        total,
        result: peers
      });
    });

    this.get('/address/:hash/mempool', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const hash = valid.str('hash');

      //Check if is valid, if not return error - enforce
      let addr = Address.fromString(hash, this.network);
      let txs = this.mempool.getTXByAddress(addr);

      res.json(200, txs);
    });

    this.get('/search', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const query = valid.str('q');

      let results = [];

      if (!isNaN(query)) {

        let height = +query;
        let tip = this.chain.height;

        if (height <= tip && height >= 0) {
          results.push({ type: 'Block', url: `/block/${height}` });
        }
      }
      //@todo switch to hasTX

      if (query.length === 64) {
        if (await this.hnscan.getTransaction(Buffer.from(query, 'hex'))) {
          let result = { type: 'Transaction', url: `/tx/${query}` };
          results.push(result);
        }

        let height = await this.chain.db.getHeight(Buffer.from(query, 'hex'));

        if (height >= 0) {
          let result = { type: 'Block', url: `/block/${height}` };

          results.push(result);
        }
      }

      let address;

      try {
        address = new Address(query);
      } catch (e) {
        //Do nothing.
      }

      if (address) {
        if (address.isValid()) {
          let result = { type: 'Address', url: `/address/${query}` };
          results.push(result);
        }
      }

      let name = query.toLowerCase();
      if (rules.verifyString(name)) {
        let result = { type: 'Name', url: `/name/${name}` };
        results.push(result);
      }

      return res.json(200, results);
    });

    this.get('/charts/:type', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const startTime = valid.u32('startTime');
      const endTime = valid.u32('endTime');
      const type = valid.str('type');

      try {
        const data = await this.hnscan.getSeries(type, startTime, endTime);
        res.json(200, data);
      } catch (error) {
        console.log(error);
        res.json(400, error);
      }
    });

    this.get('/pool/distribution', async (req, res) => {
      const valid = Validator.fromRequest(req);
      let startTime = valid.u32('startTime');
      let endTime = valid.u32('endTime');

      const data = await this.hnscan.getPoolData(startTime, endTime);

      res.json(200, data);
    });
  }

  async getHashRate(lookup, height) {
    let tip = this.chain.tip;

    if (height != null) {
      tip = await this.chain.getEntry(height);
    }

    if (!tip) {
      return 0;
    }

    assert(typeof lookup === 'number');
    assert(lookup >= 0);

    if (lookup === 0) {
      lookup = (tip.height % this.network.pow.targetWindow) + 1;
    }

    if (lookup > tip.height) {
      lookup = tip.height;
    }

    let min = tip.time;
    let max = min;
    let entry = tip;

    for (let i = 0; i < lookup; i++) {
      entry = await this.chain.getPrevious(entry);

      if (!entry) {
        throw new RPCError(errs.DATABASE_ERROR, 'Not found.');
      }

      min = Math.min(entry.time, min);
      max = Math.max(entry.time, max);
    }

    const diff = max - min;

    if (diff === 0) {
      return 0;
    }

    const work = tip.chainwork.sub(entry.chainwork);

    return Number(work.toString()) / diff;
  }
}

class HTTPOptions {
  /**
   * HTTPOptions
   * @alias module:http.HTTPOptions
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    this.network = Network.primary;
    this.logger = null;
    this.node = null;
    this.apiKey = base58.encode(random.randomBytes(20));
    this.apiHash = sha256.digest(Buffer.from(this.apiKey, 'ascii'));
    this.adminToken = random.randomBytes(32);
    this.serviceHash = this.apiHash;
    this.noAuth = false;
    this.cors = false;
    this.walletAuth = false;

    this.prefix = null;
    this.host = '127.0.0.1';
    this.port = 8080;
    this.ssl = false;
    this.keyFile = null;
    this.certFile = null;

    this.fromOptions(options);
  }

  /**
   * Inject properties from object.
   * @private
   * @param {Object} options
   * @returns {HTTPOptions}
   */

  fromOptions(options) {
    assert(options);
    assert(
      options.node && typeof options.node === 'object',
      'HTTP Server requires a node.'
    );

    this.node = options.node;

    if (options.network != null) this.network = Network.get(options.network);

    if (options.logger != null) {
      assert(typeof options.logger === 'object');
      this.logger = options.logger;
    }

    if (options.hnscan != null) {
      assert(typeof options.hnscan === 'object');
      this.hnscan = options.hnscan;
    }

    if (options.client != null) {
      assert(typeof options.client === 'object');
      this.client = options.client;
    }

    if (options.logger != null) {
      assert(typeof options.logger === 'object');
      this.logger = options.logger;
    }

    if (options.apiKey != null) {
      assert(typeof options.apiKey === 'string', 'API key must be a string.');
      assert(options.apiKey.length <= 255, 'API key must be under 255 bytes.');
      this.apiKey = options.apiKey;
      this.apiHash = sha256.digest(Buffer.from(this.apiKey, 'ascii'));
    }

    if (options.noAuth != null) {
      assert(typeof options.noAuth === 'boolean');
      this.noAuth = options.noAuth;
    }

    if (options.cors != null) {
      assert(typeof options.cors === 'boolean');
      this.cors = options.cors;
    }

    if (options.prefix != null) {
      assert(typeof options.prefix === 'string');
      this.prefix = options.prefix;
      this.keyFile = path.join(this.prefix, 'key.pem');
      this.certFile = path.join(this.prefix, 'cert.pem');
    }

    if (options.host != null) {
      assert(typeof options.host === 'string');
      this.host = options.host;
    }

    if (options.port != null) {
      assert(
        (options.port & 0xffff) === options.port,
        'Port must be a number.'
      );
      this.port = options.port;
    }

    if (options.ssl != null) {
      assert(typeof options.ssl === 'boolean');
      this.ssl = options.ssl;
    }

    if (options.keyFile != null) {
      assert(typeof options.keyFile === 'string');
      this.keyFile = options.keyFile;
    }

    if (options.certFile != null) {
      assert(typeof options.certFile === 'string');
      this.certFile = options.certFile;
    }

    // Allow no-auth implicitly
    // if we're listening locally.
    if (!options.apiKey) {
      if (this.host === '127.0.0.1' || this.host === '::1') this.noAuth = true;
    }

    return this;
  }

  /**
   * Instantiate http options from object.
   * @param {Object} options
   * @returns {HTTPOptions}
   */

  static fromOptions(options) {
    return new HTTPOptions().fromOptions(options);
  }
}

/*
 * Helpers
 */

function enforce(value, msg) {
  if (!value) {
    const err = new Error(msg);
    err.statusCode = 400;
    throw err;
  }
}

module.exports = HTTP;
