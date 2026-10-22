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
 *   a + b · a += b                → __add(a, b) / a = __add(a, b)   ผลเป็น string = คิดตามความยาว (แบบ __str เดิม)
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
 * แก๊สตามงาน CPU ของ BigInt (คิดใน sandbox ดู sandbox.js "BigInt") — เทสต์ 81:
 *   a - b · a * b · a / b · a % b · a ** b · a << b · a >> b → __sub(a, b) … (number ล้วนทำทันที แก๊สเท่าเดิม)
 *   a < b · a > b · a <= b · a >= b · a == b · a != b      → __lt(a, b) …  (BigInt เทียบ string = แปลง string เป็น BigInt)
 *   k in o                                                 → __in(k, o)
 *   x op= y (op = + - * / % ** << >>) → x = __op(x, y) ถ้าเป้าหมายเป็นชื่อ / this.p / o.p / o[k] ที่ o, k เป็นชื่อหรือค่าคงที่
 *                                       ที่เหลือ → __opm(o, k, "op", () => (y)) (อ่านค่าเดิมก่อน y ตามมาตรฐาน)
 *   o[k] · { [k]: v } · class { [k]() {} }     → o[(__k = (k), typeof __k === "string" || … ? __k : __key(__k))]
 *     (ชื่อ property จาก BigInt = แปลงเป็นเลขฐาน 10 ซึ่งใช้เวลา ~W² — คิดก่อนแปลง)
 *   return x · (x) => x                        → return (__r = (x), typeof __r === "bigint" ? __big(__r) : __r)
 *     (ฟังก์ชันที่ engine เรียกเอง เช่น valueOf / toString / getter คืน BigInt ใหญ่ → engine แปลงเป็น string ต่อโดยไม่ผ่านตัวนับ)
 *   BigInt literal ใหญ่เกิน BIGINT_MAX_BITS → deploy ไม่ผ่าน
 * regular expression (literal) → deploy ไม่ผ่าน (backtrack ได้แบบ exponential คิดแก๊สล่วงหน้าไม่ได้ · sandbox ปิด RegExp ทั้งหมดด้วย)
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
/** operator → ตัวช่วยใน sandbox ที่คิดแก๊สตามขนาด BigInt (ค่าที่เป็น number ล้วนทำทันที) */
export const OPERATOR_FNS = {
  "+": "__add", "-": "__sub", "*": "__mul", "/": "__div", "%": "__mod", "**": "__pow", "<<": "__shl", ">>": "__shr",
  "<": "__lt", ">": "__gt", "<=": "__le", ">=": "__ge", "==": "__eq", "!=": "__ne", in: "__in",
};
export const KEY_FN = "__key";
export const BIG_FN = "__big";
export const OPM_FN = "__opm";
/** ตัวแปรชั่วคราวที่โค้ดที่ฉีดแล้วใช้ (ประกาศเองต้นโค้ด) */
const KEY_VAR = "__k";
const RET_VAR = "__r";
/** ฟังก์ชันของ VM ที่โค้ดที่ฉีดแล้วเรียก (destructure จาก api ใน factory ของโปรแกรม) */
export const METER_FNS = [GAS_FN, STR_FN, PROPS_FN, SPREAD_FN, ...new Set(Object.values(OPERATOR_FNS)), KEY_FN, BIG_FN, OPM_FN];
const RESERVED = new Set([...METER_FNS, CALL_FN, KEY_VAR, RET_VAR]);
/** ขนาด BigInt สูงสุด (bit ของค่าสัมบูรณ์) — เท่าเพดานของ modexp (1024 ไบต์) · sandbox ตรวจผลของทุกการคำนวณด้วยค่าเดียวกัน */
export const BIGINT_MAX_BITS = 8192;
/** compound assignment ที่แปลง (ที่เหลือ เช่น &= |= ^= >>>= &&= ไม่ทำให้ BigInt ใหญ่ขึ้นและไม่แปลง string) */
const COMPOUND = new Set(["+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>="]);

