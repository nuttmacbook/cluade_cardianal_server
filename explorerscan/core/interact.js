/* explorerscan/core/interact.js [ระบบ · ไม่ต้องแก้]
   อ่านโค้ดโปรแกรมเพื่อเดาช่องกรอก: ชื่อฟังก์ชันที่เรียกได้ (callableOf) และชนิดของ input แต่ละตัว (inferInputs)
   ใช้โดยแท็บ Interact (ui/tabs/interact.js) · ไม่มี HTML */

/** callable function names, read from the final return { … } of the code */
function callableOf(code) {
  const match = /return\s*\{([^}]*)\}\s*;?\s*\}\s*$/.exec(code.replace(/\\n/g, "\n"));
  return match ? match[1].split(",").map((n) => n.trim()).filter(Boolean) : [];
}

// ---------- interact: input as fields guessed from the function's code, or raw JSON ----------
//   inferInputs() reads the chosen function's body for params.input.<name> (also aliases, destructuring and one hop
//   into local helpers it passes the value to) and guesses each field's type from how it is used:
//   list (for…of / .length / .map) · object (.sub) · address (name or transferNative / runProgram target) ·
//   number (math or compare with 1n, name like amount) · yes/no (if (x), === true) · text (everything else)
const ADDRESS_NAME = /^(to|from|who|owner|spender|account|recipient|receiver|target|token|program|wallet|user|address)$|address$|^(to|from)[A-Z_]/i;
const NUMBER_NAME = /^(amount|value|count|price|qty|quantity|total|fee|id|index|depth|decimals|supply|limit|max|min|nonce|deadline|n|num)$|(amount|count|price|supply|fee|total)$/i;
const BOOL_NAME = /^(is|has|can|should|allow|enable|use)[A-Z_]/;
const LIST_USE = /^\s*\??\.(length|map|forEach|filter|reduce|some|every|find|slice|join|includes|indexOf|at)\b/;
const NUM_OP = String.raw`(?:===|!==|==|!=|<=|>=|<|>|\+|-|\*|\/|%)`;

/** body of a function in the program code: function name(p) { … } or const name = (p) => { … } → { param, body } */
function functionSource(code, name) {
  const head = new RegExp(String.raw`(?:function\s+${name}\s*\(([^)]*)\)|(?:const|let|var)\s+${name}\s*=\s*(?:function\s*)?\(([^)]*)\)\s*(?:=>)?)\s*\{`).exec(code);
  if (!head) return null;
  let depth = 0, quote = "";
  for (let i = head.index + head[0].length - 1; i < code.length; i += 1) {
    const c = code[i];
    if (quote) { if (c === "\\") i += 1; else if (c === quote) quote = ""; continue; }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth += 1;
    else if (c === "}" && --depth === 0) return { params: (head[1] ?? head[2] ?? "").trim(), body: code.slice(head.index + head[0].length, i) };
  }
  return null;
}

