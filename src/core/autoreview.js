/**
 * Automatic review of program code, used instead of human review.
 * This file is self-contained and does not depend on the VM (it only needs acorn), so it can guard /sendtx directly.
 *
 *   import { reviewProgram } from "./autoreview.js";
 *
 *   const result = reviewProgram(tx.code);
 *   if (!result.ok) return reply.status(400).send({ error: "code failed review", issues: result.issues });
 *
 * Principle: allowlist. Only what is listed is allowed; everything else is rejected,
 * so there is no need to ban process / fetch / eval one by one.
 */
import { parse } from "acorn";

/** APIs the VM injects into a program at run time */
export const PROGRAM_API = [
  "readDB", "writeDB", "deleteDB", "map", "runProgram", "transferNative", "setMetadata", "emit",
  "keccak256", "ecrecover", "ThisAddress", "ThisBalance", "BalanceOf", "IsProgram", "MetadataOf", "BlockNumber",
  "cloneProgram",   // create a new program from an approved template program (CREATE2-style)
  "sha256", "ripemd160", "blake2b", "modexp",   // EVM-style precompiles
  "BlockHash", "ChainId", "Coinbase", "BlockGasLimit", "GasPrice", "BaseFee", "GasLeft", "CodeHashOf", "CodeSizeOf",
  "keccak256Bytes", "ecrecoverDigest", "eip712Digest", "eip712DomainSeparator",   // raw bytes + EIP-712 (eth_signTypedData_v4)
  "params",
];

/**
 * Review code submitted by a user. This is the main entry point.
 * @param {string} code raw code from tx.code
 * @returns {{ ok: boolean, issues: Array<{line:number,column:number,message:string}>, message: string }}
 */
export function reviewProgram(code, { apiNames = PROGRAM_API } = {}) {
  const result = review(code, { apiNames });
  return { ...result, message: reviewMessage(result) };
}

/** node types a program may use */
const ALLOWED_NODES = new Set([
  "Program", "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "BlockStatement",
  "VariableDeclaration", "VariableDeclarator", "ExpressionStatement", "ReturnStatement", "IfStatement",
  "ForStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement", "BreakStatement", "ContinueStatement",
  "SwitchStatement", "SwitchCase", "ThrowStatement", "TryStatement", "CatchClause", "EmptyStatement",
  "CallExpression", "MemberExpression", "BinaryExpression", "LogicalExpression", "UnaryExpression",
  "UpdateExpression", "AssignmentExpression", "ConditionalExpression", "SequenceExpression", "SpreadElement",
  "ArrayExpression", "ObjectExpression", "Property", "TemplateLiteral", "TemplateElement",
  "Identifier", "Literal", "RestElement", "ArrayPattern", "ObjectPattern", "AssignmentPattern",
  "NewExpression",   // only new Error(...), checked further below
]);

/**
 * allowed globals, each with its "allowed methods"
 * Anything that touches shared prototypes (Object.defineProperty etc.) and anything whose result differs across machines
 * (Math.sin, toLocaleString) is removed entirely.
 */
export const ALLOWED_MEMBERS = {
  Object: ["keys", "values", "entries", "fromEntries"],
  Array: ["isArray", "of"],
  JSON: ["parse", "stringify"],
  Math: ["abs", "floor", "ceil", "round", "trunc", "sign", "min", "max", "random", "PI", "E"],
  Number: ["isInteger", "isSafeInteger", "isFinite", "isNaN", "parseInt", "parseFloat", "MAX_SAFE_INTEGER", "MIN_SAFE_INTEGER"],
  String: ["fromCharCode"],
  Date: ["now", "UTC", "parse"],   // now is replaced by the VM with the block time; UTC / parse are pure computation
  BigInt: [],
  Boolean: [],
  Error: [],
};

export const ALLOWED_GLOBALS = new Set([
  ...Object.keys(ALLOWED_MEMBERS), "isNaN", "isFinite", "parseInt", "parseFloat", "undefined", "NaN", "Infinity",
]);

/**
 * forbidden methods on values (string / array / object)
 *   - results differ by locale or engine
 * (repeat / padStart / padEnd are now allowed: the sandbox charges gas by result size before running + caps memory)
 */
const BANNED_METHODS = new Set([
  "sort",                                                // order is nondeterministic if the comparator is inconsistent
  "localeCompare", "toLocaleString", "toLocaleDateString", "toLocaleTimeString",
  "normalize", "toLocaleUpperCase", "toLocaleLowerCase",
  "bind", "call", "apply",                               // changes this / escapes scope
]);

/** property names that are escape hatches out of the sandbox */
const BANNED_PROPERTIES = new Set([
  "constructor", "prototype", "__proto__", "__defineGetter__", "__defineSetter__",
  "caller", "callee", "arguments",
  "stack",   // format differs across Node versions → written to the DB, then replay does not match
]);

/** constructors that may be used with new */
const ALLOWED_NEW = new Set(["Error", "Date"]);   // Date is already replaced by the VM with the block time

const at = (node) => ({ line: node.loc?.start.line ?? 0, column: node.loc?.start.column ?? 0 });

/**
 * @param {string} code raw code submitted by the user
 * @param {{ apiNames?: string[] }} [options] names of VM APIs the program may call
 */
