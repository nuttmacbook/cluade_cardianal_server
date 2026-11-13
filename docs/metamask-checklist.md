# Trying MetaMask against the real chain (phase 3.1 checklist)

I have already run the steps that can be automated with ethers via `/evm` (test `94-evm-send-raw` and a smoke test on a real process at chainId 7777: native transfer ✓ · token reads ✓ · ERC-20 transfer ✓)
The rest needs real MetaMask, because the wallet's screens, gas selection, and speed up / cancel buttons behave differently from ethers
Fill in the "Result" column (✓ / ✗ + notes) and send it back; I will fix anything marked ✗

## 0. Prepare the chain

The repo's `genesis.json` sets chainId 41234 (Bluewolfchain · no collision with other chains) + the `bluewolf` fork, so it works as is

```bash
DATA=./data-metamask npm run dev      # DATA unset = kept in memory (lost on exit)
node dev/seed.js http://localhost:3000                          # in another window: creates token MTK (namespace mytoken) + sample txs
```

- funded test account: private key `0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d` (address `0x7099…79c8` = Hardhat account #1, a public key, **never use with real funds**)
- token address: `curl -s localhost:3000/name/mytoken`
- if MetaMask was connected to this chain before and the chain was wiped: MetaMask → Settings → Advanced → **Clear activity tab data** (otherwise the old nonce sticks)

## 1. Connect the network

| # | Do | Expect | Result |
|---|---|---|---|
| 1.1 | MetaMask → Networks → Add network manually: RPC URL `http://localhost:3000/evm` · Chain ID `41234` · Symbol `BWSC` · Block explorer `http://localhost:3000/evm/explorer` | saves without a chainId mismatch warning | |
| 1.2 | Import account with the test private key above | BWSC balance about 10,000,000 (slightly less after the seed's gas) | |
| 1.3 | Switch to another network and back | same balance · no red errors | |

## 2. Native transfer

| # | Do | Expect | Result |
|---|---|---|---|
| 2.1 | Send → `0xfabb0ac9d68b0b445fb7357272ff202c5651694a` 1 BWSC (leave gas as MetaMask picks it) | the confirm screen shows a gas fee (no "unable to estimate") | |
| 2.2 | Confirm | Activity shows Pending, then Confirmed within seconds (1 block) | |
| 2.3 | Click "View on block explorer" in Activity | opens this chain's explorer tx page with matching from / to / amount | |
| 2.4 | Try a Legacy transfer (Settings → Advanced → enable "Customize transaction nonce" / pick legacy gas if available) | also works | |

## 3. Token (ERC-20)

| # | Do | Expect | Result |
|---|---|---|---|
| 3.1 | Import tokens → enter the MTK address | MetaMask fills in symbol `MTK` and decimals `6` by itself | |
| 3.2 | The account's MTK balance | matches the token page in the explorer | |
| 3.3 | Send 1.5 MTK → the address from 2.1 | confirms · Confirmed · both balances change, matching the explorer | |

## 4. Replace / cancel a tx

Make a tx hang first: run the chain with `BLOCK_MS=20000` (a block every 20 seconds), then send 1 tx

| # | Do | Expect | Result |
|---|---|---|---|
| 4.1 | Send 0.1 BWSC, then click **Speed up** while Pending | the new tx is Confirmed · the old one disappears (explorer: the old tx page shows "replaced" pointing to the new one) | |
| 4.2 | Send another, then click **Cancel** | Cancel Confirmed (a 0 transfer to yourself with the same nonce) · the original never runs | |

## 5. Chain-native signing (EIP-712 in the explorer)

| # | Do | Expect | Result |
|---|---|---|---|
| 5.1 | Open `http://localhost:3000` → Connect wallet | connects, shows the address | |
| 5.2 | MTK token page → function call tab → `transfer` | MetaMask shows a "Signature request" with readable action / to / method / input fields | |
| 5.3 | Sign | the tx lands in a block · MetaMask's Activity does **not** show it (it's a signature, not an EVM tx) — this is expected | |
| 5.4 | Token page → permit tab → sign (the wallet must be on this chain · permit has chainId in its domain) | an EIP-2612 permit window appears · can be submitted | |
| 5.5 | Switch MetaMask to another chain (e.g. Ethereum) and repeat 5.2 | before opening the wallet the explorer shows the BWSC balance + estimated gas + "signing on chain …" · signs without switching chains · the tx page has a "Signed on" row | |

## 6. Dev tools (if convenient)

| # | Do | Expect | Result |
|---|---|---|---|
| 6.1 | Remix → Deploy & run → Injected Provider (MetaMask) → At Address = MTK with the ERC-20 ABI → call `balanceOf` / `transfer` | reads work · transfer can be sent | |
| 6.2 | Deploy a Solidity contract from Remix | **must fail** with the message "cannot deploy bytecode" (the chain's programs are JavaScript) | |

## Known limitations (no need to report again)

- EVM bytecode can't be deployed (6.2) · wallets can only call standard tokens and programs that declare `metadata.abi`
- EIP-712-signed txs (section 5) don't appear in MetaMask's Activity
- `eth_estimateGas` returns chain gas: a native transfer = 21000 as wallets expect, though the chain actually uses less (you pay for what is used, not the limit)
- in `eth_getBlockByNumber` (non-full), txs sent from wallets are still listed by the chain's internal hash, while receipts / getTransactionByHash return the Ethereum hash the wallet holds
