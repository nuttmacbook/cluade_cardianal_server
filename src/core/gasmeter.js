/**
 * แก๊สแบบนับขั้น: ฉีดตัวนับเข้าโค้ดของโปรแกรมก่อนคอมไพล์ (โค้ดที่เก็บใน DB / explorer เห็นยังเป็นของเดิม)
 *
 *   const code = instrument(body);   // body = โค้ดภายใน function program() { ... }
 *
 * โค้ดถูกแบ่งเป็น "ช่วง" ที่รันต่อเนื่องกันโดยไม่วนและไม่แตกทาง:
 *   ต้นโปรแกรม · ต้นฟังก์ชัน · ต้นทุกรอบของลูป · แต่ละทางของ if / switch · try / catch / finally
 * ต้นแต่ละช่วงถูกแทรก __gas(n) โดย n = จำนวน node ของ AST ในช่วงนั้น
 *   → แก๊สขึ้นกับโค้ดอย่างเดียว ได้ค่าเท่ากันทุกเครื่อง และลูปไม่รู้จบหมดแก๊สเอง
 *   ทางย่อยในนิพจน์ (a && b, c ? x : y) นับรวมในช่วงที่อยู่ จึงคิดเต็มทุกทางเสมอ
 *   เงื่อนไข / update ของลูปนับเพิ่มในทุกรอบ
 *
 * เมธอดในตัวที่ทำงานกับข้อมูลทั้งก้อนในคำสั่งเดียว (join, split, slice, JSON.stringify …)
 * และการเรียกแบบ obj[name](…) ถูกเปลี่ยนเป็น __call(obj, "method", [args])
 * เพื่อให้ VM คิดแก๊สตามขนาดข้อมูลเข้า / ออก
 *
 * บรรทัดของโค้ดไม่เปลี่ยน (ข้อความ error ยังชี้บรรทัดเดิม) แต่คอลัมน์เลื่อน
 */
import { parse } from "acorn";

export const GAS_FN = "__gas";
export const CALL_FN = "__call";

/** เมธอดที่คิดแก๊สตามขนาดข้อมูล */
export const SIZED_METHODS = new Set([
  "repeat", "padStart", "padEnd", "join", "split", "concat", "slice", "splice", "substring", "substr",
  "indexOf", "lastIndexOf", "includes", "fill", "sort", "reverse", "flat", "replace", "replaceAll",
  "trim", "trimStart", "trimEnd", "toUpperCase", "toLowerCase", "startsWith", "endsWith",
  "stringify", "parse", "keys", "values", "entries", "fromEntries", "from", "assign", "toString",
  "map", "filter", "forEach", "reduce", "reduceRight", "find", "findIndex", "findLast", "findLastIndex",
  "some", "every", "flatMap", "toSorted", "toReversed", "toSpliced",
]);

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const LOOP_TYPES = new Set(["ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement"]);
const SKIP_KEYS = new Set(["start", "end", "loc", "range"]);

// ลำดับของข้อความที่แทรกตรงตำแหน่งเดียวกัน: ตัวนับก่อน แล้วตัวครอบช่วง แล้วการเรียก
const PRIORITY = { gas: 3, region: 2, call: 1 };

function children(node) {
  const list = [];
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) { for (const item of value) if (item && typeof item.type === "string") list.push(item); }
    else if (value && typeof value.type === "string") list.push(value);
  }
  return list;
}

