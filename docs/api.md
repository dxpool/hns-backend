# REST API

-----

## GET Endpoints

-----

### `/summary` - Get overview information of HNS.
**Returns**

* network - Type of network.
* chainwork - Proof of chain work.
* difficulty - Difficulty of network.
* hashrate - Network hashrate calculated by difficulty.
* unconfirmed - Number of unconfirmed transactions.
* unconfirmedSize - Size of unconfirmed transactions.
* registeredNames - Number of registered names.

### `/status` - Get the information of the hsd node.
**Returns**

* host - Host of this node.
* port - Port of this node.
* key - Address key of this node.
* network - Type of network.
* progress - Progress of the chain.
* version - Pkg version.
* agent - Agent of this node.
* connections - Number of peers connected.
* height - Height of the chain.
* difficulty - Difficulty of the chain.
* uptime - Uptime of this node.
* totalBytesRecv - Total bytes received.
* totalBytesSent - Total bytes Sent.

### `/mempool` - Get transactions in mempool.
**Query**

* limit - [optional] Max size of transactions returns.
* offset - [optional] Paging offset.

**Returns**

* total - Number of transactions in mempool.
* limit - Max size of transactions returns.
* offset - Paging offset.
* items - Array of transactions.

### `/blocks` - Get blocks of chain.
**Query**

* limit - [optional] Max size of blocks returns.
* offset - [optional] Paging offset.

**Returns**

* total - Number of total blocks.
* limit - Max size of blocks returns.
* offset - Paging offset.
* result - Array of blocks.

### `/blocks/:height` - Get block data by height.
**Params**

* height - Height of the block.

**Returns**

* hash - Block hash.
* height - Block height.
* confirmations - confirmations of block.
* difficulty - Block difficulty.
* prevBlock - Previous block hash.
* nextHash - next block hash.
* strippedSize - Stripped size.
* size - Block size.
* weight - Block weight.
* version - Block version.
* merkleRoot - Block merkleRoot.
* treeRoot - Block treeRoot.
* mask - Block mask.
* reservedRoot - Block reserved root.
* coinbase - coinbase info.
* tx - Transactions in block.
* txs - Number of transactions in block.
* reward - Reward of coinbase.
* fees - Total fees of transactions in block.
* miner - mining address of block.
* pool - mining pool of block.
* averageFee - Average fee of transactions in block.
* time - time of block.
* medianTime - median time of block.
* bits - Block bits.
* chainwork - Proof of chain work.
* nonce - Block nonce.

### `/txs` - Get transactions by query item.
**Query**

* height - [optional] Transactions in the block of this height.
* address - [optional] Transactions related of this address. Ignored when height existed.
* offset - [optional] Page offset.
* limit - [optional] Page size.

**Returns**

* result - Array of transactions.
* total - Total count of transactions.
* limit - Page limit.
* offset - Page offset.

### `/txs/:hash` - Get the transaction by txid.
**Params**

* hash - Transaction id.

**Returns**

* block - Block hash.
* confirmations - Block confirmations.
* fee - Fee in the transaction.
* hash - Transaction id.
* height - Block height.
* hex - Whole transaction hex.
* index - Index of transaction in block.
* locktime - Locked before the time.
* mtime - transaction created time.
* rate - Transaction rate.
* time - Block created time.
* version - Transaction version.
* witnessHash - Witness hash.
* inputs - Array of inputs.
* outputs - Array of outputs.

### `/names` - getting names by type.
**Query**

* type - [optional] Rank list type. Available value: value, monthBid, weekBid.
* status - [optional] Name status, ignored when type existed. Available value: opening, bidding, reveal, closed, locked.
* limit - [optional] Page limit.
* offset - [optional] Page offset.

**Returns**

* total - Total count of names.
* result - Array of names.
* limit - Page limit.
* offset - Page offset.

### `/names/:name` - getting name info.
**Params**

* name

**Returns**

* bids - Array of bids about this name.
* blockUntil - Number of block for name next state.
* hash - Name hash.
* height - Height of block available.
* highest - Highest bid value of this name.
* name
* nextState - Next state of name.
* release - Name release.
* renewal - Height of name renewal available.
* renewals - Name renewal times.
* reserved - Whether the name is reserved.
* revoked - Whether the name is revoked.
* state - Name state.
* transfer - Name transfer time.
* value - Actual value for bidding winner.
* weak - Whether the name is weak.

### `/names/:name/history` - Get the transaction history associated with the name.
**Returns**

* result - Array of name history.
* total - Total count of name history.
* limit - Page limit.
* offset - Page offset.

### `/addresses/:hash` - Get balance of the address.
**Params**

* hash

**Returns**

* confirmed - Balance confirmed.
* hash - Address.
* received - Total received.
* spent - Total spent.
* unconfirmed - Balance unconfirmed.

### `/peers` - Get information about connected nodes.
**Query**

* limit - [optional] Page limit.
* offset - [optional] Page offset.

**Returns**

* total - Total count of peers.
* result - Array of peers.

### `/mapdata` - Get mapdata.
**Returns**

* Array of map data.

### `/address/:hash/mempool` - Get transactions of the address in mempool.
**Params**

* hash - Address.

**Returns**

* Array of transactions in mempool related to address.

### `/search` - Search for block, transaction, address or name.
**Query**

* q - Query string.

**Returns**

* Array of query result.

### `/charts/:type` - Get data used to draw the chart.
**Params**

* type - Chart type. Available value: difficulty, dailyTransaction, supply, burned.

**Query**

* startTime - Start time of data.
* endTime - End time of data.

**Returns**

* Array of chart data.

### `/pool/distribution` - Get block mining proportion of each mining pool.
**Query**

* startTime - Start time of data.
* endTime - End time of data.

**Returns**

* Array of distribution data.