/**
 * Step-counting gas: inject counters into the program code before compiling (the code stored in the DB / shown in the explorer stays the original)
 *
 *   const code = instrument(body);   // body = code inside function program() { ... }
 *
 * Code is split into "segments" that run straight through without looping or branching:
 *   program start · function start · start of every loop iteration · each branch of if / switch · try / catch / finally
 * Each segment starts with an inserted __gas(n), where n = the number of AST nodes in that segment
 *   → gas depends only on the code, is identical on every machine, and infinite loops run out of gas on their own
 *   sub-branches inside expressions (a && b, c ? x : y) count toward their enclosing segment, so every branch is always charged in full
 *   loop conditions / updates are charged again on every iteration
 *
 * Gas by size of data copied / created (charged in the sandbox; see sandbox.js "gas by data size"):
 *   a + b · a += b                → __add(a, b) / a = __add(a, b)   string result = charged by length (like the old __str)
 *     (template `…${x}…` needs no wrapping: QuickJS builds it with "".concat(…), which the sandbox already wraps; test 76 covers this)
 *   { ...x }                      → { ...__props(x) }   charged by the number of properties copied
 *   const { a, ...rest } = x      → … = __props(x)      (and ({ a, ...rest } = x))
 *   [...a] · f(...a) · new F(...a) → ...__spread(a)  charged by the number of elements copied
 *   const [x, ...rest] = a        → … = __spread(a)     (and ([x, ...rest] = a))
 *   ...rest in any other pattern position (parameters like { ...r } / [ ...r ] · for…of · catch · nested in another pattern) → deploy fails
 *     because there is no expression to wrap (the copied value does not come from an expression in the code); use const [ ...rest ] = value inside the function body instead
 *     (function f(...args) works as usual: arguments come from the call, which is already charged)
 *   built-in methods (join, split, slice, JSON.stringify …) are wrapped by the sandbox itself; calls need no rewriting
 *     (calls through .call / Reflect.apply / a variable holding the method are charged the same)
 *
 * Gas by BigInt CPU work (charged in the sandbox; see sandbox.js "BigInt"), test 81:
 *   a - b · a * b · a / b · a % b · a ** b · a << b · a >> b → __sub(a, b) … (plain numbers run immediately, same gas as before)
 *   a < b · a > b · a <= b · a >= b · a == b · a != b      → __lt(a, b) …  (BigInt vs string = string converted to BigInt · long strings charged by length)
 *   a === b · a !== b (when neither side is a constant / typeof …) → __seq / __sne  (equal-length long strings charged by length)
 *   switch (x) { … }                          → switch (__sw((x), number of cases))  (long strings charged by length × number of cases)
 *   k in o                                                 → __in(k, o)
 *   x op= y (op = + - * / % ** << >>) → x = __op(x, y) if the target is a name / this.p / o.p / o[k] where o, k are names or constants
 *                                       otherwise → __opm(o, k, "op", () => (y)) (reads the old value before y, per the spec)
 *   o[k] · { [k]: v } · class { [k]() {} }     → o[(__k = (k), typeof __k === "string" || … ? __k : __key(__k))]
 *     (a property name from a BigInt = conversion to base 10, which takes ~W² time; charged before converting)
 *   return x · (x) => x                        → return (__r = (x), typeof __r === "bigint" ? __big(__r) : __r)
 *     (functions the engine calls itself, e.g. valueOf / toString / getters returning a large BigInt → the engine converts to string without going through the counter)
 *   BigInt literals larger than BIGINT_MAX_BITS → deploy fails
 * regular expressions (literals) → deploy fails (can backtrack exponentially, so gas cannot be charged up front · the sandbox also disables RegExp entirely)
 *
 * Code line numbers do not change (error messages still point at the original line), but columns shift
 */
import { parse } from "acorn";

