/* explorerscan/ui/tabs/metadata.js [แก้ได้ · หน้าตา]
   แท็บแก้ metadata ของ address ตัวเอง (ชื่อ, ไอคอน, ลิงก์) · เซ็นด้วยกระเป๋า */

// ---------- edit metadata (signed by the wallet) ----------
//   only the connected wallet's own address can be edited (the VM always uses the signer as the address)
//   programs have no edit tab: their metadata is set from code (setMetadata), e.g. icon / url passed to a token at deploy
const META_FIELDS = [
  ["icon", "Icon (image link https:// · data:image · or an emoji)", "https://…/logo.png"],
  ["namespace", "Namespace (must be unique)", "mytoken"],
  ["description", "Description", ""],
  ["url", "URL (website)", "https://…"],
  ["contact", "Contact (email / contact link)", "team@example.com or https://t.me/…"],
];
let metaSource = {};

function metaPanel(data) {
  metaSource = data.metadata ?? {};
  const isOwner = wallet === data.address;
  return `<div class="pad"><div class="metaform">
      <div id="meta-preview">${avatar(metaSource, true)}</div>
      <div class="form">
        <div class="row">${wallet ? `<span class="tag ${isOwner ? "ok" : "bad"}">${isOwner ? "You can edit" : "This wallet cannot edit"}</span> ${addr(wallet)}`
          : '<button class="btn solid" onclick="connect().catch((e) => alert(e.message))">Connect wallet</button>'}
          <span class="dim">Only the owner of this address (the signing wallet) can edit · clearing a field removes it</span></div>
        ${META_FIELDS.map(([field, label, hint]) => `<label>${label}<input id="meta-${field}" value="${attr(metaSource[field] ?? "")}" placeholder="${attr(hint)}"
          spellcheck="false" ${field === "icon" ? 'oninput="previewIcon()"' : ""}></label>`).join("")}
        <div class="row"><button class="btn solid" onclick="saveMeta('${data.address}')">Save (send transaction)</button></div>
        <div class="out" id="meta-out">Not saved yet</div>
      </div></div></div>`;
}

function previewIcon() {
  const icon = document.getElementById("meta-icon").value.trim();
  document.getElementById("meta-preview").innerHTML = avatar({ ...metaSource, icon }, true);
}

/** send only changed fields · a cleared field = null (removed) */
function metaChanges() {
  const changes = {};
  for (const [field] of META_FIELDS) {
    const value = document.getElementById(`meta-${field}`).value.trim();
    const before = metaSource[field] ?? "";
    if (value === String(before)) continue;
    changes[field] = value === "" ? null : value;
  }
  return changes;
}

async function saveMeta(address) {
  const out = (v) => { document.getElementById("meta-out").innerHTML = typeof v === "string" ? esc(v) : jsonHtml(v); };
  try {
    const changes = metaChanges();
    if (!Object.keys(changes).length) return out("Nothing changed");
    if (changes.icon && !isImage(changes.icon) && [...changes.icon].length > 2) return out("Icon must be an https:// image link, a data:image/… URI, or one emoji");
    for (const field of ["url", "contact"]) if (changes[field] && !safeHref(changes[field])) return out(`${field} must be an https://, mailto: or tel: link, or an email address`);
    if (!wallet) await connect(false);
    if (wallet !== address) return out("You can only set metadata for the connected wallet's own address");
    out("Waiting for the wallet signature…");
    const result = await sendTx({ action: "metadata", input: changes });
    out(result);
    if (result.queued) setTimeout(() => go(`#tx/${result.hash}`), 2500);
  } catch (error) { out(`Error: ${error.message}`); }
}