/** every place `expr` (a regex source) is used in body → [{ before, after }] (skips object keys and .props of something else) */
function usesOf(body, expr) {
  const out = [];
  for (const m of body.matchAll(new RegExp(expr, "g"))) {
    const before = body.slice(Math.max(0, m.index - 48), m.index), after = body.slice(m.index + m[0].length, m.index + m[0].length + 48);
    if (/\.\s*$/.test(before) || /^\s*:(?!:)/.test(after) && /[{,]\s*$/.test(before)) continue;
    out.push({ before, after, match: m[0] });
  }
  return out;
}

/** type evidence from how a value is used: { list, object, address, number, boolean, text, subkeys, item } */
function evidence(body, expr, code, seen = new Set()) {
  const e = { subkeys: new Set(), item: null };
  for (const { before, after } of usesOf(body, expr)) {
    if (LIST_USE.test(after) || /\bof\s*$/.test(before) || /^\s*(\|\||\?\?)\s*\[/.test(after)) e.list = true;
    else if (/^\s*\??\.\s*([A-Za-z_$][\w$]*)/.test(after)) { e.object = true; e.subkeys.add(/^\s*\??\.\s*([A-Za-z_$][\w$]*)/.exec(after)[1]); }
    if (/(transferNative|runProgram|isAddress|getBalance|balanceOfNative)\s*\(\s*$/.test(before)) e.address = true;
    if (new RegExp(String.raw`^\s*${NUM_OP}\s*-?\d+n\b`).test(after) || new RegExp(String.raw`-?\d+n\s*${NUM_OP}\s*$`).test(before)
      || /^\s*(\|\||\?\?)\s*-?\d+n\b/.test(after) || /BigInt\(\s*$/.test(before) || /transferNative\s*\([^,()]+,\s*$/.test(before)) e.number = true;
    if (/^\s*[!=]==?\s*(true|false)\b/.test(after) || /^\s*(\|\||\?\?)\s*(true|false)\b/.test(after)) e.boolean = true;
    // truthiness only (if (x) / !x / x ? a : b) hints yes/no, unless the value is also used for something else
    if (/(\bif\s*\(\s*!?|!|&&|\|\|)\s*$/.test(before) && /^\s*(\)|&&|\|\||\?(?![?.]))/.test(after) && !/^\s*(\|\||\?\?)/.test(after)
      || /^\s*\?(?![?.])/.test(after)) e.cond = true;
    else if (!/^\s*\??\./.test(after)) e.used = true;
    if (/^\s*(\|\||\?\?)\s*["'`]/.test(after) || /^\s*[!=]==?\s*["'`]/.test(after)) e.text = true;
    // list items: for (const item of <expr>) { … item.to … }
    if (/\bof\s*$/.test(before)) {
      const loop = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s*$/.exec(before);
      if (loop) e.item = guessShape(body, String.raw`\b${loop[1]}\b`, loop[1], code, seen);
    }
  }
  // one hop into local helpers: move(params.context.sender, params.input.to, params.input.amount) → move(from, to, amount)
  for (const call of body.matchAll(new RegExp(String.raw`\b([A-Za-z_$][\w$]*)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)`, "g"))) {
    const args = call[2].split(",").map((x) => x.trim());
    const at = args.findIndex((x) => new RegExp(`^(?:${expr})$`).test(x));
    if (at < 0 || seen.has(call[1])) continue;
    const helper = functionSource(code, call[1]);
    const param = helper?.params.split(",")[at]?.trim();
    if (!param || !/^[A-Za-z_$][\w$]*$/.test(param)) continue;
    const inner = evidence(helper.body, String.raw`\b${param}\b`, code, new Set([...seen, call[1]]));
    for (const k of ["list", "object", "address", "number", "boolean", "text", "used"]) e[k] ||= inner[k];
    inner.subkeys.forEach((k) => e.subkeys.add(k));
    e.item ||= inner.item;
  }
  if (e.cond && !e.used) e.boolean = true;
  return e;
}

/** a value's shape → { name, type, item?, keys? } · type: list | object | address | number | boolean | text */
function guessShape(body, expr, name, code, seen = new Set()) {
  const e = evidence(body, expr, code, seen);
  const type = e.list ? "list" : e.object ? "object" : e.address || (!e.number && !e.boolean && ADDRESS_NAME.test(name)) ? "address"
    : e.number || (!e.text && !e.boolean && NUMBER_NAME.test(name)) ? "number"
    : e.boolean || (!e.text && BOOL_NAME.test(name)) ? "boolean" : "text";
  const shape = { name, type };
  if (type === "list") shape.item = e.item;
  if (type === "object") shape.keys = [...e.subkeys].map((k) => guessShape(body, String.raw`${expr}\s*\??\.\s*${k}\b`, k, code, seen));
  return shape;
}

/** fields a function reads from params.input, in the order they first appear */
function inferInputs(rawCode, fn) {
  const raw = String(rawCode ?? "");
  let code;   // stored code is one line with JSON escapes (\n, \") → back to normal source
  try { code = JSON.parse(`"${raw}"`); } catch { code = raw.replace(/\\n/g, "\n"); }
  const src = functionSource(code, fn);
  if (!src) return [];
  const { params, body } = src;
  const bases = [];          // expressions that mean params.input
  const locals = [];         // [field, local name] from const { to, amount: amt } = params.input
  if (/^[A-Za-z_$][\w$]*$/.test(params)) bases.push(String.raw`\b${params}\s*\??\.\s*input`);
  const destructured = /^\{([^}]*)\}$/.exec(params);
  if (destructured) {
    const part = destructured[1].split(",").map((x) => x.trim()).find((x) => /^input\b/.test(x));
    const local = part && (/^input\s*:\s*([A-Za-z_$][\w$]*)/.exec(part)?.[1] ?? "input");
    if (local) bases.push(String.raw`\b${local}`);
  }
  if (!bases.length) return [];
  for (let round = 0; round < 2; round += 1) {
    for (const base of [...bases]) {
      for (const m of body.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*${base}\b(?!\s*\??\.)`, "g"))) {
        const alias = String.raw`\b${m[1]}`;
        if (!bases.includes(alias)) bases.push(alias);
      }
      for (const m of body.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*${base}\b(?!\s*\??\.)`, "g"))) {
        for (const part of m[1].split(",").map((x) => x.trim()).filter(Boolean)) {
          const [key, rest] = part.split(":").map((x) => x.trim());
          const field = key.replace(/\s*=.*$/, ""), local = (rest ?? key).replace(/\s*=.*$/, "");
          if (/^[A-Za-z_$][\w$]*$/.test(field) && /^[A-Za-z_$][\w$]*$/.test(local)) locals.push([field, local]);
        }
      }
    }
  }
  const order = new Map();
  for (const base of bases) {
    for (const m of body.matchAll(new RegExp(String.raw`${base}\s*\??\.\s*([A-Za-z_$][\w$]*)`, "g"))) if (!order.has(m[1])) order.set(m[1], m.index);
  }
  for (const [field, local] of locals) if (!order.has(field)) order.set(field, body.search(new RegExp(String.raw`\b${local}\b`)));
  return [...order.entries()].sort((x, y) => x[1] - y[1]).map(([field]) => {
    const exprs = bases.map((base) => String.raw`${base}\s*\??\.\s*${field}\b`);
    const local = locals.find(([f]) => f === field)?.[1];
    if (local) exprs.push(String.raw`\b${local}\b`);
    return guessShape(body, exprs.map((x) => `(?:${x})`).join("|"), field, code);
  });
}

/** example JSON for list / object fields (shown as the placeholder) */
function sampleOf(shape) {
  if (!shape) return "";
  if (shape.type === "list") return [shape.item ? sampleOf(shape.item) : "…"];
  if (shape.type === "object") return Object.fromEntries((shape.keys ?? []).map((k) => [k.name, sampleOf(k)]));
  return { address: "0x…", number: 1, boolean: true }[shape.type] ?? "…";
}

/** integers in typed JSON → "123n" (the VM takes whole numbers as bigint strings, never JS numbers) */
const bigints = (v) => (typeof v === "number" && Number.isInteger(v) ? `${v}n`
  : Array.isArray(v) ? v.map(bigints) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, bigints(x)])) : v);