/**
 * ตัวช่วยแบบ V8 ธรรมดา (ไม่คิดแก๊ส) — ใช้รันโค้ดที่ฉีดแล้วนอก sandbox (เทสต์ / เครื่องมือ)
 *   new Function(...METER_FNS, instrument(body))(...METER_FNS.map((name) => PLAIN_HELPERS[name]))
 */
export const PLAIN_HELPERS = {
  __gas() {}, __str: (v) => v, __props: (v) => v, __spread: (v) => v, __key: (k) => k, __big: (v) => v,
  __add: (a, b) => a + b, __sub: (a, b) => a - b, __mul: (a, b) => a * b, __div: (a, b) => a / b, __mod: (a, b) => a % b,
  __pow: (a, b) => a ** b, __shl: (a, b) => a << b, __shr: (a, b) => a >> b, __lt: (a, b) => a < b, __gt: (a, b) => a > b,
  __le: (a, b) => a <= b, __ge: (a, b) => a >= b, __eq: (a, b) => a == b, __ne: (a, b) => a != b, __in: (k, o) => k in o,
  __opm(o, k, op, rhs) {
    const old = o[k];
    return (o[k] = PLAIN_HELPERS[OPERATOR_FNS[op]](old, rhs()));
  },
};

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const LOOP_TYPES = new Set(["ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement"]);
const SKIP_KEYS = new Set(["start", "end", "loc", "range"]);