export const GAS_FN = "__gas";
export const STR_FN = "__str";
export const PROPS_FN = "__props";
export const SPREAD_FN = "__spread";
/** former name of the built-in method caller (no longer used, but still reserved) */
export const CALL_FN = "__call";
/** operator → sandbox helper that charges gas by BigInt size (plain number values run immediately) */
export const OPERATOR_FNS = {
  "+": "__add", "-": "__sub", "*": "__mul", "/": "__div", "%": "__mod", "**": "__pow", "<<": "__shl", ">>": "__shr",
  "<": "__lt", ">": "__gt", "<=": "__le", ">=": "__ge", "==": "__eq", "!=": "__ne", in: "__in",
  "===": "__seq", "!==": "__sne",
};
/** === / !== on equal-length strings takes time proportional to length → wrap only when both sides may be long strings (if either side is a constant it is already cheap) */
const STRICT = new Set(["===", "!=="]);
const isCheapOperand = (node) => node.type === "Literal" || (node.type === "TemplateLiteral" && node.expressions.length === 0)
  || (node.type === "UnaryExpression" && node.operator !== "-" && node.operator !== "+") || (node.type === "Identifier" && node.name === "undefined");
export const KEY_FN = "__key";
/** switch (x): compares x with every case using === → long strings charged by length × number of cases */
export const SWITCH_FN = "__sw";
export const BIG_FN = "__big";
export const OPM_FN = "__opm";
/** temporary variables used by the instrumented code (declared at the start of the code) */
const KEY_VAR = "__k";
const RET_VAR = "__r";
/** VM functions called by the instrumented code (destructured from api in the program factory) */
export const METER_FNS = [GAS_FN, STR_FN, PROPS_FN, SPREAD_FN, ...new Set(Object.values(OPERATOR_FNS)), KEY_FN, BIG_FN, OPM_FN, SWITCH_FN];
const RESERVED = new Set([...METER_FNS, CALL_FN, KEY_VAR, RET_VAR]);
/** maximum BigInt size (bits of the absolute value), equal to the modexp ceiling (1024 bytes) · the sandbox checks the result of every computation against the same value */
export const BIGINT_MAX_BITS = 8192;
/** compound assignments that are rewritten (the rest, e.g. &= |= ^= >>>= &&=, do not grow a BigInt and do not convert strings) */
const COMPOUND = new Set(["+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>="]);

/**
 * Plain V8 helpers (no gas charged), used to run instrumented code outside the sandbox (tests / tools)
 *   new Function(...METER_FNS, instrument(body))(...METER_FNS.map((name) => PLAIN_HELPERS[name]))
 */
export const PLAIN_HELPERS = {
  __gas() {}, __str: (v) => v, __props: (v) => v, __spread: (v) => v, __key: (k) => k, __big: (v) => v,
  __add: (a, b) => a + b, __sub: (a, b) => a - b, __mul: (a, b) => a * b, __div: (a, b) => a / b, __mod: (a, b) => a % b,
  __pow: (a, b) => a ** b, __shl: (a, b) => a << b, __shr: (a, b) => a >> b, __lt: (a, b) => a < b, __gt: (a, b) => a > b,
  __le: (a, b) => a <= b, __ge: (a, b) => a >= b, __eq: (a, b) => a == b, __ne: (a, b) => a != b, __in: (k, o) => k in o,
  __seq: (a, b) => a === b, __sne: (a, b) => a !== b, __sw: (value) => value,
  __opm(o, k, op, rhs) {
    const old = o[k];
    return (o[k] = PLAIN_HELPERS[OPERATOR_FNS[op]](old, rhs()));
  },
};

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const LOOP_TYPES = new Set(["ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement"]);
const SKIP_KEYS = new Set(["start", "end", "loc", "range"]);

// order of text inserted at the same position (equal-length spans): counter first, then segment wrapper, then return, then __props / __spread
// then property name, then operator (opened first, closed last)
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

