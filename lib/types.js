const bio = require('bufio');
const assert = require('bsert');
const consensus = require('hsd/lib/protocol/consensus');

/**
 * Chain State
 */
class ChainState extends bio.Struct {
  /**
   * Create chain state.
   * @alias module:blockchain.ChainState
   * @constructor
   */

  constructor() {
    super();
    this.tip = consensus.ZERO_HASH;
    this.tx = 0;
    this.coin = 0;
    this.value = 0;
    this.burned = 0;
    this.committed = false;
  }

  inject(state) {
    this.tip = state.tip;
    this.tx = state.tx;
    this.coin = state.coin;
    this.value = state.value;
    this.burned = state.burned;
    return this;
  }

  connect(block) {
    this.tx += block.txs.length;
  }

  disconnect(block) {
    this.tx -= block.txs.length;
  }

  add(coin) {
    this.coin += 1;
    this.value += coin.value;
  }

  spend(coin) {
    this.coin -= 1;
    this.value -= coin.value;
  }

  burn(coin) {
    this.coin += 1;
    this.burned += coin.value;
  }

  unburn(coin) {
    this.coin -= 1;
    this.burned -= coin.value;
  }

  commit(hash) {
    assert(Buffer.isBuffer(hash));
    this.tip = hash;
    this.committed = true;
    return this.encode();
  }

  getSize() {
    return 64;
  }

  write(bw) {
    bw.writeHash(this.tip);
    bw.writeU64(this.tx);
    bw.writeU64(this.coin);
    bw.writeU64(this.value);
    bw.writeU64(this.burned);
    return bw;
  }

  read(br) {
    this.tip = br.readHash();
    this.tx = br.readU64();
    this.coin = br.readU64();
    this.value = br.readU64();
    this.burned = br.readU64();
    return this;
  }
}

module.exports.ChainState = ChainState;