export function review(code, { apiNames = [] } = {}) {
  const issues = [];
  const add = (node, message) => issues.push({ ...at(node), message });

  let ast;
  try {
    ast = parse(code, { ecmaVersion: 2022, locations: true });
  } catch (error) {
    return { ok: false, issues: [{ line: error.loc?.line ?? 0, column: error.loc?.column ?? 0, message: `syntax error: ${error.message}` }] };
  }

  const known = new Set([...ALLOWED_GLOBALS, ...apiNames]);
  const declared = new Set();

  // first pass: collect every name the program declares itself (all scopes merged; slightly stricter than reality but safe)
  walk(ast, (node) => {
    if (node.type === "FunctionDeclaration" && node.id) declared.add(node.id.name);
    if (node.type === "FunctionExpression" && node.id) declared.add(node.id.name);
    if (node.type === "VariableDeclarator") collectNames(node.id, declared);
    if (node.type === "CatchClause" && node.param) collectNames(node.param, declared);
    for (const param of node.params ?? []) collectNames(param, declared);
  });

  // second pass: check the rules
  walk(ast, (node, parent) => {
    if (!ALLOWED_NODES.has(node.type)) {
      add(node, `ใช้ ${describe(node.type)} ไม่ได้`);
      return;
    }
    if (node.type === "NewExpression" && !(node.callee.type === "Identifier" && ALLOWED_NEW.has(node.callee.name))) {
      add(node, "new ได้เฉพาะ Error และ Date เท่านั้น");
    }
    if (node.type === "MemberExpression") {
      if (node.computed) {
        add(node, "เข้าถึงแบบ obj[key] ไม่ได้ (ใช้ map() กับ readDB แทน)");
      } else if (node.property.type === "Identifier") {
        const name = node.property.name;
        if (BANNED_PROPERTIES.has(name)) add(node, `เข้าถึง .${name} ไม่ได้`);
        else if (BANNED_METHODS.has(name)) add(node, `ใช้ .${name}() ไม่ได้ (ผลไม่แน่นอนหรือสร้างข้อมูลใหญ่เกินการนับค่าแก๊ส)`);
        // allowed global: only the methods on its allowlist may be used
        else if (node.object.type === "Identifier" && ALLOWED_MEMBERS[node.object.name] && !declared.has(node.object.name)) {
          const allowed = ALLOWED_MEMBERS[node.object.name];
          if (!allowed.includes(name)) add(node, `${node.object.name}.${name} ใช้ไม่ได้ (ใช้ได้เฉพาะ ${allowed.join(", ") || "ไม่มี"})`);
        }
      }
    }
    if (node.type === "Property" && (node.kind !== "init" || node.method)) {
      add(node, "getter / setter / เมธอดใน object literal ใช้ไม่ได้");
    }
    if (node.type === "Property" && node.computed) add(node, "ชื่อ key แบบคำนวณไม่ได้");
    if (node.async) add(node, "async / await ใช้ไม่ได้");
    if (node.generator) add(node, "generator ใช้ไม่ได้");
    if (node.type === "Literal" && node.regex) add(node, "regular expression ใช้ไม่ได้ (เวลาทำงานไม่แน่นอน)");
    if (node.type === "Identifier" && isReference(node, parent)) {
      if (!declared.has(node.name) && !known.has(node.name)) {
        add(node, `'${node.name}' ไม่รู้จัก (ใช้ได้เฉพาะ API ของ VM และตัวแปรที่ประกาศเอง)`);
      }
      if (node.name.startsWith("__")) add(node, `ห้ามใช้ชื่อที่ขึ้นต้นด้วย __ ('${node.name}')`);
    }
  });

  return issues.length ? { ok: false, issues } : { ok: true, issues: [] };
}

/** summary message shown to whoever submitted the code */
export function reviewMessage(result) {
  return result.ok ? "ผ่านการตรวจ" : result.issues.map((issue) => `บรรทัด ${issue.line}: ${issue.message}`).join("\n");
}

// ---------------------------------------------------------------------------

function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== "string") return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end") continue;
    const child = node[key];
    if (Array.isArray(child)) for (const item of child) walk(item, visit, node);
    else walk(child, visit, node);
  }
}

function collectNames(pattern, set) {
  if (!pattern) return;
  if (pattern.type === "Identifier") set.add(pattern.name);
  if (pattern.type === "ObjectPattern") for (const property of pattern.properties) collectNames(property.value ?? property.argument, set);
  if (pattern.type === "ArrayPattern") for (const element of pattern.elements) collectNames(element, set);
  if (pattern.type === "AssignmentPattern") collectNames(pattern.left, set);
  if (pattern.type === "RestElement") collectNames(pattern.argument, set);
}

/** identifiers that are real "value references" (not property names or names being declared) */
function isReference(node, parent) {
  if (!parent) return true;
  if (parent.type === "MemberExpression" && parent.property === node && !parent.computed) return false;
  if (parent.type === "Property" && parent.key === node && !parent.computed) return false;
  return true;
}

const DESCRIPTIONS = {
  ClassDeclaration: "class", ClassExpression: "class", ImportDeclaration: "import", ExportNamedDeclaration: "export",
  AwaitExpression: "await", YieldExpression: "yield", ThisExpression: "this", WithStatement: "with",
  ForInStatement: "for...in (ลำดับไม่แน่นอน ใช้ for...of แทน)", RegExpLiteral: "regular expression",
  TaggedTemplateExpression: "tagged template", MetaProperty: "import.meta / new.target", LabeledStatement: "label",
};
const describe = (type) => DESCRIPTIONS[type] ?? type;
