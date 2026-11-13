# dev/ — for testing only (not needed on a machine running the real chain · safe to delete)

server.js and the real chain don't import any file in this folder · if you delete the whole folder, the chain still works, but some tests in `test/` and the npm commands below will stop working

| File | Purpose | npm |
|---|---|---|
| demo.js · demo-chain.js · demo-market.js · examples.js | Examples of using the VM / chain | `demo` `demo:chain` `demo:market` `examples` |
| seed.js | Puts sample data on the chain during development | `seed` |
| scenario.js · scenario-programs.js · scenario-full.js · scenario-full-programs.js | Sends many kinds of simulated txs (many wallets · nested programs) | `scenario` `scenario:full` |
| simulate-users.js | Simulates 200 user wallets | `simulate` |
| load-test.js | Measures whether blocks close in time | `load:test` |
| bench-gas.js · bench-vm.js | Measures real time per gas unit (used when setting the gas table) | `bench:gas` |
| fuzz-sandbox.js | Generates random program code to test the sandbox | `fuzz` |
| evm-proxy.mjs | Intercepts the JSON-RPC requests Blockscout sends | – |

These scripts use test keys (Hardhat) and the repo's `genesis.json` · never point them at the real chain with real keys
