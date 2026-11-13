/* explorerscan/ui/code.js [editable · look]
   Program source viewer: JavaScript syntax colors like VS Code (Dark+) + line numbers · colors are in theme/style.css (.code .c-…)
   no dependencies · a token never breaks the page: anything unknown is shown as plain text */

/** stored program code (one line, JSON-escaped) → source text · plain text is returned as is */
const sourceOf = (code) => { try { return JSON.parse(`"${code}"`); } catch { return String(code ?? ""); } };

// ---------- JavaScript tokenizer ----------
const CODE_CONTROL = new Set(["if", "else", "for", "while", "do", "return", "break", "continue", "switch", "case", "default", "throw", "try",
  "catch", "finally", "new", "delete", "in", "of", "instanceof", "typeof", "void", "await", "yield", "import", "export", "from", "as"]);
const CODE_KEYWORD = new Set(["const", "let", "var", "function", "class", "extends", "this", "super", "null", "undefined", "true", "false",
  "async", "static", "get", "set", "NaN", "Infinity"]);
const CODE_TYPE = new Set(["BigInt", "Math", "JSON", "Object", "Array", "Number", "String", "Boolean", "Error", "TypeError", "RangeError",
  "Map", "Set", "Date", "Symbol", "Promise", "Uint8Array", "RegExp"]);
// after these, "/" starts a regex literal (not division)
const CODE_REGEX_AFTER = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await"]);

/** source → [{ c: class | "", t: text }] · template literals nest (`a ${ `b ${c}` }`) · brackets get a depth class like VS Code */
function codeTokens(src) {
  const out = [];
  const push = (c, t) => { if (t) out.push({ c, t }); };
  const stack = [];          // "{" / "(" / "[" for brackets · "${" for a template expression
  let i = 0, prev = null;    // prev = last significant token (decides regex vs division, property names)
  const n = src.length;
  const isId = (ch) => /[\w$À-￿]/.test(ch);

  // reads template text from i up to ` or ${ · returns true when the template closed
  const template = (start = i) => {
    while (i < n) {
      if (src[i] === "\\") { i += 2; continue; }
      if (src[i] === "`") { push("c-str", src.slice(start, ++i)); return true; }
      if (src[i] === "$" && src[i + 1] === "{") {
        push("c-str", src.slice(start, i)); push("c-tpl", "${"); i += 2; stack.push("${"); return false;
      }
      i++;
    }
    push("c-str", src.slice(start)); return true;
  };

  while (i < n) {
    const ch = src[i], next = src[i + 1];
    // whitespace
    if (/\s/.test(ch)) { let j = i; while (j < n && /\s/.test(src[j])) j++; push("", src.slice(i, j)); i = j; continue; }
    // comments
    if (ch === "/" && next === "/") { let j = src.indexOf("\n", i); if (j < 0) j = n; push("c-com", src.slice(i, j)); i = j; continue; }
    if (ch === "/" && next === "*") { let j = src.indexOf("*/", i + 2); j = j < 0 ? n : j + 2; push("c-com", src.slice(i, j)); i = j; continue; }
    // strings
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n && src[j] !== ch && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      push("c-str", src.slice(i, Math.min(j + 1, n))); i = j + 1; prev = { c: "c-str", t: ch }; continue;
    }
    if (ch === "`") { i++; template(i - 1); prev = { c: "c-str", t: "`" }; continue; }
    // regex literal: "/" where a value is expected
    if (ch === "/" && (!prev || (prev.c === "c-op" && !/[)\]}]$/.test(prev.t)) || CODE_REGEX_AFTER.has(prev.t) || /^[([{]$/.test(prev.t) || prev.c === "c-tpl")) {
      let j = i + 1, cls = false;
      while (j < n && src[j] !== "\n" && (cls || src[j] !== "/")) { if (src[j] === "\\") j++; else if (src[j] === "[") cls = true; else if (src[j] === "]") cls = false; j++; }
      if (src[j] === "/") {
        j++; while (j < n && /[a-z]/.test(src[j])) j++;
        push("c-re", src.slice(i, j)); i = j; prev = { c: "c-re", t: "/" }; continue;
      }
    }
    // numbers: 12 · 1_000 · 0xff · 1.5e3 · 10n
    if (/\d/.test(ch) || (ch === "." && /\d/.test(next ?? ""))) {
      const m = /^(?:0[xXoObB][\da-fA-F_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?|\.\d[\d_]*(?:[eE][+-]?\d+)?)n?/.exec(src.slice(i, i + 80));
      const t = m ? m[0] : ch; push("c-num", t); i += t.length; prev = { c: "c-num", t }; continue;
    }
    // identifiers / keywords
    if (isId(ch)) {
      let j = i; while (j < n && isId(src[j])) j++;
      const t = src.slice(i, j);
      let k = j; while (k < n && /[ \t]/.test(src[k])) k++;
      const afterDot = prev && prev.t === "." || prev && prev.t === "?.";
      const c = afterDot ? (src[k] === "(" ? "c-fn" : "c-prop")
        : CODE_CONTROL.has(t) ? "c-ctl" : CODE_KEYWORD.has(t) ? "c-kw" : CODE_TYPE.has(t) ? "c-type"
        : src[k] === "(" || (prev && prev.t === "function") ? "c-fn" : /^[A-Z][A-Z0-9_]+$/.test(t) ? "c-const" : /^[A-Z]/.test(t) ? "c-type" : "c-var";
      push(c, t); i = j; prev = { c, t }; continue;
    }
    // brackets: colored by nesting depth · "}" may close a template expression
    if ("([{".includes(ch)) { push(`c-br${stack.filter((s) => s !== "${").length % 3}`, ch); stack.push(ch); i++; prev = { c: "c-op", t: ch }; continue; }
    if (")]}".includes(ch)) {
      if (ch === "}" && stack.at(-1) === "${") { stack.pop(); push("c-tpl", "}"); i++; template(); prev = { c: "c-str", t: "`" }; continue; }
      stack.pop(); push(`c-br${stack.filter((s) => s !== "${").length % 3}`, ch); i++; prev = { c: "c-op", t: ch }; continue;
    }
    // operators / punctuation (longest first)
    const op = /^(?:\?\.|=>|\.\.\.|[=!]==?|[<>]=?|&&=?|\|\|=?|\?\?=?|\*\*=?|<<=?|>>>?=?|[-+*/%&|^]=?|\+\+|--|[.,;:?~!])/.exec(src.slice(i, i + 4));
    const t = op ? op[0] : ch;
    push(op ? "c-op" : "", t); i += t.length; prev = { c: "c-op", t };
  }
  return out;
}

/** source → HTML lines (a token that spans lines, like a block comment, is closed and reopened on each line) */
function codeLines(src) {
  const lines = [""];
  for (const { c, t } of codeTokens(String(src ?? "").replace(/\r\n?/g, "\n"))) {
    t.split("\n").forEach((part, k) => {
      if (k > 0) lines.push("");
      if (part) lines[lines.length - 1] += c ? `<span class="${c}">${esc(part)}</span>` : esc(part);
    });
  }
  return lines;
}

/** colored source box with line numbers · id = optional element id · max = optional max height (CSS) */
function codeView(src, { id = "", max = "" } = {}) {
  const lines = codeLines(src);
  const width = String(lines.length).length;
  return `<pre class="code"${id ? ` id="${id}"` : ""} style="--ln:${width}ch${max ? `;max-height:${max}` : ""}"><code>${
    lines.map((line) => `<span class="line">${line || " "}</span>`).join("\n")}</code></pre>`;
}
