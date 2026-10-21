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
 * แก๊สตามขนาดข้อมูลที่คัดลอก / สร้าง (คิดใน sandbox ดู sandbox.js "แก๊สตามขนาดข้อมูล"):
 *   a + b · a += b                → __str(…)       ผลเป็น string = คิดตามความยาว (string ที่ต่อด้วย operator ไม่ผ่านเมธอดใด ๆ)
 *     (template `…${x}…` ไม่ต้องครอบ: QuickJS สร้างด้วย "".concat(…) ซึ่งห่อไว้ใน sandbox แล้ว — เทสต์ 76 คุมอยู่)
 *   { ...x }                      → { ...__props(x) }   คิดตามจำนวน property ที่ถูกคัดลอก
 *   const { a, ...rest } = x      → … = __props(x)      (และ ({ a, ...rest } = x))
 *   [...a] · f(...a) · new F(...a) → ...__spread(a)  คิดตามจำนวนสมาชิกที่ถูกคัดลอก
 *   const [x, ...rest] = a        → … = __spread(a)     (และ ([x, ...rest] = a))
 *   ...rest ใน pattern ตำแหน่งอื่น (พารามิเตอร์แบบ { ...r } / [ ...r ] · for…of · catch · ซ้อนใน pattern อื่น) → deploy ไม่ผ่าน
 *     เพราะไม่มีนิพจน์ให้ครอบ (ค่าที่ถูกคัดลอกไม่ได้มาจากนิพจน์ในโค้ด) — ใช้ const [ ...rest ] = ค่า ในตัวฟังก์ชันแทน
 *     (function f(...args) ใช้ได้ตามปกติ: argument มาจากการเรียกซึ่งคิดแก๊สแล้ว)
 *   เมธอดในตัว (join, split, slice, JSON.stringify …) ถูกห่อใน sandbox เอง ไม่ต้องแปลงการเรียก
 *     (เรียกผ่าน .call / Reflect.apply / ตัวแปรที่เก็บเมธอดไว้ ก็ถูกคิดเท่ากัน)
 *
 * บรรทัดของโค้ดไม่เปลี่ยน (ข้อความ error ยังชี้บรรทัดเดิม) แต่คอลัมน์เลื่อน
 */
import { parse } from "acorn";

export const GAS_FN = "__gas";
export const STR_FN = "__str";
export const PROPS_FN = "__props";
export const SPREAD_FN = "__spread";
/** ชื่อเดิมของตัวเรียกเมธอดในตัว (ไม่ใช้แล้ว แต่ยังสงวนไว้) */
export const CALL_FN = "__call";
/** ฟังก์ชันของ VM ที่โค้ดที่ฉีดแล้วเรียก (destructure จาก api ใน factory ของโปรแกรม) */
export const METER_FNS = [GAS_FN, STR_FN, PROPS_FN, SPREAD_FN];
const RESERVED = new Set([...METER_FNS, CALL_FN]);

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const LOOP_TYPES = new Set(["ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement"]);
const SKIP_KEYS = new Set(["start", "end", "loc", "range"]);

// ลำดับของข้อความที่แทรกตรงตำแหน่งเดียวกัน (ช่วงยาวเท่ากัน): ตัวนับก่อน แล้วตัวครอบช่วง แล้ว __props / __spread แล้ว __str
const PRIORITY = { gas: 4, region: 3, props: 2, str: 1 };

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

const hasObjectRest = (pattern) => pattern?.type === "ObjectPattern" && pattern.properties.some((p) => p.type === "RestElement");
const hasArrayRest = (pattern) => pattern?.type === "ArrayPattern" && pattern.elements.some((p) => p?.type === "RestElement");
const SPREAD_PARENTS = new Set(["ArrayExpression", "CallExpression", "NewExpression"]);

