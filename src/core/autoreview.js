/**
 * ตรวจโค้ดของโปรแกรมแบบอัตโนมัติ — ใช้แทนการรีวิวด้วยคน
 * ไฟล์นี้อยู่ได้ด้วยตัวเอง ไม่ต้องพึ่ง VM (ต้องการแค่ acorn) จึงเอาไปคั่นที่ /sendtx ได้เลย
 *
 *   import { reviewProgram } from "./autoreview.js";
 *
 *   const result = reviewProgram(tx.code);
 *   if (!result.ok) return reply.status(400).send({ error: "โค้ดไม่ผ่านการตรวจ", issues: result.issues });
 *
 * หลักการ: บัญชีขาว — อนุญาตเฉพาะสิ่งที่ระบุไว้ ที่เหลือปฏิเสธหมด
 * จึงไม่ต้องไล่ห้าม process / fetch / eval ทีละตัว
 */
import { parse } from "acorn";

/** API ที่ VM ใส่ให้โปรแกรมตอนรัน */
export const PROGRAM_API = [
  "readDB", "writeDB", "deleteDB", "map", "runProgram", "transferNative", "setMetadata", "emit",
  "keccak256", "ecrecover", "ThisAddress", "ThisBalance", "BalanceOf", "IsProgram", "MetadataOf", "BlockNumber",
  "params",
];

/**
 * ตรวจโค้ดที่ผู้ใช้ส่งมา — ใช้ตัวนี้เป็นหลัก
 * @param {string} code โค้ดดิบจาก tx.code
 * @returns {{ ok: boolean, issues: Array<{line:number,column:number,message:string}>, message: string }}
 */
export function reviewProgram(code, { apiNames = PROGRAM_API } = {}) {
  const result = review(code, { apiNames });
  return { ...result, message: reviewMessage(result) };
}

/** ชนิดของโครงสร้างที่โปรแกรมใช้ได้ */
const ALLOWED_NODES = new Set([
  "Program", "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "BlockStatement",
  "VariableDeclaration", "VariableDeclarator", "ExpressionStatement", "ReturnStatement", "IfStatement",
  "ForStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement", "BreakStatement", "ContinueStatement",
  "SwitchStatement", "SwitchCase", "ThrowStatement", "TryStatement", "CatchClause", "EmptyStatement",
  "CallExpression", "MemberExpression", "BinaryExpression", "LogicalExpression", "UnaryExpression",
  "UpdateExpression", "AssignmentExpression", "ConditionalExpression", "SequenceExpression", "SpreadElement",
  "ArrayExpression", "ObjectExpression", "Property", "TemplateLiteral", "TemplateElement",
  "Identifier", "Literal", "RestElement", "ArrayPattern", "ObjectPattern", "AssignmentPattern",
  "NewExpression",   // เฉพาะ new Error(...) — ตรวจเพิ่มด้านล่าง
]);

/**
 * global ที่อนุญาต พร้อม "เมธอดที่ใช้ได้" ของแต่ละตัว
 * ตัดสิ่งที่แตะ prototype ร่วม (Object.defineProperty ฯลฯ) และสิ่งที่ผลต่างกันข้ามเครื่อง
 * (Math.sin, toLocaleString) ออกทั้งหมด
 */
export const ALLOWED_MEMBERS = {
  Object: ["keys", "values", "entries", "fromEntries"],
  Array: ["isArray", "of"],
  JSON: ["parse", "stringify"],
  Math: ["abs", "floor", "ceil", "round", "trunc", "sign", "min", "max", "random", "PI", "E"],
  Number: ["isInteger", "isSafeInteger", "isFinite", "isNaN", "parseInt", "parseFloat", "MAX_SAFE_INTEGER", "MIN_SAFE_INTEGER"],
  String: ["fromCharCode"],
  Date: ["now", "UTC", "parse"],   // now ถูก VM แทนด้วยเวลาของ block ส่วน UTC / parse เป็นการคำนวณล้วน
  BigInt: [],
  Boolean: [],
  Error: [],
};

export const ALLOWED_GLOBALS = new Set([
  ...Object.keys(ALLOWED_MEMBERS), "isNaN", "isFinite", "parseInt", "parseFloat", "undefined", "NaN", "Infinity",
]);

/**
 * เมธอดของค่า (string / array / object) ที่ห้าม
 *   - สร้างข้อมูลใหญ่ได้ด้วยคำสั่งเดียว → ต้องรอ gas แบบนับขั้น
 *   - ผลต่างกันตาม locale หรือ engine
 */
const BANNED_METHODS = new Set([
  "repeat", "padStart", "padEnd",                       // "x".repeat(1e9)
  "sort",                                                // ลำดับไม่แน่นอนถ้า comparator ขัดแย้งกันเอง
  "localeCompare", "toLocaleString", "toLocaleDateString", "toLocaleTimeString",
  "normalize", "toLocaleUpperCase", "toLocaleLowerCase",
  "bind", "call", "apply",                               // เปลี่ยน this / หนีขอบเขต
]);

/** ชื่อ property ที่เป็นประตูหนีออกจาก sandbox */
const BANNED_PROPERTIES = new Set([
  "constructor", "prototype", "__proto__", "__defineGetter__", "__defineSetter__",
  "caller", "callee", "arguments",
  "stack",   // รูปแบบต่างกันตามเวอร์ชัน Node → เขียนลง DB แล้ว replay ไม่ตรง
]);

/** constructor ที่ new ได้ */
const ALLOWED_NEW = new Set(["Error", "Date"]);   // Date ถูก VM แทนด้วยเวลาของ block แล้ว

const at = (node) => ({ line: node.loc?.start.line ?? 0, column: node.loc?.start.column ?? 0 });

/**
 * @param {string} code โค้ดดิบที่ผู้ใช้ส่งมา
 * @param {{ apiNames?: string[] }} [options] ชื่อ API ของ VM ที่โปรแกรมเรียกได้
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

  // รอบแรก: เก็บชื่อทั้งหมดที่โปรแกรมประกาศเอง (ทุก scope รวมกัน — เข้มกว่าจริงเล็กน้อยแต่ปลอดภัย)
  walk(ast, (node) => {
    if (node.type === "FunctionDeclaration" && node.id) declared.add(node.id.name);
    if (node.type === "FunctionExpression" && node.id) declared.add(node.id.name);
    if (node.type === "VariableDeclarator") collectNames(node.id, declared);
    if (node.type === "CatchClause" && node.param) collectNames(node.param, declared);
    for (const param of node.params ?? []) collectNames(param, declared);
  });

  // รอบสอง: ตรวจกฎ
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
        // global ที่อนุญาต: ใช้ได้เฉพาะเมธอดในบัญชีขาวของตัวนั้น
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

/** ข้อความสรุปสำหรับแสดงให้ผู้ส่งโค้ด */
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

/** identifier ที่เป็น "การอ้างถึงค่า" จริง ๆ (ไม่ใช่ชื่อ property หรือชื่อที่กำลังประกาศ) */
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
