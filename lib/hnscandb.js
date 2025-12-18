'use strict';

const EventEmitter = require('events');
const path = require('path');

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
    options.location = path.join(options.prefix, 'hnscan');
    this.mongodb = options.db;
  }

  /**
   * Open the hnscandb, wait for the database to load.
   * @returns {Promise}
   */
  async open() { }

  /**
   * Close the hnscandb, wait for the database to close.
   * @returns {Promise}
   */
  async close() {
    return this.db.close();
  }
}

module.exports = HnscanDB;
