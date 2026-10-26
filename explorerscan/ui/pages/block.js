/* explorerscan/ui/pages/block.js [แก้ได้ · หน้าตา]
   หน้า block (#block/<เลข>): header, ค่าแก๊ส EIP-1559, tx ใน block, tx ที่ถูกปฏิเสธ */

// ---------- block ----------
async function block(number, draw = el) {
  const data = await api(`/block/${number}?full=1`);
  const header = data.header ?? data;
  if (!header?.number) return draw(panel("Block not found", `<div class="empty">${esc(data.error ?? "Block not found")}</div>`));
  const txs = slicePage(data.transactions ?? [], pageOf("txs"));
  draw(panel(`<span class="ico blk"></span>Block #${header.number}`, kv([
      ["Time", `${when(header.timestamp)} <span class="dim">· ${ago(header.timestamp)}</span>${utc(header.timestamp)}`],
      ["Hash", full(header.hash)],
      ["Parent block", header.parentHash ? `<span class="mono full"><a onclick="go('#block/${header.number - 1}')">${esc(header.parentHash)}</a>${copy(header.parentHash)}</span>` : '<span class="dim">First block</span>'],
      ["State root", full(header.stateRoot)],
      ["Fee recipient", addr(header.feeRecipient, header.feeRecipient)],
      header.producer && ["Producer", `${addr(header.producer, header.producer)} <span class="dim">· signed</span>`],
      header.producerSignature && ["Producer signature", full(header.producerSignature)],
      ["Transactions", `${num(header.txCount)} <span class="dim">(${header.successCount} succeeded · ${header.failedCount} failed)</span>`],
      ["Gas used", `${gas(header.gasUsed)}${header.gasTarget ? ` <span class="dim">(target ${gas(header.gasTarget)})</span>` : ""} <span class="dim">· fee ${coin(header.fee)}</span>`],
      header.baseFeePerGas && ["Base fee", `${gwei(header.baseFeePerGas)} gwei <span class="dim">per gas · next block ${baseFeeTrend(header)}</span>`],
      header.burnedFee !== undefined && ["Fee split", feeSplit(header.burnedFee, header.producerFee)],
      (header.rejectedCount ?? data.rejected?.length) && ["Rejected", `${num(header.rejectedCount ?? data.rejected.length)} <span class="dim">(recorded only: never ran, no state change, no fee)</span>`],
    ]))
    + panel(`Transactions (${num(txs.total)})`, table(["#", "Hash", "Type", "From", "To", "Method", "Status", "Gas"], txs.items.map((t) =>
        txRow(t, [t.index, txLink(t.hash), actionTag(t.action), addr(t.from), addr(t.to),
          t.method ? `<span class="mono">${esc(t.method)}</span>` : '<span class="dim">—</span>',
          state(t.status), gas(t.gasUsed)]))) + pager(txs, "setPage('txs',$)"))
    + (data.rejected?.length ? rejectedPanel(data.rejected, pageOf("rej")) : "")
    + `<div class="nav"><a onclick="go('#block/${header.number - 1}')">← Previous block</a>
        <a onclick="go('#block/${header.number + 1}')">Next block →</a></div>`);
}

/** EIP-1559: base fee moves up when a block uses more gas than the target, down when it uses less (at most 1/8 per block) */
function baseFeeTrend(header) {
  const used = Number(header.gasUsed ?? 0), target = Number(header.gasTarget ?? 0);
  if (!target || used === target) return "stays the same";
  return used > target ? '<span class="warn">goes up</span>' : "goes down (not below the minimum)";
}
/** burned (base fee part) and paid to the block producer (tips) */
const feeSplit = (burned, producer) => `<span class="mono">${coin(burned ?? 0)}</span> <span class="dim">burned ·</span>
  <span class="mono">${coin(producer ?? 0)}</span> <span class="dim">to the block producer</span>`;
/** a tx's gas price: what it paid per gas, and how that splits into base fee and tip */
function feeRows(r) {
  if (r.baseFeePerGas === undefined || r.baseFeePerGas === null) return [];
  const paid = toBig(r.effectiveGasPrice ?? r.gasPrice), base = toBig(r.baseFeePerGas);
  return [
    ["Gas price", `${gwei(paid)} gwei <span class="dim">= base fee ${gwei(base)} + tip ${gwei(paid > base ? paid - base : 0n)}</span>`],
    r.type === 2 && ["Fee limits", `<span class="tag">EIP-1559</span> <span class="dim">max fee</span> ${r.maxFeePerGas ? `${gwei(r.maxFeePerGas)} gwei` : "base fee + tip"}
      <span class="dim">· max tip</span> ${gwei(r.maxPriorityFeePerGas ?? 0)} gwei`],
    r.burnedFee !== undefined && ["Fee split", feeSplit(r.burnedFee, r.producerFee)],
    r.sponsor && ["Gas paid by", `${addr(r.sponsor)} <span class="tag">sponsor</span> <span class="dim">· the sender paid no gas</span>`],
  ];
}

/** rejected txs recorded in a block: signature checked, then turned away (they never ran) */
function rejectedPanel(list, page) {
  const rows = slicePage(list, page);
  return `<section class="panel" id="rejected-panel"><h2>${panelTitle(`Rejected (${num(list.length)})`)}</h2><div class="body">${table(["#", "Hash", "Type", "From", "Nonce", "Stage", "Reason"],
    rows.items.map((r, i) => txRow(r, [(rows.page - 1) * rows.limit + i, txLink(r.hash), actionTag(r.action), addr(r.sender), r.nonce ?? "—",
      stageTag(r.stage), `<span class="bad">${esc(r.reason)}</span>`])))}${pager(rows, "setPage('rej',$)")}</div></section>`;
}

/** a rejected tx (GET /tx/:hash → status "rejected") */
const rejectedView = (r, hash) => panel("Transaction", kv([
  ["Status", `${state("rejected")} <span class="bad">${esc(r.reason)}</span>`],
  ["Tx hash", full(hash)],
  ["Stage", `${stageTag(r.stage)}${r.code ? ` <span class="tag bad">${esc(r.code)}</span>` : ""} <span class="dim">never ran: no state change, no nonce used, no fee</span>`],
  ["Type", actionTag(r.action)],
  ["From", addr(r.sender, r.sender)],
  ["To", r.to ? addr(r.to, r.to) : '<span class="dim">—</span>'],
  ["Nonce", r.nonce ?? "—"],
  ["Gas price", r.gasPrice ? `${gwei(r.gasPrice)} gwei` : "—"],
  ["Recorded in block", r.block ? blockNo(r.block) : '<span class="dim">waiting for the next block</span>'],
  r.timestamp && ["Time", when(r.timestamp)],
]));