/** @param {string} body โค้ดภายใน program() @returns {string} โค้ดที่มีตัวนับแก๊ส */
export function instrument(body) {
  const ast = parse(body, { ecmaVersion: "latest", allowReturnOutsideFunction: true });
  const edits = [];          // { at, end?, text, open, span, priority }
  const regionRoots = new Set([ast]);
  const regions = [];        // { nodes: node[], place(n) }

  const open = (at, text, span, priority) => edits.push({ at, end: at, text, open: true, span, priority });
  const close = (at, text, span) => edits.push({ at, end: at, text, open: false, span, priority: 0 });
  const replace = (at, end, text) => edits.push({ at, end, text, open: false, span: -1, priority: 0, replace: true });

  const statementGas = (at) => (n) => open(at, `${GAS_FN}(${n});`, Infinity, PRIORITY.gas);
  const region = (node, extra = []) => {
    regionRoots.add(node);
    for (const part of extra) regionRoots.add(part);
    const nodes = [node, ...extra];
    if (node.type === "BlockStatement") return regions.push({ nodes, place: statementGas(node.start + 1) });
    const span = node.end - node.start;
    if (node.type.endsWith("Statement") || node.type.endsWith("Declaration")) {
      // ทางของ if / ตัวลูปที่ไม่มี { } → ครอบด้วย { }
      return regions.push({ nodes, place: (n) => { open(node.start, `{${GAS_FN}(${n});`, span, PRIORITY.region); close(node.end, "}", span); } });
    }
    // ตัวฟังก์ชันแบบ arrow ที่เป็นนิพจน์: x => expr → x => (__gas(n), expr)
    return regions.push({ nodes, place: (n) => { open(node.start, `(${GAS_FN}(${n}),`, span, PRIORITY.region); close(node.end, ")", span); } });
  };

  const visit = (node) => {
    if (node.type === "Identifier" && (node.name === GAS_FN || node.name === CALL_FN)) {
      throw new SyntaxError(`ชื่อ ${node.name} สงวนไว้สำหรับ VM`);
    }
    if (FUNCTION_TYPES.has(node.type)) region(node.body);
    else if (LOOP_TYPES.has(node.type)) region(node.body, [node.test, node.update].filter(Boolean));
    else if (node.type === "IfStatement") {
      region(node.consequent);
      if (node.alternate) region(node.alternate);
    } else if (node.type === "SwitchCase" && node.consequent.length) {
      for (const statement of node.consequent) regionRoots.add(statement);
      regions.push({ nodes: node.consequent, place: statementGas(node.consequent[0].start) });
    } else if (node.type === "TryStatement") {
      region(node.block);
      if (node.handler) region(node.handler.body);
      if (node.finalizer) region(node.finalizer);
    } else if (node.type === "CallExpression") rewriteCall(node);
    for (const child of children(node)) visit(child);
  };

  // obj.method(a, b) → __call(obj,"method",[a, b])   ·   obj[expr](a) → __call(obj,(expr),[a])
  const rewriteCall = (node) => {
    const callee = node.callee;
    if (callee.type !== "MemberExpression" || node.optional || callee.optional || callee.object.type === "Super") return;
    const { object, property, computed } = callee;
    if (!computed && !(property.type === "Identifier" && SIZED_METHODS.has(property.name))) return;
    const span = node.end - node.start;
    const paren = body.indexOf("(", computed ? body.indexOf("]", property.end) : property.end);
    const keepLines = (from, to) => "\n".repeat((body.slice(from, to).match(/\n/g) ?? []).length);
    open(node.start, `${CALL_FN}(`, span, PRIORITY.call);
    if (computed) {
      replace(object.end, property.start, `,(${keepLines(object.end, property.start)}`);
      replace(property.end, paren + 1, `),[${keepLines(property.end, paren + 1)}`);
    } else {
      replace(object.end, paren + 1, `,"${property.name}",[${keepLines(object.end, paren + 1)}`);
    }
    close(node.end - 1, "]", span);
  };

  regions.push({ nodes: [ast], place: statementGas(0) });
  visit(ast);

  // จำนวน node ของแต่ละช่วง (ไม่นับช่วงลูกที่ซ้อนอยู่)
  const count = (node, root) => {
    let total = 1;
    for (const child of children(node)) if (child === root || !regionRoots.has(child)) total += count(child, root);
    return total;
  };
  for (const r of regions) r.place(r.nodes.reduce((sum, node) => sum + count(node, node), 0));

  return applyEdits(body, edits);
}

function applyEdits(source, edits) {
  const at = new Map();
  for (const edit of edits) {
    if (!at.has(edit.at)) at.set(edit.at, []);
    at.get(edit.at).push(edit);
  }
  let out = "";
  let i = 0;
  while (i <= source.length) {
    const here = at.get(i) ?? [];
    // ปิดของเดิมก่อน (ช่วงเล็กก่อน) → แทนที่ → เปิดของใหม่ (ช่วงใหญ่ก่อน / ตัวนับก่อน)
    for (const edit of here.filter((e) => !e.open && !e.replace).sort((a, b) => a.span - b.span)) out += edit.text;
    const replacement = here.find((e) => e.replace);
    const opens = here.filter((e) => e.open).sort((a, b) => b.span - a.span || b.priority - a.priority);
    if (replacement) {
      for (const edit of opens) out += edit.text;
      out += replacement.text;
      i = replacement.end;
      // ตำแหน่งปลายของการแทนที่อาจมีข้อความที่ต้องแทรกต่อ
      if (replacement.end !== replacement.at) continue;
    }
    if (!replacement) for (const edit of opens) out += edit.text;
    if (i < source.length) out += source[i];
    i += 1;
  }
  return out;
}
