# Hns Backend

The project is forked from [hnscan-backend](https://github.com/HNScan/hnscan-backend).
This is a plugin of hsd, and it provides API for hns explorer.

## Getting started

1. `npm install`
2. Copy file `hsd.conf.example`, and rename it to `hsd.conf`. The file is the config file of the HSD. In addition to the necessary config listed, you can also add the configuration supported in the HNS document:
    ```
    # Index transactions.
    index-tx: true
    # Index transactions and utxos by address.
    index-address: true
    # Plugin directory. This address is the absolute path of the index file of hns-backend.
    plugins: /home/ubuntu/hns-backend/lib/index.js
    # The hsd datadir.
    prefix: /home/ubuntu/.hsd
    ```

3. Copy file `hnscan.conf.example`, and rename it to `hnscan.conf`. This config file is the hns-backend config and needs to be placed in the node data folder, that is, in the prefix folder configured above.

    ```
    http-host: 0.0.0.0
    http-port: 8080
    no-auth: true
    ```

4. Start: `./node_modules/.bin/hsd --config hsd.conf`


# API

Here is an [API documentation](https://github.com/dxpool/hns-backend/blob/main/docs/api.md) for developers.