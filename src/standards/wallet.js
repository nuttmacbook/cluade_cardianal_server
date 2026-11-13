/**
 * Program signature verification (similar to ERC-1271) — lets a "program wallet" vouch for signatures on its own behalf
 *
 * Convention (ERC-1271)
 *   isValidSignature({ hash, signature }) → "0x1626ba7e" (ERC1271_MAGIC_VALUE) if the signature is valid · anything else = invalid
 *     hash      = 32-byte "0x…" digest (e.g. the output of eip712Digest / keccak256Bytes in a program)
 *     signature = a string the wallet program interprets itself (WALLET_PROGRAM uses the 65-byte r||s||v of the owner signing that digest directly)
 *   must be read-only: verifiers call it with runProgram(..., { readonly: true }) → cannot write / emit / transfer
 *
 * Other programs that want to accept signatures from both personal wallets (EOA) and program wallets embed SIGNATURE_CHECKER in their code
 * then call isValidSignatureNow(signer, hash, signature) (like OpenZeppelin's SignatureChecker)
 *   signer is a personal wallet   → ecrecoverDigest(hash, signature) === signer
 *   signer is a program      → runProgram(signer, "isValidSignature", { hash, signature }, { readonly: true }) === magic
 * (programs can't import each other, so it is shipped as source to splice in via template string — TOKEN_PROGRAM does this for permit)
 *
 * Wallet side: the WALLET_PROGRAM owner signs the digest directly — for permit that means signing the permit typed data with owner = the program wallet
 * via eth_signTypedData_v4 (signPermit / signWalletHash in src/crypto/program-signature.js produce the same signature)
 * ⚠️ As with ERC-1271 in general: if one person owns several wallets, a signature over the same digest is valid for all of them
 *    — permit is safe because owner is in the message (the digest differs per wallet)
 */

export const ERC1271_MAGIC_VALUE = "0x1626ba7e";
export const ERC1271_INVALID_VALUE = "0xffffffff";
/** hook return values when receiving NFTs / multi-tokens (same as ERC-721 / ERC-1155) */
export const ERC721_RECEIVED = "0x150b7a02";
export const ERC1155_RECEIVED = "0xf23a6e61";
export const ERC1155_BATCH_RECEIVED = "0xbc197c81";

/**
 * Source of isValidSignatureNow(signer, hash, signature) → true / false (never throws)
 * hash = 32-byte "0x…" digest (eip712Digest / keccak256Bytes) · legacy JSON messages must be hashed first (not recommended — MetaMask can't sign them)
 */
export const SIGNATURE_CHECKER = `function isValidSignatureNow(signer, hash, signature) {
    if (typeof signer !== "string" || typeof hash !== "string" || typeof signature !== "string") return false
    try {
      if (IsProgram(signer)) {
        const reply = runProgram(signer, "isValidSignature", { hash: hash, signature: signature }, { readonly: true })
        return reply === "${ERC1271_MAGIC_VALUE}"
      }
      return ecrecoverDigest(hash, signature) === signer.toLowerCase()
    } catch (e) {
      return false
    }
  }`;

export const WALLET_FUNCTIONS = ["isValidSignature"];

/**
 * Example program wallet: a single owner (private key) — input on deploy: { owner? } (omitted = the deployer)
 *   owner()                                   → the owner's address
 *   isValidSignature({ hash, signature })     → magic if the owner signed that (32-byte) digest directly (ecrecoverDigest)
 *   execute({ target, fn, input, value? })    → the owner has the wallet call another program (sender = the wallet), returns the target's result
 *   transferOwnership({ owner })              → change the owner (emits OwnershipTransferred)
 *   onERC721Received / onERC1155Received / onERC1155BatchReceived → can receive NFTs / multi-tokens via safe transfer
 */
export const WALLET_PROGRAM = `function program() {
  function initialization(params) {
    writeDB("owner", params.input.owner || params.context.sender)
  }

  function owner() { return readDB("owner") }

  function onlyOwner(params) {
    if (params.context.sender !== readDB("owner")) throw new Error("only owner")
  }

  function isValidSignature(params) {
    const hash = params.input.hash
    const signature = params.input.signature
    if (typeof hash !== "string" || typeof signature !== "string") return "${ERC1271_INVALID_VALUE}"
    let signer = null
    try { signer = ecrecoverDigest(hash, signature) } catch (e) { signer = null }
    return signer !== null && signer === readDB("owner") ? "${ERC1271_MAGIC_VALUE}" : "${ERC1271_INVALID_VALUE}"
  }

  function execute(params) {
    onlyOwner(params)
    const value = params.input.value || 0n
    return runProgram(params.input.target, params.input.fn, params.input.input || {}, value > 0n ? { value: value } : {})
  }

  function transferOwnership(params) {
    onlyOwner(params)
    if (typeof params.input.owner !== "string" || params.input.owner.length !== 42) throw new Error("owner must be an address")
    emit("OwnershipTransferred", { previousOwner: readDB("owner"), newOwner: params.input.owner }, { indexed: ["previousOwner", "newOwner"] })
    writeDB("owner", params.input.owner)
    return true
  }

  function onERC721Received() { return "${ERC721_RECEIVED}" }
  function onERC1155Received() { return "${ERC1155_RECEIVED}" }
  function onERC1155BatchReceived() { return "${ERC1155_BATCH_RECEIVED}" }

  return { owner, isValidSignature, execute, transferOwnership, onERC721Received, onERC1155Received, onERC1155BatchReceived }
}`;
