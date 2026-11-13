/**
 * Code snippets shared by the system programs (inserted into function program() { … } via template string)
 *   SET_METADATA  → setProgramMetadata(input): set namespace / icon / url / contact / description from input during initialization
 *   CHECK_ADDRESS → checkAddress(address, label): check it is a 0x + 40-char address, then return it lowercased
 */
/** Set the program's metadata from input during initialization (can only be set from code) */
export const SET_METADATA = `function setProgramMetadata(input) {
    if (typeof input.namespace === "string" && input.namespace !== "") setMetadata("namespace", input.namespace)
    if (typeof input.icon === "string" && input.icon !== "") setMetadata("icon", input.icon)
    if (typeof input.url === "string" && input.url !== "") setMetadata("url", input.url)
    if (typeof input.contact === "string" && input.contact !== "") setMetadata("contact", input.contact)
    if (typeof input.description === "string" && input.description !== "") setMetadata("description", input.description)
  }`;

export const CHECK_ADDRESS = `function checkAddress(address, label) {
    // 0x + 40 hex characters only (anything else is a key nobody can sign for → whatever is sent there is lost forever)
    if (typeof address !== "string" || address.length !== 42 || !address.startsWith("0x")) throw new Error(label + " must be an address")
    const lower = address.toLowerCase()
    for (let i = 2; i < 42; i++) if (!"0123456789abcdef".includes(lower.charAt(i))) throw new Error(label + " must be an address")
    return lower
  }`;

