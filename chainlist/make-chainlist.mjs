/*
 * สร้างไฟล์สำหรับขอลงรายชื่อเชน (chainlist.org) จาก config.json
 *   node make-chainlist.mjs                  # สร้างไฟล์ใน out/ + ตรวจตามกฎ CI ของ ethereum-lists (ไม่ต่อเน็ต)
 *   node make-chainlist.mjs --live           # + ตรวจของจริงแบบเดียวกับ CI: RPC, explorer, ลิงก์ EIP-3091, โลโก้บน IPFS
 *   node make-chainlist.mjs --registry <โฟลเดอร์ _data/chains ของ ethereum-lists>   # + ตรวจ chainId / ชื่อ / shortName ซ้ำ
 *
 * ได้ไฟล์:
 *   out/ethereum-lists/_data/chains/eip155-<id>.json   PR ไป github.com/ethereum-lists/chains (chainlist.org ดึงจากที่นี่อัตโนมัติ)
 *   out/ethereum-lists/_data/icons/<icon>.json         ไฟล์โลโก้ของ PR เดียวกัน
 *   out/chainlist/chainid-<id>.js                      PR ไป github.com/DefiLlama/chainlist (constants/additionalChainRegistry)
 *   out/PR-ethereum-lists.md · out/PR-chainlist.md     หัวข้อ + ข้อความ PR
 *   out/icon.<png|svg|jpg>                             โลโก้ที่ต้องอัปขึ้น IPFS (CID ต้องตรงกับใน icons/<icon>.json)
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const dir = import.meta.dirname;
const args = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
const problems = [];
const warn = [];

// ---- โลโก้: อ่านขนาดจากไฟล์ + คำนวณ CID เอง (CIDv1 raw · ไฟล์ไม่เกิน 256 KiB = block เดียว → ได้ bafkrei… แบบเดียวกับ ipfs add --cid-version=1 --raw-leaves)
function cidOf(bytes) {
  const digest = crypto.createHash("sha256").update(bytes).digest();
  const raw = Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]);   // CIDv1 · codec raw · sha2-256 · 32 ไบต์
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0, value = 0, out = "";
  for (const byte of raw) {
    value = ((value << 8) | byte) & 0xffff; bits += 8;
    while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return `b${out}`;
}
function imageInfo(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return { bytes, format: "png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let i = 2; i < bytes.length;) {   // หา SOF0..SOF15 (ยกเว้น DHT / JPG / DAC)
      const marker = bytes[i + 1], length = bytes.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return { bytes, format: "jpg", width: bytes.readUInt16BE(i + 7), height: bytes.readUInt16BE(i + 5) };
      i += 2 + length;
    }
  }
  const text = bytes.toString("utf8");
  if (/<svg[\s>]/.test(text)) {
    const tag = text.match(/<svg[^>]*>/)[0];
    const num = (name) => Number(tag.match(new RegExp(`\\s${name}="([\\d.]+)(px)?"`))?.[1]);
    const box = tag.match(/viewBox="[\d.\s-]*?([\d.]+)\s+([\d.]+)"/);
    return { bytes, format: "svg", width: Math.round(num("width") || Number(box?.[1])), height: Math.round(num("height") || Number(box?.[2])) };
  }
  throw new Error(`${file}: รู้จักแค่ png / jpg / svg`);
}

let icon = null;
if (!config.icon?.file) problems.push("ยังไม่ได้ใส่ icon.file (ไฟล์โลโก้)");
else {
  const file = path.resolve(dir, config.icon.file);
  if (!fs.existsSync(file)) problems.push(`ไม่มีไฟล์โลโก้ ${file}`);
  else {
    const info = imageInfo(file);
    // icon.cid: CID ที่บริการ IPFS ให้มา (ถ้าไม่ใช่ CIDv1 raw ที่คำนวณได้) · --live ตรวจว่าดึงจาก CID นั้นได้ไฟล์เดียวกัน
    icon = { url: `ipfs://${config.icon.cid ?? cidOf(info.bytes)}`, width: info.width, height: info.height, format: info.format, bytes: info.bytes };
    if (info.bytes.length > 250 * 1024) problems.push(`โลโก้ใหญ่ ${Math.round(info.bytes.length / 1024)} KB เกิน 250 KB`);
    if (!(info.width > 0 && info.height > 0)) problems.push("อ่านความกว้าง / สูงของโลโก้ไม่ได้ (svg ต้องมี width / height หรือ viewBox)");
    if (info.width !== info.height) warn.push(`โลโก้ไม่เป็นสี่เหลี่ยมจัตุรัส (${info.width}×${info.height}) กระเป๋าส่วนใหญ่ตัดเป็นวงกลม`);
    if (info.format === "svg") warn.push("โลโก้ svg: ตัวตรวจรูปของ ethereum-lists อ่าน svg ไม่ได้ ใช้ png ปลอดภัยกว่า");
  }
}

// ---- ไฟล์ของ ethereum-lists (ลำดับ field ตามไฟล์ที่มีอยู่ใน repo)
const chain = {
  name: config.name,
  chain: config.chain,
  icon: config.icon?.name,
  rpc: config.rpc,
  features: [{ name: "EIP155" }, { name: "EIP1559" }],
  faucets: config.faucets ?? [],
  nativeCurrency: config.nativeCurrency,
  infoURL: config.infoURL,
  shortName: config.shortName,
  chainId: config.chainId,
  networkId: config.chainId,   // server ตอบ net_version = chainId
  explorers: [{ name: config.explorer.name, url: config.explorer.url, icon: config.icon?.name, standard: "EIP3091" }],   // <url>/tx/<hash> ฯลฯ (server: /evm/explorer/…)
};
if (config.status && config.status !== "active") chain.status = config.status;

// ---- กฎเดียวกับ CI ของ ethereum-lists (processor/src/main/kotlin/.../Main.kt)
const nameRegex = /^[a-zA-Z0-9\-.() ]+$/;
if (!Number.isInteger(config.chainId) || config.chainId <= 0) problems.push("chainId ต้องเป็นจำนวนเต็มบวก");
if (!nameRegex.test(config.name)) problems.push("name ใช้ได้แค่ a-z A-Z 0-9 - . ( ) และช่องว่าง");
if (!nameRegex.test(config.nativeCurrency.name)) problems.push("nativeCurrency.name ใช้ตัวอักษรไม่ได้");
if (config.nativeCurrency.symbol.length >= 7) problems.push("nativeCurrency.symbol ต้องสั้นกว่า 7 ตัว");
if (config.nativeCurrency.decimals !== 18) problems.push("decimals ต้องเป็น 18 (native ของเชนเก็บเป็น wei 18 ทศนิยม)");
if (config.shortName === "*" || /\s/.test(config.shortName)) problems.push("shortName ห้ามเป็น * หรือมีช่องว่าง");
if (!["active", "incubating"].includes(config.status ?? "active")) problems.push("status ใช้ active หรือ incubating");
for (const [key, value] of Object.entries({ name: config.name, shortName: config.shortName, chain: config.chain, infoURL: config.infoURL, "explorer.name": config.explorer.name }))
  if (!value?.trim() || value !== value.trim()) problems.push(`${key} ว่างหรือมีช่องว่างหัวท้าย`);
for (const url of config.rpc) {
  if (!/^(https|wss):\/\//.test(url)) problems.push(`rpc ต้องขึ้นต้น https:// หรือ wss:// : ${url}`);
  else if (url.startsWith("https") && !/\/evm$/.test(url)) warn.push(`rpc ของ server นี้อยู่ที่ path /evm : ${url}`);
}
if (!/^https:\/\//.test(config.explorer.url)) problems.push("explorer.url ต้องขึ้นต้น https://");
if (config.explorer.url.endsWith("/")) problems.push("explorer.url ห้ามลงท้ายด้วย /");
if (!/\/evm\/explorer$/.test(config.explorer.url)) warn.push("explorer.url ของ server นี้ควรเป็น https://<โดเมน>/evm/explorer (ลิงก์ EIP-3091 อยู่ใต้ path นี้)");
if ([...config.rpc, config.explorer.url, config.infoURL].some((u) => /example\.(com|org)/.test(u))) problems.push("ยังมีโดเมนตัวอย่าง (example.com) อยู่ใน config");

// ---- ตรวจซ้ำกับรายชื่อที่มีอยู่
const registry = args.includes("--registry") ? args[args.indexOf("--registry") + 1] : null;
if (registry) {
  const files = fs.readdirSync(registry).filter((f) => f.endsWith(".json") && f !== `eip155-${config.chainId}.json`);
  const all = files.map((f) => JSON.parse(fs.readFileSync(path.join(registry, f), "utf8")));
  const norm = (s) => s.replace(/ /g, "").toUpperCase();   // normalizeName() ของ ethereum-lists
  const taken = all.find((c) => c.chainId === config.chainId);
  if (taken) problems.push(`chainId ${config.chainId} มีแล้ว: ${taken.name}`);
  const sameName = all.find((c) => norm(c.name) === norm(config.name));
  if (sameName) problems.push(`name ซ้ำกับ ${sameName.name} (${sameName.chainId})`);
  const sameShort = all.find((c) => norm(c.shortName) === norm(config.shortName));
  if (sameShort) problems.push(`shortName ซ้ำกับ ${sameShort.name} (${sameShort.chainId})`);
  if (fs.existsSync(path.join(registry, `eip155-${config.chainId}.json`))) warn.push(`มี eip155-${config.chainId}.json อยู่ในโฟลเดอร์แล้ว (ของเราเอง?) ข้ามไม่ตรวจไฟล์นั้น`);
  const icons = path.join(registry, "../icons");
  if (config.icon?.name && fs.existsSync(path.join(icons, `${config.icon.name}.json`))) {
    const existing = fs.readFileSync(path.join(icons, `${config.icon.name}.json`), "utf8");
    if (!icon || !existing.includes(icon.url)) problems.push(`ชื่อโลโก้ "${config.icon.name}" มีคนใช้แล้วใน _data/icons เปลี่ยน icon.name`);
  }
  console.log(`ตรวจกับ ${all.length} เชนใน ${registry}`);
}

// ---- ตรวจของจริง (แบบเดียวกับ CI ของ ethereum-lists ที่เปิด explorer และต่อ RPC จริง)
if (args.includes("--live")) {
  const rpcCall = async (url, method, params = []) => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", origin: "https://chainlist.org" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    return { res, body: await res.json() };
  };
  for (const url of config.rpc.filter((u) => u.startsWith("http"))) {
    try {
      const { res, body } = await rpcCall(url, "eth_chainId");
      if (Number(body.result) !== config.chainId) problems.push(`${url} eth_chainId = ${body.result} ไม่ตรงกับ ${config.chainId}`);
      const net = (await rpcCall(url, "net_version")).body.result;
      if (Number(net) !== config.chainId) problems.push(`${url} net_version = ${net} ไม่ตรง`);
      for (const method of ["web3_clientVersion", "eth_blockNumber", "eth_gasPrice"]) {
        const { body: reply } = await rpcCall(url, method);
        if (reply.error || reply.result === undefined) problems.push(`${url} ${method} ตอบผิด: ${JSON.stringify(reply.error ?? reply)}`);
      }
      if (Number((await rpcCall(url, "eth_blockNumber")).body.result) < 1) warn.push(`${url} ยังไม่มี block (ส่ง tx สักใบก่อนส่ง PR)`);
      if (!res.headers.get("access-control-allow-origin")) problems.push(`${url} ไม่มี CORS header → chainlist.org และ dApp บนโดเมนอื่นเรียกไม่ได้`);
      const preflight = await fetch(url, { method: "OPTIONS", headers: { origin: "https://chainlist.org", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
      if (!preflight.ok || !preflight.headers.get("access-control-allow-origin")) problems.push(`${url} ไม่ตอบ OPTIONS preflight (ได้ ${preflight.status})`);
      const params = await fetch(url).then((r) => r.json()).catch(() => null);   // GET /evm = ค่าที่ปุ่ม Add to wallet ของ explorer ใช้
      if (params && (params.nativeCurrency?.symbol !== config.nativeCurrency.symbol || !config.name.startsWith(params.chainName)))
        warn.push(`GET ${url} บอกชื่อ "${params.chainName}" / ${params.nativeCurrency?.symbol} ต่างจาก config ตั้ง EVM_NAME / EVM_SYMBOL บน server ให้ตรง`);
      console.log(`rpc ok: ${url} chainId ${body.result}`);
    } catch (error) { problems.push(`${url} เรียกไม่ได้: ${error.message}`); }
  }
  for (const target of [config.explorer.url, `${config.explorer.url}/block/1`, `${config.explorer.url}/address/0x0000000000000000000000000000000000000000`]) {
    try {
      const res = await fetch(target);
      if (Math.floor(res.status / 100) !== 2) problems.push(`explorer ${target} ตอบ ${res.status}`);
      else console.log(`explorer ok: ${target}`);
    } catch (error) { problems.push(`explorer ${target} เปิดไม่ได้: ${error.message}`); }
  }
  if (icon) {
    const cid = icon.url.replace("ipfs://", "");
    let found = false;
    for (const gateway of [`https://${cid}.ipfs.dweb.link`, `https://ipfs.io/ipfs/${cid}`]) {
      try {
        const res = await fetch(gateway, { signal: AbortSignal.timeout(30_000) });
        if (res.ok && Buffer.from(await res.arrayBuffer()).equals(icon.bytes)) { found = true; break; }
      } catch {}
    }
    if (found) console.log(`โลโก้อยู่บน IPFS แล้ว: ${icon.url}`);
    else problems.push(`ยังหาโลโก้บน IPFS ไม่เจอ (${icon.url}) อัปไฟล์ out/icon.${icon.format} แบบ CIDv1 raw ก่อน (ดู README)`);
  }
}

// ---- เขียนไฟล์ (prettier ของ ethereum-lists: 2 ช่อง)
const out = path.join(dir, "out");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "ethereum-lists/_data/chains"), { recursive: true });
fs.mkdirSync(path.join(out, "ethereum-lists/_data/icons"), { recursive: true });
fs.mkdirSync(path.join(out, "chainlist"), { recursive: true });
fs.writeFileSync(path.join(out, `ethereum-lists/_data/chains/eip155-${config.chainId}.json`), JSON.stringify(chain, null, 2) + "\n");
if (icon) {
  fs.writeFileSync(path.join(out, `ethereum-lists/_data/icons/${config.icon.name}.json`),
    JSON.stringify([{ url: icon.url, width: icon.width, height: icon.height, format: icon.format }], null, 2) + "\n");
  fs.writeFileSync(path.join(out, `icon.${icon.format}`), icon.bytes);
}
const llama = { ...chain, explorers: [{ name: config.explorer.name, url: config.explorer.url, standard: "EIP3091" }] };
delete llama.icon;   // ไฟล์ของ DefiLlama ไม่มีไฟล์ไอคอนคู่กัน · chainlist.org ใช้ไอคอนจาก ethereum-lists
fs.writeFileSync(path.join(out, `chainlist/chainid-${config.chainId}.js`), `export const data = ${JSON.stringify(llama, null, 2)}\n`);

const title = `Add ${config.name} (${config.chainId})`;
const facts = [
  `- Chain ID: ${config.chainId} (networkId ${config.chainId})`,
  `- Native currency: ${config.nativeCurrency.name} (${config.nativeCurrency.symbol}, 18 decimals)`,
  `- RPC: ${config.rpc.join(", ")}`,
  `- Explorer: ${config.explorer.url} (EIP-3091 paths: /tx/<hash>, /address/<address>, /token/<address>, /block/<number or hash>)`,
  `- Website: ${config.infoURL}`,
  `- Features: EIP-155 replay protection, EIP-1559 base fee`,
].join("\n");
fs.writeFileSync(path.join(out, "PR-ethereum-lists.md"), `${title}\n\n${facts}\n\nFiles:\n- _data/chains/eip155-${config.chainId}.json\n- _data/icons/${config.icon?.name}.json (${icon?.url ?? "-"})\n`);
fs.writeFileSync(path.join(out, "PR-chainlist.md"), `${title}\n\n${facts}\n\nFile: constants/additionalChainRegistry/chainid-${config.chainId}.js\n`);

console.log(`เขียนไฟล์แล้วใน ${out}`);
if (icon) console.log(`โลโก้: ${icon.format} ${icon.width}×${icon.height} ${Math.round(icon.bytes.length / 1024)} KB · ${icon.url}`);
for (const w of warn) console.log(`เตือน: ${w}`);
if (problems.length) { console.log(`\nยังส่งไม่ได้ (${problems.length}):`); for (const p of problems) console.log(`- ${p}`); process.exit(1); }
console.log("\nผ่านทุกข้อ พร้อมส่ง PR (./submit-prs.sh)");
