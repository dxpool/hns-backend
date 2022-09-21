'use strict';

const EventEmitter = require('events');
const { Network } = require('hsd');

const ChainClient = require('./chainClient');
const HnscanDB = require('./hnscandb');
const Indexer = require('./indexer');
const HTTP = require('./http');
const Hnscan = require('./hnscan');
const Db = require('./db');

/**
 * @exports hnscan/plugin
 */

const plugin = exports;

/**
 * Plugin
 * @extends EventEmitter
 */
class Plugin extends EventEmitter {
  constructor(node) {
    super();

    this.config = node.config.filter('hnscan');
    this.config.open('hnscan.conf');

    this.network = Network.get(node.network.type);
    this.logger = node.logger;
    this.prefix = node.config.prefix;

    this.client = new ChainClient(node.chain);

    this.httpEnabled = this.config.bool('http-enabled', true);

    this.db = new Db({
      name: node.config.str('mongo-name'),
      host: node.config.str('mongo-host'),
      port: node.config.uint('mongo-port'),
      user: node.config.str('mongo-user'),
      password: node.config.str('mongo-password')
    });

    //Init DB here
    this.hdb = new HnscanDB({
      network: this.network,
      logger: this.logger,
      client: this.client,
      memory: this.config.bool('memory', node.memory),
      prefix: this.prefix,
      maxFiles: this.config.uint('max-files'),
      cacheSize: this.config.mb('cache-size')
    });

    this.hnscan = new Hnscan({
      network: this.network,
      logger: this.logger,
      hdb: this.hdb,
      chain: node.chain,
      client: this.client,
      node: node,
      db: this.db
    });

    this.indexer = new Indexer({
      network: this.network,
      logger: this.logger,
      client: this.client,
      chain: node.chain,
      hdb: this.hdb,
      hnscan: this.hnscan,
      db: this.db
    });

    this.http = new HTTP({
      network: this.network,
      logger: this.logger,
      hdb: this.hdb,
      client: this.client,
      node: node,
      hnscan: this.hnscan,
      ssl: this.config.bool('ssl'),
      keyFile: this.config.path('ssl-key'),
      certFile: this.config.path('ssl-cert'),
      host: this.config.str('http-host'),
      port: this.config.uint('http-port'),
      apiKey: this.config.str('api-key', node.config.str('api-key')),
      noAuth: this.config.bool('no-auth'),
      cors: this.config.bool('cors', true)
    });

    this.init();
  }

  init() {
    this.hdb.on('error', err => this.emit('error', err));
    this.indexer.on('error', err => this.emit('error', err));
    this.http.on('error', err => this.emit('error', err));
  }

  //Going to open the http server here and the database
  async open() {
    await this.db.open();
    await this.hdb.open();
    await this.indexer.open();
    await this.http.open();
  }

  //Close the db and the http server.
  async close() {
    await this.hdb.close();
    await this.indexer.close();
  }
}

/**
 * Plugin name.
 * @const {String}
 */

plugin.id = 'hnscan';

/**
 * Plugin initialization.
 * @param {Node} node
 * @returns {Hnscan}
 */

plugin.init = function init(node) {
  return new Plugin(node);
};
