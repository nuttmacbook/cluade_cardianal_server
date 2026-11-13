# explorerscan — the chain's explorer page

Plain HTML / CSS / JS files, **no build step and no dependencies** · copy this folder and restyle it as your own chain's explorer

```
explorerscan/
├── index.html            🎨 Page layout: site name, logo, top menu, sidebar, file load order
├── config.js             🎨 Settings: node address, Reown Project ID, sidebar dot colors, status poll interval, system program list
├── theme/                🎨 Styling
│   ├── colors.css            Every theme color (variables --bg --card --accent …) — to change the theme, edit this file first
│   └── style.css             Background, top bar, sidebar, tables, cards, forms, mobile (@media)
├── ui/                   🎨 Rendering (HTML for each page)
│   ├── components.js         Pieces used on every page: panel, table, address / tx links, tags, JSON box, pager, tabs
│   ├── sidebar.js            Sidebar: highlights the current page + latest programs
│   ├── pages/                One full page per URL
│   │   ├── home.js               #               Overview + latest blocks
│   │   ├── programs.js           #programs       Approved / pending programs
│   │   ├── block.js              #block/<number>
│   │   ├── tx.js                 #tx/<hash>      Includes the program call diagram
│   │   ├── address.js            #address/<addr> Main info + tab selection
│   │   ├── deploy.js             #deploy         Submit a new program
│   │   ├── gas.js                #gas            Chain gas fees (from /genesis) + admin sets the minimum (setGasConfig)
│   │   └── system.js             #system         System programs (Multicall, WBWSC, Factory …) from config.js
│   └── tabs/                 Tabs on the address / program page
│       ├── interact.js           Call functions (form / JSON) + results
│       ├── storage.js            Data the program stores
│       ├── permit.js             Token Permit (ERC-2612)
│       ├── upgrade.js            Upgrade the program / upgrade rights
│       └── metadata.js           Edit the name / icon / links of your own address
└── core/                 ⚙️ System — every project needs it, no need to edit
    ├── chain.js              Reads chain data: api() + pagination (page number / cursor)
    ├── wallet.js             Connects a wallet (MetaMask in the browser, or Reown / WalletConnect), Add network, signs EIP-712 txs, sends to /sendtx
    ├── actions.js            Sign + send + wait for the block result, then report the status
    ├── interact.js           Reads program code to guess each function's input fields
    ├── format.js             Value formatting: BigInt numbers, coin units, time, HTML escaping
    ├── router.js             Switches pages by #hash + search box
    └── start.js              Startup + periodic chain status polling (loaded last)
```

🎨 = edit freely · ⚙️ = system (a mistake = wrong data or invalid signatures) · the first line of every file says which part it belongs to

## What to edit for each change

| To change | File |
|---|---|
| Color theme (background, cards, buttons, links) | `theme/colors.css` |
| Background / grid / sizes / spacing / mobile | `theme/style.css` |
| Site name, logo, top buttons, sidebar | `index.html` |
| Connect to your own chain's node | `config.js` → `api: "https://chain.example.com"` |
| Connect mobile wallets / other wallets via Reown (WalletConnect) | `config.js` → `reownProjectId: "<Project ID from cloud.reown.com>"` · empty = browser wallet only |
| Columns / text on the block, tx, address … pages | `ui/pages/<page>.js` |
| Table look, address links, status tags on every page at once | `ui/components.js` |
| Date / number format | `core/format.js` (`when` `ago` `num`) |
| Add a new page | New file in `ui/pages/` + add a `<script>` in `index.html` + add a line in `render()` in `core/router.js` |

## How to use it

**With this repo's server** (default): `npm run dev` (for production, `npm start` needs `ADMINS` + `PRODUCER_KEY`), then open `http://localhost:3000/` · edit a file and refresh to see the change, no restart needed

**Forking to customize** — two ways
1. Copy the folder elsewhere, then start the server with `EXPLORER_DIR=/path/to/my-explorer npm run dev`
2. Host it separately as a static site (nginx, GitHub Pages, Netlify, etc.): set `api` in `config.js` to the node address · the server already answers CORS

## System rules (don't break these)

- All files are plain `<script>`s sharing globals (not modules) · **the order in `index.html` matters**: `config.js` → `core/` → `ui/` → `core/router.js` → `core/start.js`
- HTML buttons call functions with `onclick="functionName(...)"` · renaming a function means changing every caller
- `canonical()` / `signingInput()` in `core/wallet.js` must match the VM byte for byte (guarded by test `46-explorer-canonical`)
- Class names in `ui/` are tied to `theme/style.css` · renaming a class means editing both sides
- Web page tests: `npm run test:e2e` (`test/e2e/explorer.e2e.js`) · files served by the server: `test/104-explorerscan-static.test.js`
