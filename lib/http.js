'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
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

class HTTP {
  /**
   * Create an http server.
   * @constructor
   * @param {Object} options
   */

  constructor(options) {
    this.options = new HTTPOptions(options);

    this.network = this.options.network;
    this.logger = this.options.logger.context('hnscan-http');
    this.host = this.options.host;
    this.port = this.options.port;
    this.node = this.options.node;
    this.chain = this.node.chain;
    this.mempool = this.node.mempool;
    this.hnscan = this.options.hnscan;

    this.cache = new Cache(60);

    this.app = express();
    this.server = null;

    this.init();
  }

  /**
   * Initialize http server.
   * @private
   */

  init() {
    // 请求日志中间件
    this.app.use((req, res, next) => {
      if (req.method === 'POST' && req.path === '/') {
        return next();
      }
      this.logger.debug('%s %s (%s).', req.method, req.path, req.ip || req.socket.remoteAddress);
      next();
    });

    this.initRouter();
  }

  /**
   * Initialize routes.
   * @private
   */

  initRouter() {
    // CORS 中间件
    if (this.options.cors) {
      this.app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
        if (req.method === 'OPTIONS') {
          return res.sendStatus(200);
        }
        next();
      });
    }

    // 基本认证中间件
    if (!this.options.noAuth) {
      this.app.use((req, res, next) => {
        const auth = req.headers.authorization;
        if (!auth || !auth.startsWith('Basic ')) {
          res.set('WWW-Authenticate', 'Basic realm="hnscan"');
          return res.status(401).json({ error: 'Unauthorized' });
        }

        const credentials = Buffer.from(auth.substring(6), 'base64').toString('ascii');
        const [username, password] = credentials.split(':');
        const providedHash = sha256.digest(Buffer.from(password || '', 'ascii'));
        const expectedHash = sha256.digest(Buffer.from(this.options.apiKey, 'ascii'));

        if (!Buffer.from(providedHash).equals(Buffer.from(expectedHash))) {
          res.set('WWW-Authenticate', 'Basic realm="hnscan"');
          return res.status(401).json({ error: 'Unauthorized' });
        }

        next();
      });
    }

    // JSON body parser
    this.app.use(express.json());

    this.app.get('/summary', async (req, res, next) => {
      try {
        const totalTX = this.mempool ? this.mempool.map.size : 0;
        const size = this.mempool ? this.mempool.getSize() : 0;
        const names = await this.hnscan.getNameCount();

        res.status(200).json({
          network: this.network.type,
          chainWork: this.chain.tip.chainwork.toString('hex', 64),
          difficulty: util.toDifficulty(this.chain.tip.bits),
          hashrate: await this.getHashRate(120),
          unconfirmed: totalTX,
          unconfirmedSize: size,
          registeredNames: names
        });
      } catch (err) {
        next(err);
      }
    });

    this.app.get('/status', async (req, res, next) => {
      try {
        let addr = this.node.pool.hosts.getLocal();

        if (!addr) addr = this.node.pool.hosts.address;

        let sent = 0;
        let recv = 0;

        for (let peer = this.node.pool.peers.head(); peer; peer = peer.next) {
          sent += peer.socket.bytesWritten;
          recv += peer.socket.bytesRead;
        }

        res.status(200).json({
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
      } catch (err) {
        next(err);
      }
    });

    this.app.get('/mempool', async (req, res, next) => {
      try {
        const limit = (req.query.limit ?? 25) / 1;
        const offset = (req.query.offset ?? 0) / 1;

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

        res.status(200).json({
          total: history.length,
          limit,
          offset,
          items
        });
      } catch (err) {
        next(err);
      }
    });

    this.app.get('/blocks', async (req, res, next) => {
      try {
        const tip = this.chain.height;
        const limit = Math.min(req.query.limit ?? 25, 50); // 确保不超过50
        const offset = req.query.offset ?? 0;
        const start = tip - offset;

        enforce(limit <= 50, 'Too many blocks requested. Max of 50.');
        enforce(start >= 0, 'Offset too large.');
        enforce(!this.chain.options.spv, 'Cannot get block in SPV mode.');

        let end = start - limit;
        if (end < 0) end = -1;

        const blocks = [];
        // 分批处理，避免一次性加载过多区块到内存
        for (let i = start; i > end; i--) {
          const block = await this.hnscan.getBlock(i, false);
          if (block) {
            blocks.push(block);
          }
          // 如果已经达到限制，提前退出
          if (blocks.length >= limit) break;
        }

        res.status(200).json({
          total: tip + 1,
          offset,
          limit,
          result: blocks
        });
      } catch (err) {
        next(err);
      }
    });

    this.app.get('/blocks/:height', async (req, res, next) => {
      try {
        const height = req.params.height / 1;
        enforce(height != null, 'height required.');

        const block = await this.hnscan.getBlock(height, false);

        if (!block) {
          return res.status(404).json({ error: 'Not found' });
        }

        res.status(200).json(block);
      } catch (err) {
        next(err);
      }
    });

    this.app.get('/txs', async (req, res, next) => {
      try {
        const height = (req.query.height ?? 0) / 1;
        const address = req.query.address ?? '';
        const offset = (req.query.offset ?? 0) / 1;
        const limit = (req.query.limit ?? 25) / 1;

        const data = await this.hnscan.getTxs(height, address, offset, limit);
        res.status(200).json(data);
      } catch (err) {
        next(err);
      }
    });

    this.app.get('/txs/:hash', async (req, res, next) => {
      try {
        const hash = req.params.hash;
        enforce(hash != null, 'tx hash required.');

        const tx = await this.hnscan.getTransaction(Buffer.from(hash, 'hex'));

        if (!tx) {
          return res.status(404).json({ error: 'Not found' });
        }

        res.status(200).json(tx);
      } catch (err) {
        next(err);
      }
    });

    this.app.get('/names', async (req, res, next) => {
      try {
        const limit = (req.query.limit ?? 25) / 1;
        const offset = (req.query.offset ?? 0) / 1;
        const type = req.query.type ?? '';
        const status = req.query.status ?? '';

        enforce(limit <= 50, 'Too many names requested. Max of 50.');
        enforce(!this.chain.options.spv, 'Cannot get names in SPV mode.');

        const data = await this.hnscan.getNames(type, status, offset, limit);

        res.status(200).json(data);
      } catch (err) {
        next(err);
      }
    });

    this.app.get('/names/:name', async (req, res, next) => {
      try {
        const name = req.params.name;

        enforce(name != null, 'name required.');

        const nameData = await this.hnscan.getName(name);

        if (!nameData) {
          return res.status(404).json({ error: 'Not found' });
        }

        res.status(200).json(nameData);
      } catch (err) {
        next(err);
      }
    });

    this.app.get('/names/:name/history', async (req, res, next) => {
      try {
        const name = req.params.name;

        enforce(name != null, 'name required.');

        //@todo implement offset and limit here.
        const [history, total] = await this.hnscan.getNameHistory(name, 0, 100);

        if (!history) {
          return res.status(404).json({ error: 'Not found' });
        }

        res.status(200).json({
          total,
          offset: 0,
          limit: 25,
          result: history
        });
      } catch (err) {
        next(err);
      }
    });

    this.app.get('/addresses/:hash', async (req, res, next) => {
      try {
        const hash = req.params.hash;

        enforce(hash != null, 'address required.');

        const addr = Address.fromString(hash, this.network.type);
        const balance = await this.hnscan.getAddress(addr);

        if (!balance) {
          return res.status(404).json({ error: 'Not found' });
        }

        res.status(200).json(balance);
      } catch (err) {
        next(err);
      }
    });

    this.app.get('/peers', async (req, res, next) => {
      try {
        const page = req.query.page ?? 1;
        const limit = req.query.limit ?? 10;
        const offset = (page - 1) * limit;

        const [peers, total] = await this.hnscan.getPeers(offset, limit);

        res.status(200).json({
          total,
          result: peers
        });
      } catch (err) {
        next(err);
      }
    });

    this.app.get('/address/:hash/mempool', async (req, res, next) => {
      try {
        const hash = req.params.hash;

        //Check if is valid, if not return error - enforce
        let addr = Address.fromString(hash, this.network);
        let txs = this.mempool.getTXByAddress(addr);

        res.status(200).json(txs);
      } catch (err) {
        next(err);
      }
    });

    this.app.get('/search', async (req, res, next) => {
      try {
        const query = req.query.q ?? '';

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

        return res.status(200).json(results);
      } catch (err) {
        next(err);
      }
    });

    this.app.get('/charts/:type', async (req, res, next) => {
      try {
        const startTime = (req.query.startTime ?? 0) / 1;
        const endTime = (req.query.endTime ?? 0) / 1;
        const type = req.params.type ?? '';

        const data = await this.hnscan.getSeries(type, startTime, endTime);
        res.status(200).json(data);
      } catch (error) {
        res.status(400).json(error);
      }
    });

    this.app.get('/pool/distribution', async (req, res, next) => {
      try {
        let startTime = (req.query.startTime ?? 0) / 1;
        let endTime = (req.query.endTime ?? 0) / 1;

        const data = await this.hnscan.getPoolData(startTime, endTime);

        res.status(200).json(data);
      } catch (err) {
        next(err);
      }
    });

    // 错误处理中间件（必须放在所有路由之后）
    this.app.use((err, req, res, next) => {
      const code = err.statusCode || 500;
      res.status(code).json({
        error: {
          type: err.type,
          code: err.code,
          message: err.message
        }
      });
    });
  }

  /**
   * Open the HTTP server.
   * @returns {Promise}
   */
  async open() {
    return new Promise((resolve, reject) => {
      try {
        this.server = http.createServer(this.app);

        this.server.listen(this.port, this.host, () => {
          const address = this.server.address();
          this.logger.info('Hnscan HTTP server listening on %s (port=%d).', address.address, address.port);
          resolve();
        });

        this.server.on('error', (err) => {
          reject(err);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Close the HTTP server.
   * @returns {Promise}
   */
  async close() {
    // 清理缓存
    if (this.cache && typeof this.cache.destroy === 'function') {
      this.cache.destroy();
    }

    return new Promise((resolve, reject) => {
      if (!this.server) {
        return resolve();
      }

      this.server.close((err) => {
        if (err) {
          reject(err);
        } else {
          this.server = null;
          resolve();
        }
      });
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
        const err = new Error('Not found.');
        err.statusCode = 404;
        throw err;
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
