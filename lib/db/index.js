const { MongoClient } = require("mongodb");

class Db {
  constructor(options) {
    this.name = options.name || 'hns';
    this.client = new MongoClient(`mongodb://${options.host || '127.0.0.1'}:${options.port || 27017}`, {
      auth: {
        username: options.user || 'admin',
        password: options.password
      },
      useUnifiedTopology: true,
      socketTimeoutMS: 300000,
      connectTimeoutMS: 300000
    });
  }

  async open() {
    await this.client.connect();
    this.db = this.client.db(this.name);

    this.blockDb = this.db.collection('block');
    await this.blockDb.createIndex({ height: 1 }, { unique: true });
    await this.blockDb.createIndex({ time: 1 });
    await this.blockDb.createIndex({ miner: 1 });

    this.txDb = this.db.collection('tx');
    await this.txDb.createIndex({ txid: 1 }, { unique: true });
    await this.txDb.createIndex({ height: 1 });
    await this.txDb.createIndex({ time: 1 });
    await this.txDb.createIndex({ addresses: 1 }, { sparse: true });

    this.coinDb = this.db.collection('coin');
    await this.coinDb.createIndex({ txid: 1, index: 1 }, { unique: true });
    await this.coinDb.createIndex({ spentTxid: 1, spentIndex: 1 }, { unique: true, sparse: true });
    await this.coinDb.createIndex({ nameHash: 1 });
    await this.coinDb.createIndex({ type: 1 });
    await this.coinDb.createIndex({ address: 1 });
    await this.coinDb.createIndex({ time: 1 });
    await this.coinDb.createIndex({ value: 1 });
    await this.coinDb.createIndex({ spent: 1 });

    this.nameDb = this.db.collection('name');
    await this.nameDb.createIndex({ nameHash: 1 }, { unique: true });
    await this.nameDb.createIndex({ open: -1 });
    await this.nameDb.createIndex({ value: -1 });

    this.summaryDb = this.db.collection('summary');
    await this.summaryDb.createIndex({ time: 1 });

    this.snapshotDb = this.db.collection('snapshot');
    await this.snapshotDb.createIndex({ key: 1 }, { unique: true });
  }
}

module.exports = Db;