/** @param {string} body code inside program() @returns {string} code with gas counters */
export function instrument(body) {
  const ast = parse(body, { ecmaVersion: "latest", allowReturnOutsideFunction: true });
  const edits = [];          // { at, text, open, span, priority }
  const deleted = new Set(); // positions of replaced characters (operators that become ",")
  const regionRoots = new Set([ast]);
  const regions = [];        // { nodes: node[], place(n) }
  const allowedRest = new Set();   // patterns with ...rest whose copied value is already wrapped with __props / __spread
  const keyHandled = new Set();    // computed property names already converted by __opm itself (do not wrap again)

  const open = (at, text, span, priority) => edits.push({ at, text, open: true, span, priority });
  const close = (at, text, span, priority = 0) => edits.push({ at, text, open: false, span, priority });
  /** replace source[at, at + length) with text */
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
      // if branches / loop bodies without { } → wrap with { }
      return regions.push({ nodes, place: (n) => { open(node.start, `{${GAS_FN}(${n});`, span, PRIORITY.region); close(node.end, "}", span, PRIORITY.region); } });
    }
    // expression-bodied arrow functions: x => expr → x => (__gas(n), expr)
    return regions.push({ nodes, place: (n) => { open(node.start, `(${GAS_FN}(${n}),`, span, PRIORITY.region); close(node.end, ")", span, PRIORITY.region); } });
  };

  // wrap an expression with before … after · a node's span excludes surrounding parentheses → the wrap sits inside the original parentheses
  const surround = (node, before, after, priority) => {
    const span = node.end - node.start;
    open(node.start, before, span, priority);
    close(node.end, after, span, priority);
  };
  // fn( … ) · a, b (SequenceExpression) needs its own parentheses, otherwise it becomes 2 arguments
  const wrap = (node, fn, priority) => {
    const sequence = node.type === "SequenceExpression";
    surround(node, sequence ? `${fn}((` : `${fn}(`, sequence ? "))" : ")", priority);
  };
  /** position of the next token starting at from (skipping whitespace / comments / closing parentheses of the left-hand expression) */
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
  /** computed property names: string / number pass straight through · anything else (BigInt / object) → __key */
  const key = (node) => {
    if (isConstantKey(node) || keyHandled.has(node)) return;
    surround(node, `(${KEY_VAR} = (`, `), typeof ${KEY_VAR} === "string" || typeof ${KEY_VAR} === "number" ? ${KEY_VAR} : ${KEY_FN}(${KEY_VAR}))`, PRIORITY.key);
  };
  /** function return values: large BigInt → __big (charges the string conversion up front, in case the engine is the caller) */
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
      // x += y → x = __add(x, y) · o.p += y → o.p = __add(o.p, y) (names / this / constants can be re-read without side effects)
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
      // a SpreadElement's span already includes the parentheses around x: { ...(a, b) } → { ...__props((a, b)) }
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
    // BigInt: operator / property name / return value (separate from above; one node can get both kinds)
    if (node.type === "BinaryExpression" && OPERATOR_FNS[node.operator] && node.left.type !== "PrivateIdentifier"
      && !(STRICT.has(node.operator) && (isCheapOperand(node.left) || isCheapOperand(node.right)))) binary(node, OPERATOR_FNS[node.operator]);
    else if (node.type === "AssignmentExpression" && COMPOUND.has(node.operator)) compound(node);
    else if (node.type === "MemberExpression" && node.computed) key(node.property);
    else if (node.type === "SwitchStatement") {
      const cases = node.cases.filter((item) => item.test !== null).length;
      surround(node.discriminant, `${SWITCH_FN}((`, `), ${cases})`, PRIORITY.op);
    }
    else if ((node.type === "Property" || node.type === "MethodDefinition" || node.type === "PropertyDefinition") && node.computed) key(node.key);
    else if (node.type === "ReturnStatement" && node.argument) returned(node.argument);
    for (const child of children(node)) visit(child, node);
  };

  regions.push({ nodes: [ast], place: statementGas(0) });
  visit(ast, null);

  // node count of each segment (excluding nested child segments)
  const count = (node, root) => {
    let total = 1;
    for (const child of children(node)) if (child === root || !regionRoots.has(child)) total += count(child, root);
    return total;
  };
  for (const r of regions) r.place(r.nodes.reduce((sum, node) => sum + count(node, node), 0));

  // temporary variables for __key / __big (can be shared: no other code runs between the write and the read)
  open(0, `var ${KEY_VAR}, ${RET_VAR};`, Infinity, Infinity);
  return applyEdits(body, edits, deleted);
}

/** number of bits of the absolute value */
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
    // close existing ones first (smaller spans first / inner first) → then open new ones (larger spans first / higher precedence first)
    for (const edit of here.filter((e) => !e.open).sort((a, b) => a.span - b.span || a.priority - b.priority)) out += edit.text;
    for (const edit of here.filter((e) => e.open).sort((a, b) => b.span - a.span || b.priority - a.priority)) out += edit.text;
    if (i < source.length && !deleted.has(i)) out += source[i];
  }
  return out;
}