/** @param {string} body โค้ดภายใน program() @returns {string} โค้ดที่มีตัวนับแก๊ส */
export function instrument(body) {
  const ast = parse(body, { ecmaVersion: "latest", allowReturnOutsideFunction: true });
  const edits = [];          // { at, text, open, span, priority }
  const regionRoots = new Set([ast]);
  const regions = [];        // { nodes: node[], place(n) }
  const allowedRest = new Set();   // pattern ที่มี ...rest และค่าที่ถูกคัดลอกถูกครอบด้วย __props / __spread แล้ว

  const open = (at, text, span, priority) => edits.push({ at, text, open: true, span, priority });
  const close = (at, text, span) => edits.push({ at, text, open: false, span, priority: 0 });

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

  // ครอบนิพจน์ด้วย fn( … ) · ช่วงของ node ไม่รวมวงเล็บรอบตัวมัน → ครอบอยู่ในวงเล็บเดิม
  // a, b (SequenceExpression) ต้องมีวงเล็บของตัวเองไม่งั้นกลายเป็น argument 2 ตัว
  const wrap = (node, fn, priority) => {
    const span = node.end - node.start;
    const sequence = node.type === "SequenceExpression";
    open(node.start, sequence ? `${fn}((` : `${fn}(`, span, priority);
    close(node.end, sequence ? "))" : ")", span);
  };

  const visit = (node, parent) => {
    if (node.type === "Identifier" && RESERVED.has(node.name)) {
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
    } else if (node.type === "BinaryExpression" && node.operator === "+") wrap(node, STR_FN, PRIORITY.str);
    else if (node.type === "AssignmentExpression" && node.operator === "+=") wrap(node, STR_FN, PRIORITY.str);
    else if (node.type === "SpreadElement" && (parent?.type === "ObjectExpression" || SPREAD_PARENTS.has(parent?.type))) {
      // { ...x } → { ...__props(x) } · [...x] / f(...x) → ...__spread(x)
      // ช่วงของ SpreadElement รวมวงเล็บรอบ x แล้ว: { ...(a, b) } → { ...__props((a, b)) }
      const at = node.start + 3;
      const span = node.end - at;
      open(at, `${parent.type === "ObjectExpression" ? PROPS_FN : SPREAD_FN}(`, span, PRIORITY.props);
      close(node.end, ")", span);
    } else if (node.type === "VariableDeclarator" && node.init && (hasObjectRest(node.id) || hasArrayRest(node.id))) {
      allowedRest.add(node.id);
      wrap(node.init, node.id.type === "ObjectPattern" ? PROPS_FN : SPREAD_FN, PRIORITY.props);
    } else if (node.type === "AssignmentExpression" && node.operator === "=" && (hasObjectRest(node.left) || hasArrayRest(node.left))) {
      allowedRest.add(node.left);
      wrap(node.right, node.left.type === "ObjectPattern" ? PROPS_FN : SPREAD_FN, PRIORITY.props);
    } else if ((hasObjectRest(node) || hasArrayRest(node)) && !allowedRest.has(node)) {
      throw new SyntaxError("...rest ใน pattern ใช้ได้เฉพาะ const { a, ...rest } = ค่า / const [a, ...rest] = ค่า หรือ ({ a, ...rest } = ค่า) / ([a, ...rest] = ค่า) "
        + "(ตำแหน่งอื่น เช่น พารามิเตอร์ / for…of / catch / ซ้อนใน pattern คิดแก๊สตามขนาดที่คัดลอกไม่ได้)");
    }
    for (const child of children(node)) visit(child, node);
  };

  regions.push({ nodes: [ast], place: statementGas(0) });
  visit(ast, null);

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
  for (let i = 0; i <= source.length; i++) {
    const here = at.get(i) ?? [];
    // ปิดของเดิมก่อน (ช่วงเล็กก่อน) → เปิดของใหม่ (ช่วงใหญ่ก่อน / ลำดับความสำคัญสูงก่อน)
    for (const edit of here.filter((e) => !e.open).sort((a, b) => a.span - b.span)) out += edit.text;
    for (const edit of here.filter((e) => e.open).sort((a, b) => b.span - a.span || b.priority - a.priority)) out += edit.text;
    if (i < source.length) out += source[i];
  }
  return out;
}