// ลำดับของข้อความที่แทรกตรงตำแหน่งเดียวกัน (ช่วงยาวเท่ากัน): ตัวนับก่อน แล้วตัวครอบช่วง แล้ว return แล้ว __props / __spread
// แล้วชื่อ property แล้ว operator (ตัวที่เปิดก่อนปิดทีหลัง)
const PRIORITY = { gas: 7, region: 6, ret: 5, props: 4, key: 3, op: 2 };
const SIMPLE_OBJECT = new Set(["Identifier", "ThisExpression", "Super"]);

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
  const deleted = new Set(); // ตำแหน่งของตัวอักษรที่ถูกแทนที่ (operator ที่กลายเป็น ",")
  const regionRoots = new Set([ast]);
  const regions = [];        // { nodes: node[], place(n) }
  const allowedRest = new Set();   // pattern ที่มี ...rest และค่าที่ถูกคัดลอกถูกครอบด้วย __props / __spread แล้ว
  const keyHandled = new Set();    // ชื่อ property แบบคำนวณที่ __opm แปลงเองแล้ว (ไม่ครอบซ้ำ)

  const open = (at, text, span, priority) => edits.push({ at, text, open: true, span, priority });
  const close = (at, text, span, priority = 0) => edits.push({ at, text, open: false, span, priority });
  /** แทนที่ source[at, at + length) ด้วย text */
  const replace = (at, length, text) => {
    edits.push({ at, text, open: true, span: -1, priority: 0 });
    for (let i = at; i < at + length; i++) deleted.add(i);
  };

  const statementGas = (at) => (n) => open(at, `${GAS_FN}(${n});`, Infinity, PRIORITY.gas);
  const region = (node, extra = []) => {
    regionRoots.add(node);
    for (const part of extra) regionRoots.add(part);
    const nodes = [node, ...extra];
    if (node.type === "BlockStatement") return regions.push({ nodes, place: statementGas(node.start + 1) });
    const span = node.end - node.start;
    if (node.type.endsWith("Statement") || node.type.endsWith("Declaration")) {
      // ทางของ if / ตัวลูปที่ไม่มี { } → ครอบด้วย { }
      return regions.push({ nodes, place: (n) => { open(node.start, `{${GAS_FN}(${n});`, span, PRIORITY.region); close(node.end, "}", span, PRIORITY.region); } });
    }
    // ตัวฟังก์ชันแบบ arrow ที่เป็นนิพจน์: x => expr → x => (__gas(n), expr)
    return regions.push({ nodes, place: (n) => { open(node.start, `(${GAS_FN}(${n}),`, span, PRIORITY.region); close(node.end, ")", span, PRIORITY.region); } });
  };

  // ครอบนิพจน์ด้วย before … after · ช่วงของ node ไม่รวมวงเล็บรอบตัวมัน → ครอบอยู่ในวงเล็บเดิม
  const surround = (node, before, after, priority) => {
    const span = node.end - node.start;
    open(node.start, before, span, priority);
    close(node.end, after, span, priority);
  };
  // fn( … ) · a, b (SequenceExpression) ต้องมีวงเล็บของตัวเองไม่งั้นกลายเป็น argument 2 ตัว
  const wrap = (node, fn, priority) => {
    const sequence = node.type === "SequenceExpression";
    surround(node, sequence ? `${fn}((` : `${fn}(`, sequence ? "))" : ")", priority);
  };
  /** ตำแหน่งของ token ถัดไปตั้งแต่ from (ข้ามช่องว่าง / comment / วงเล็บปิดของนิพจน์ทางซ้าย) */
  const findToken = (from, token) => {
    let i = from;
    while (i < body.length) {
      if (/\s/.test(body[i]) || body[i] === ")") i++;
      else if (body.startsWith("/*", i)) i = body.indexOf("*/", i + 2) + 2;
      else if (body.startsWith("//", i)) {
        while (i < body.length && !/[\n\r\u2028\u2029]/.test(body[i])) i++;
      } else if (body.startsWith(token, i)) return i;
      else break;
    }
    throw new SyntaxError(`แปลงโค้ดไม่ได้ (หา '${token}' ไม่พบ)`);
  };
  /** a OP b → __op(a , b) */
  const binary = (node, fn) => {
    wrap(node, fn, PRIORITY.op);
    replace(findToken(node.left.end, node.operator), node.operator.length, ",");
  };
  const isConstantKey = (node) => node.type === "TemplateLiteral" || (node.type === "Literal" && node.bigint === undefined);
  const isSimpleKey = (node) => node.type === "Identifier" || node.type === "Literal";
  /** ชื่อ property แบบคำนวณ: string / number ผ่านไปเลย · อย่างอื่น (BigInt / object) → __key */
  const key = (node) => {
    if (isConstantKey(node) || keyHandled.has(node)) return;
    surround(node, `(${KEY_VAR} = (`, `), typeof ${KEY_VAR} === "string" || typeof ${KEY_VAR} === "number" ? ${KEY_VAR} : ${KEY_FN}(${KEY_VAR}))`, PRIORITY.key);
  };
  /** ค่าที่ฟังก์ชันคืน: BigInt ใหญ่ → __big (คิดค่าแปลงเป็น string ไว้ก่อน เผื่อ engine เป็นผู้เรียก) */
  const returned = (node) => {
    surround(node, `(${RET_VAR} = (`, `), typeof ${RET_VAR} === "bigint" ? ${BIG_FN}(${RET_VAR}) : ${RET_VAR})`, PRIORITY.ret);
  };
  /** x op= y */
  const compound = (node) => {
    const target = node.left;
    const symbol = node.operator.slice(0, -1);
    const fn = OPERATOR_FNS[symbol];
    const span = node.end - node.start;
    const operatorAt = findToken(target.end, node.operator);
    const simple = target.type === "Identifier" || (target.type === "MemberExpression" && SIMPLE_OBJECT.has(target.object.type)
      && (!target.computed || isSimpleKey(target.property)));
    if (simple) {
      // x += y → x = __add(x, y) · o.p += y → o.p = __add(o.p, y) (ชื่อ / this / ค่าคงที่ อ่านซ้ำได้โดยไม่มีผลข้างเคียง)
      replace(operatorAt, node.operator.length, `= ${fn}(${body.slice(target.start, target.end)},`);
      close(node.end, ")", span, PRIORITY.op);
      return;
    }
    if (target.type !== "MemberExpression" || target.property.type === "PrivateIdentifier") {
      throw new SyntaxError(`${node.operator} กับเป้าหมายแบบนี้ใช้ไม่ได้ (เขียนเป็น x = x ${symbol} y แทน)`);
    }
    // f().p += y → __opm(f(), "p", "+", () => (y)) · a[i++] += y → __opm(a, i++, "+", () => (y))
    open(node.start, `${OPM_FN}(`, span, PRIORITY.op);
    if (target.computed) {
      keyHandled.add(target.property);
      replace(findToken(target.object.end, "["), 1, ",");
      replace(findToken(target.property.end, "]"), 1, "");
    } else {
      const dot = findToken(target.object.end, ".");
      replace(dot, target.property.end - dot, `, ${JSON.stringify(target.property.name)}`);
    }
    replace(operatorAt, node.operator.length, `, ${JSON.stringify(symbol)}, () => (`);
    close(node.end, "))", span, PRIORITY.op);
  };

  const visit = (node, parent) => {
    if (node.type === "Identifier" && RESERVED.has(node.name)) {
      throw new SyntaxError(`ชื่อ ${node.name} สงวนไว้สำหรับ VM`);
    }
    if (node.type === "Literal" && node.regex) {
      throw new SyntaxError("regular expression ใช้ในโปรแกรมไม่ได้ (เวลาทำงานไม่แน่นอน — ใช้ indexOf / includes / split แทน)");
    }
    if (node.type === "Literal" && node.bigint !== undefined && bitLength(BigInt(node.bigint)) > BIGINT_MAX_BITS) {
      throw new SyntaxError(`BigInt ใหญ่เกิน ${BIGINT_MAX_BITS} bit`);
    }
    if (FUNCTION_TYPES.has(node.type)) {
      region(node.body);
      if (node.expression) returned(node.body);
    } else if (LOOP_TYPES.has(node.type)) region(node.body, [node.test, node.update].filter(Boolean));
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
    } else if (node.type === "SpreadElement" && (parent?.type === "ObjectExpression" || SPREAD_PARENTS.has(parent?.type))) {
      // { ...x } → { ...__props(x) } · [...x] / f(...x) → ...__spread(x)
      // ช่วงของ SpreadElement รวมวงเล็บรอบ x แล้ว: { ...(a, b) } → { ...__props((a, b)) }
      const at = node.start + 3;
      const span = node.end - at;
      open(at, `${parent.type === "ObjectExpression" ? PROPS_FN : SPREAD_FN}(`, span, PRIORITY.props);
      close(node.end, ")", span, PRIORITY.props);
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
    // BigInt: operator / ชื่อ property / ค่าที่คืน (แยกจากด้านบน — node เดียวโดนได้ทั้งสองแบบ)
    if (node.type === "BinaryExpression" && OPERATOR_FNS[node.operator] && node.left.type !== "PrivateIdentifier") binary(node, OPERATOR_FNS[node.operator]);
    else if (node.type === "AssignmentExpression" && COMPOUND.has(node.operator)) compound(node);
    else if (node.type === "MemberExpression" && node.computed) key(node.property);
    else if ((node.type === "Property" || node.type === "MethodDefinition" || node.type === "PropertyDefinition") && node.computed) key(node.key);
    else if (node.type === "ReturnStatement" && node.argument) returned(node.argument);
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

  // ตัวแปรชั่วคราวของ __key / __big (ใช้ร่วมกันได้: ไม่มีโค้ดอื่นรันระหว่างเขียนกับอ่าน)
  open(0, `var ${KEY_VAR}, ${RET_VAR};`, Infinity, Infinity);
  return applyEdits(body, edits, deleted);
}

/** จำนวน bit ของค่าสัมบูรณ์ */
export function bitLength(value) {
  const magnitude = value < 0n ? -value : value;
  return magnitude === 0n ? 0 : magnitude.toString(2).length;
}

function applyEdits(source, edits, deleted) {
  const at = new Map();
  for (const edit of edits) {
    if (!at.has(edit.at)) at.set(edit.at, []);
    at.get(edit.at).push(edit);
  }
  let out = "";
  for (let i = 0; i <= source.length; i++) {
    const here = at.get(i) ?? [];
    // ปิดของเดิมก่อน (ช่วงเล็กก่อน / ตัวในก่อน) → เปิดของใหม่ (ช่วงใหญ่ก่อน / ลำดับความสำคัญสูงก่อน)
    for (const edit of here.filter((e) => !e.open).sort((a, b) => a.span - b.span || a.priority - b.priority)) out += edit.text;
    for (const edit of here.filter((e) => e.open).sort((a, b) => b.span - a.span || b.priority - a.priority)) out += edit.text;
    if (i < source.length && !deleted.has(i)) out += source[i];
  }
  return out;
}
