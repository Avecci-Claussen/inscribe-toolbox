/**
 * Streamlined inscribe library — commit/reveal, files, BRC-20 deploy/mint (up to 1000), rune mint, ordinals tools.
 * No stablecoin, no CAT. Use from app25 (globals) or standalone (dynamic import).
 */
'use strict';

const crypto = typeof require !== 'undefined' ? require('crypto') : null;
const MIN_INSCRIPTION_VALUE = 330;
const MIN_RELAY_FEE_RATE = 1;
const BRC20_MINT_MAX = 1000;

let btc, ordinals, hex, customScripts;
let Runestone, RuneId, none, some;

async function ensureGlobals() {
  if (global.btc && global.ordinals && global.hex) {
    btc = global.btc;
    ordinals = global.ordinals;
    hex = global.hex;
    customScripts = global.customScripts || [ordinals.OutOrdinalReveal];
    if (global.Runestone) {
      Runestone = global.Runestone;
      RuneId = global.RuneId;
      none = global.none || (() => null);
      some = global.some || (v => v);
    }
    return;
  }
  const base = await import('@scure/base');
  hex = base.hex;
  btc = await import('@scure/btc-signer');
  ordinals = await import('micro-ordinals');
  customScripts = [ordinals.OutOrdinalReveal];
  global.btc = btc;
  global.ordinals = ordinals;
  global.hex = hex;
  global.customScripts = customScripts;
  try {
    const runelib = await import('runelib');
    Runestone = runelib.Runestone;
    RuneId = runelib.RuneId;
    none = runelib.none;
    some = runelib.some;
    global.Runestone = Runestone;
    global.RuneId = RuneId;
    global.none = none;
    global.some = some;
  } catch (_) {
    Runestone = null;
    RuneId = null;
    none = () => null;
    some = v => v;
  }
}

// ─── Content helpers ───────────────────────────────────────────────────────

// Only decode as base64 when the string looks like base64; otherwise JSON/plain text stays UTF-8.
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeFileContent(str) {
  if (typeof str === 'undefined' || str === null) return new Uint8Array(0);
  if (Buffer.isBuffer(str)) return new Uint8Array(str);
  if (str instanceof Uint8Array) return str;
  const s = String(str);
  if (/^[0-9A-Fa-f]+$/.test(s) && s.length % 2 === 0) {
    return hex.decode(s);
  }
  if (BASE64_RE.test(s) && s.length >= 4) {
    try {
      return new Uint8Array(Buffer.from(s, 'base64'));
    } catch (_) {}
  }
  return new Uint8Array(Buffer.from(s, 'utf8'));
}

function encodeFileContent(buf) {
  if (buf instanceof Uint8Array) return Buffer.from(buf).toString('base64');
  return Buffer.from(buf).toString('base64');
}

function buildInscriptionPayload(file) {
  const contentType = (file && file.contentType) ? file.contentType : 'application/octet-stream';
  let body = decodeFileContent(file && file.content);
  const tags = { contentType };
  if (file && file.parent != null) {
    const p = file.parent;
    tags.parent = Array.isArray(p) ? p : [p];
  }
  if (file && file.contentEncoding) tags.contentEncoding = file.contentEncoding;
  if (file && file.compress && body.length > 0) {
    body = new Uint8Array(compressGzip(body));
    tags.contentEncoding = CONTENT_ENCODING_GZIP;
  }
  if (file && file.metaprotocol) tags.metaprotocol = file.metaprotocol;
  return { tags, body };
}

function normalizeInscriptionForReveal(inscription) {
  const contentType = inscription.tags?.contentType ?? inscription.contentType ?? 'application/octet-stream';
  let body = inscription.body;
  if (typeof body === 'string') body = Buffer.from(body, 'base64');
  if (body && !(body instanceof Uint8Array) && !Buffer.isBuffer(body)) body = new Uint8Array(body);
  return { tags: { contentType }, body: body ? new Uint8Array(body) : new Uint8Array(0) };
}

// ─── BRC-20 (text/plain JSON) ──────────────────────────────────────────────

function brc20Deploy(tick, max, lim, dec, selfMint = false) {
  const payload = { p: 'brc-20', op: 'deploy', tick, max: String(max) };
  if (lim != null) payload.lim = String(lim);
  if (dec != null) payload.dec = String(dec);
  if (selfMint) payload.self_mint = 'true';
  return JSON.stringify(payload);
}

function brc20Mint(tick, amt) {
  return JSON.stringify({ p: 'brc-20', op: 'mint', tick, amt: String(amt) });
}

function brc20Transfer(tick, amt) {
  return JSON.stringify({ p: 'brc-20', op: 'transfer', tick, amt: String(amt) });
}

// BP07 single-step transfer: script prefix is OP_32 pubkey OP_CHECKSIGVERIFY OP_N (N=1..8 address type).
// Active on Fractal Bitcoin (FB); not active on Bitcoin (BTC) mainnet.
// Spec: https://github.com/unisat-wallet/brc20-proposals/tree/main/bp07-single-step-transfer
const BP07_ADDRESS_TYPE = {
  P2TR_SCRIPTLESS: 1,
  P2WPKH_EVEN: 2,
  P2WPKH_ODD: 3,
  P2PKH_EVEN: 4,
  P2PKH_ODD: 5,
  P2SH_P2WPKH_EVEN: 6,
  P2SH_P2WPKH_ODD: 7,
  P2TR_KEYPATH: 8,
};

function buildBp07TransferScript(ordinals, pubKey, addressType, inscription) {
  if (addressType < 1 || addressType > 8) throw new Error('BP07 addressType must be 1..8');
  const standard = ordinals.p2tr_ord_reveal(pubKey, [inscription]);
  const script = standard.script;
  const arr = script instanceof Uint8Array ? script : new Uint8Array(script);
  let xOnlyPubkey; // 32-byte for CHECKSIGVERIFY
  let restStart;
  if (arr.length >= 36 && arr[0] === 0x21) {
    // micro-ordinals: OP_PUSHDATA_33 (0x21) + 33-byte pubkey + rest
    xOnlyPubkey = arr[1] === 0x02 || arr[1] === 0x03 ? arr.subarray(2, 34) : arr.subarray(1, 33);
    restStart = 34;
  } else if (arr.length >= 35 && arr[0] === 0x20) {
    // 0x20 (OP_32) + 32-byte pubkey + 0xac + ...
    xOnlyPubkey = arr.subarray(1, 33);
    restStart = 34;
  } else if (arr.length >= 35 && arr[0] === 0x51 && arr[1] === 0x20) {
    // OP_1 OP_PUSHDATA_32 + 32-byte + ...
    xOnlyPubkey = arr.subarray(2, 34);
    restStart = 34;
  } else {
    throw new Error('Unexpected ord script format (expected 0x20/0x21/0x51 0x20 + pubkey)');
  }
  const bp07 = new Uint8Array(1 + 32 + 2 + (arr.length - restStart));
  bp07[0] = 0x20;
  bp07.set(xOnlyPubkey, 1);
  bp07[33] = 0xad; // OP_CHECKSIGVERIFY
  bp07[34] = (addressType >= 1 && addressType <= 16) ? (0x50 + addressType) : (addressType & 0xff);
  bp07.set(arr.subarray(restStart), 35);
  return bp07;
}

function brc20MintBatch(tick, amt, count) {
  if (count > BRC20_MINT_MAX) throw new Error(`count must be ≤ ${BRC20_MINT_MAX}`);
  const payload = brc20Mint(tick, amt);
  return Array(count).fill({ content: payload, contentType: 'text/plain;charset=utf-8' });
}

// ─── Commit addresses (one per inscription) ────────────────────────────────

async function getCommitAddresses(files, pubKey, options = {}) {
  await ensureGlobals();
  const mainnet = options.mainnet !== false;
  const minValue = options.minInscriptionValue ?? MIN_INSCRIPTION_VALUE;
  // requiredAmount = what must land on commit UTXO to pay for the *reveal* tx (inscription out + fee).
  // Use reveal fee rate so we don't over-fund and leave excess in the tap wallet after reveal.
  const revealFeeRate = options.revealFeeRate ?? 2;
  const revealFeeBuffer = options.revealFeeBuffer ?? 1.05;
  const devFeeTotal = options.devFeeTotal ?? 0;
  const privKey = options.privKey != null
    ? (typeof options.privKey === 'string' ? hex.decode(options.privKey) : options.privKey)
    : null;

  const inscriptionData = [];
  const commitAddresses = [];
  const network = mainnet ? undefined : btc.NETWORKS.testnet;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const fileOpt = (options.compress || file.compress) ? { ...file, compress: true } : file;
    const inscription = buildInscriptionPayload(fileOpt);
    const singleStep = file.singleStepTransfer && (file.addressType != null || file.singleStepAddressType != null);
    const addressType = (file.addressType ?? file.singleStepAddressType ?? 1) | 0;
    if (singleStep && (addressType < 1 || addressType > 8)) throw new Error('BP07 addressType must be 1..8');

    let revealPayment;
    let bp07Script;
    if (singleStep) {
      bp07Script = buildBp07TransferScript(ordinals, pubKey, addressType, inscription);
      const tree = { leafVersion: 0xc0, script: bp07Script };
      const pubKeyBytes = typeof pubKey === 'string' ? hex.decode(pubKey) : (pubKey instanceof Uint8Array ? pubKey : new Uint8Array(pubKey));
      const internalKey = pubKeyBytes.length === 32 ? pubKeyBytes : pubKeyBytes.slice(1, 33);
      revealPayment = btc.p2tr(internalKey, tree, network, true);
      inscriptionData.push(inscription);
    } else {
      inscriptionData.push(inscription);
      const revealScript = ordinals.p2tr_ord_reveal(pubKey, [inscription]);
      revealPayment = btc.p2tr(undefined, revealScript, network, false, customScripts);
    }

    const dummy = new btc.Transaction({ customScripts });
    dummy.addInput({
      ...revealPayment,
      txid: '00'.repeat(32),
      index: 0,
      witnessUtxo: { script: revealPayment.script, amount: 1_000_000n },
    });
    dummy.addOutputAddress(revealPayment.address, BigInt(minValue), network);
    if (i === files.length - 1 && devFeeTotal > 0) {
      const devAddresses = options.devFeeAddresses || [];
      for (const a of devAddresses) dummy.addOutputAddress(a, BigInt(Math.floor(devFeeTotal / devAddresses.length)), network);
    }
    let vsize;
    if (privKey && privKey.length === 32) {
      dummy.sign(privKey, undefined, new Uint8Array(32));
      dummy.finalize();
      vsize = dummy.vsize;
    } else {
      vsize = options.estimatedVsize ?? 250;
    }
    const estimatedFee = Math.max(
      Math.ceil(revealFeeRate * vsize * revealFeeBuffer),
      vsize * MIN_RELAY_FEE_RATE
    );
    const requiredAmount = minValue + estimatedFee + (i === files.length - 1 ? devFeeTotal : 0);

    const rec = {
      address: revealPayment.address,
      tapScript: hex.encode(revealPayment.script),
      pubKey: typeof pubKey === 'string' ? pubKey : hex.encode(pubKey),
      vsize,
      estimatedFee: String(estimatedFee),
      requiredAmount: String(requiredAmount),
    };
    if (singleStep) {
      rec.singleStepScriptHex = hex.encode(bp07Script);
      rec.singleStepAddressType = addressType;
    }
    commitAddresses.push(rec);
  }

  return { commitAddresses, inscriptionData };
}

// Normalize inscription for micro-ordinals (tags + body as Uint8Array). Preserves parent, contentEncoding, metaprotocol.
function normalizeInscription(inscription) {
  const tags = inscription.tags || {};
  const contentType = tags.contentType ?? inscription.contentType ?? 'application/octet-stream';
  const outTags = { contentType };
  if (tags.parent != null) outTags.parent = Array.isArray(tags.parent) ? tags.parent : [tags.parent];
  if (tags.contentEncoding) outTags.contentEncoding = tags.contentEncoding;
  if (tags.metaprotocol) outTags.metaprotocol = tags.metaprotocol;
  let body = inscription.body;
  if (typeof body === 'string') body = Buffer.from(body, 'base64');
  if (body == null) body = new Uint8Array(0);
  if (!(body instanceof Uint8Array)) body = new Uint8Array(body);
  return { tags: outTags, body: new Uint8Array(body) };
}

// BP07 single-step reveal: taproot script-path spend with bitcoinjs (CHECKSIGVERIFY script).
function buildBp07RevealTx(commitUtxo, scriptHex, pubKey, privKey, toAddress, options = {}) {
  const bitcoin = require('bitcoinjs-lib');
  const ecc = require('@bitcoinerlab/secp256k1');
  bitcoin.initEccLib(ecc);
  const network = (options.mainnet !== false) ? bitcoin.networks.bitcoin : bitcoin.networks.testnet;
  const minValue = options.minInscriptionValue ?? MIN_INSCRIPTION_VALUE;
  const feeRate = options.feeRate ?? 2;
  const scriptBuf = Buffer.from(scriptHex, 'hex');
  const pubKeyBuf = Buffer.isBuffer(pubKey) ? pubKey : Buffer.from(pubKey, 'hex');
  const internalPubkey = pubKeyBuf.length === 32 ? pubKeyBuf : bitcoin.toXOnly(pubKeyBuf);
  const tapleaf = { output: scriptBuf, version: 0xc0 };
  const payment = bitcoin.payments.p2tr({
    internalPubkey,
    scriptTree: tapleaf,
    redeem: { output: scriptBuf, redeemVersion: 0xc0 },
    network,
  });
  if (!payment.witness || payment.witness.length < 2) throw new Error('BP07: could not build witness (control block)');
  const controlBlock = payment.witness[payment.witness.length - 1];
  const psbt = new bitcoin.Psbt({ network });
  const inputAmount = Number(commitUtxo.value ?? commitUtxo.satoshi ?? 0);
  const scriptOut = Buffer.isBuffer(payment.output) ? payment.output : Buffer.from(payment.output);
  psbt.addInput({
    hash: Buffer.from(commitUtxo.txid, 'hex').reverse(),
    index: commitUtxo.vout ?? commitUtxo.index ?? 0,
    witnessUtxo: { script: scriptOut, value: BigInt(inputAmount) },
    tapLeafScript: [{ leafVersion: 0xc0, script: scriptBuf, controlBlock }],
  });
  const outVal = Number(minValue);
  if (outVal <= 0) throw new Error('BP07: minInscriptionValue must be positive');
  psbt.addOutput({
    address: toAddress,
    value: BigInt(outVal),
  });
  const fee = Math.max(150 * feeRate, 18);
  let change = Math.floor(inputAmount - outVal - fee);
  if (change >= 546 && payment.address) {
    psbt.addOutput({ address: payment.address, value: BigInt(change) });
  }
  const ECPairFactory = require('ecpair');
  const ECPair = (ECPairFactory.default || ECPairFactory)(ecc);
  const privBuf = Buffer.isBuffer(privKey) ? privKey : Buffer.from(privKey, 'hex');
  const keyPair = ECPair.fromPrivateKey(privBuf, { network });
  psbt.signInput(0, keyPair);
  psbt.finalizeAllInputs();
  const tx = psbt.extractTransaction();
  const rawHex = tx.toHex();
  const txid = tx.getId();
  return { rawTxHex: rawHex, txid };
}

// ─── Reveal tx (single: one commit UTXO → one reveal) ─────────────────────
// Matches app25: use global.btc/ordinals when set; tree as leaf with leafVersion + script.

async function buildRevealTx(commitUtxo, inscription, pubKey, privKey, toAddress, options = {}) {
  if (options.singleStepScriptHex) {
    return buildBp07RevealTx(commitUtxo, options.singleStepScriptHex, pubKey, privKey, toAddress, options);
  }
  await ensureGlobals();
  const btcLib = global.btc || btc;
  const ordLib = global.ordinals || ordinals;
  const scripts = global.customScripts || customScripts;
  const mainnet = options.mainnet !== false;
  const minValue = options.minInscriptionValue ?? MIN_INSCRIPTION_VALUE;
  const devFeeAmount = options.devFeeAmount ?? 0;
  const devFeeAddresses = options.devFeeAddresses || [];
  const runeData = options.runeData || null;
  const network = mainnet ? undefined : btcLib.NETWORKS.testnet;

  const ins = normalizeInscription(inscription);
  const rev = ordLib.p2tr_ord_reveal(pubKey, [ins]);
  if (!rev || rev.script == null) throw new Error('p2tr_ord_reveal returned no script; check inscription (tags.contentType, body as bytes)');
  const leafScript = new Uint8Array(rev.script);
  const tree = { leafVersion: 0xc0, script: leafScript };
  const revealPayment = btcLib.p2tr(undefined, tree, network, false, scripts);

  const tx = new btcLib.Transaction({ customScripts: scripts });
  const inputAmount = BigInt(commitUtxo.value || commitUtxo.satoshi || 0);
  tx.addInput({
    ...revealPayment,
    txid: commitUtxo.txid,
    index: commitUtxo.vout ?? commitUtxo.index ?? 0,
    witnessUtxo: { script: revealPayment.script, amount: inputAmount },
  });

  tx.addOutputAddress(toAddress, BigInt(minValue), network);

  if (runeData && Runestone && RuneId && runeData.runeId) {
    const parts = String(runeData.runeId).split(':');
    if (parts.length === 2) {
      const block = parseInt(parts[0], 10);
      const txIndex = parseInt(parts[1], 10);
      const pointer = runeData.pointer != null ? runeData.pointer : 0;
      const mintstone = new Runestone(
        [],
        none(),
        some(new RuneId(block, txIndex)),
        some(pointer)
      );
      const runestoneScript = mintstone.encipher();
      tx.addOutput({ script: new Uint8Array(runestoneScript), amount: 0n });
    }
  }

  let totalOut = minValue;
  for (const a of devFeeAddresses) {
    tx.addOutputAddress(a, BigInt(devFeeAmount), network);
    totalOut += devFeeAmount;
  }

  const feeRate = options.feeRate ?? 2;
  const estimatedVsize = 150 + (runeData && Runestone ? 50 : 0);
  const fee = Math.max(estimatedVsize * feeRate, 18);
  let change = Number(inputAmount) - totalOut - fee;
  if (change >= 546) {
    const commitAddr = btcLib.p2tr(undefined, tree, network, false, scripts);
    tx.addOutputAddress(commitAddr.address, BigInt(change), network);
  }

  const priv = typeof privKey === 'string' ? hex.decode(privKey) : privKey;
  const pub = typeof pubKey === 'string' ? hex.decode(pubKey) : pubKey;
  tx.sign(priv, undefined, new Uint8Array(32));
  tx.finalize();

  const raw = tx.extract();
  const rawHex = hex.encode(raw);
  let txid = (raw && (raw.getTxid || raw.id)) ? (typeof raw.id === 'string' ? raw.id : hex.encode(raw.id).match(/.{2}/g).reverse().join('')) : null;
  if (!txid && crypto && crypto.createHash) {
    const buf = Buffer.from(hex.decode(rawHex));
    const h = crypto.createHash('sha256').update(crypto.createHash('sha256').update(buf).digest()).digest();
    txid = h.reverse().toString('hex');
  }

  return { rawTxHex: rawHex, txid: txid || '' };
}

// ─── Rune mint Runestone (for OP_RETURN) ──────────────────────────────────

async function buildRuneMintRunestone(runeId, pointer = 1) {
  await ensureGlobals();
  if (!Runestone || !RuneId) throw new Error('runelib not available');
  const parts = String(runeId).split(':');
  if (parts.length !== 2) throw new Error('runeId must be block:tx');
  const block = parseInt(parts[0], 10);
  const txIndex = parseInt(parts[1], 10);
  const mintstone = new Runestone(
    [],
    none(),
    some(new RuneId(block, txIndex)),
    pointer != null ? some(pointer) : none()
  );
  return mintstone.encipher();
}

// Rune mint commit: key-path-only taproot (no inscription). One address per mint.
const RUNE_MINT_REVEAL_VSIZE = 150;

async function getRuneMintCommitAddresses(count, pubKey, options = {}) {
  await ensureGlobals();
  const mainnet = options.mainnet !== false;
  const feeRate = options.feeRate ?? 6;
  const feeBuffer = options.feeBuffer ?? 1.1;
  const network = mainnet ? undefined : btc.NETWORKS.testnet;
  const commitAddresses = [];
  const minOut = 546;
  const estimatedFee = Math.max(Math.ceil(RUNE_MINT_REVEAL_VSIZE * feeRate * feeBuffer), 250);
  const requiredAmount = minOut + estimatedFee;

  for (let i = 0; i < count; i++) {
    const keyPathOnly = btc.p2tr(pubKey, undefined, network);
    commitAddresses.push({
      address: keyPathOnly.address,
      pubKey: typeof pubKey === 'string' ? pubKey : hex.encode(pubKey),
      vsize: RUNE_MINT_REVEAL_VSIZE,
      estimatedFee: String(estimatedFee),
      requiredAmount: String(requiredAmount),
    });
  }
  return { commitAddresses, totalRequired: String(Number(requiredAmount) * count) };
}

// Build rune mint reveal tx: spend commit UTXO → OP_RETURN runestone + recipient + change.
async function buildRuneMintRevealTx(commitUtxo, runeId, pointer, pubKey, privKey, toAddress, options = {}) {
  await ensureGlobals();
  if (!Runestone || !RuneId) throw new Error('runelib not available');
  const btcLib = global.btc || btc;
  const mainnet = options.mainnet !== false;
  const network = mainnet ? undefined : btcLib.NETWORKS.testnet;
  const feeRate = options.feeRate ?? 2;

  const keyPathOnly = btcLib.p2tr(pubKey, undefined, network);
  const inputAmount = BigInt(commitUtxo.value ?? commitUtxo.satoshi ?? 0);
  const tx = new btcLib.Transaction({ allowUnknownOutputs: true });
  tx.addInput({
    ...keyPathOnly,
    txid: commitUtxo.txid,
    index: commitUtxo.vout ?? commitUtxo.index ?? 0,
    witnessUtxo: { script: keyPathOnly.script, amount: inputAmount },
  });

  const runestoneEncipher = await buildRuneMintRunestone(runeId, pointer);
  tx.addOutput({ script: new Uint8Array(runestoneEncipher), amount: 0n });
  tx.addOutputAddress(toAddress, 546n, network);

  const fee = Math.max(RUNE_MINT_REVEAL_VSIZE * feeRate, 18);
  let change = Number(inputAmount) - 546 - fee;
  if (change >= 546) {
    tx.addOutputAddress(keyPathOnly.address, BigInt(change), network);
  }

  const priv = typeof privKey === 'string' ? hex.decode(privKey) : privKey;
  tx.sign(priv, undefined, new Uint8Array(32));
  tx.finalize();

  const raw = tx.extract();
  const rawHex = hex.encode(raw);
  let txid = (raw && (raw.getTxid || raw.id)) ? (typeof raw.id === 'string' ? raw.id : hex.encode(raw.id).match(/.{2}/g).reverse().join('')) : null;
  if (!txid && crypto && crypto.createHash) {
    const buf = Buffer.from(hex.decode(rawHex));
    const h = crypto.createHash('sha256').update(crypto.createHash('sha256').update(buf).digest()).digest();
    txid = h.reverse().toString('hex');
  }
  return { rawTxHex: rawHex, txid: txid || '' };
}

// ─── Commit PSBT (JS-only: utxos → commit outputs + change) ────────────────

async function createCommitPsbt(utxos, outputs, feeRate, changeAddress, options = {}) {
  let bitcoin, ecc;
  try {
    bitcoin = require('bitcoinjs-lib');
    ecc = require('@bitcoinerlab/secp256k1');
    bitcoin.initEccLib(ecc);
  } catch (e) {
    throw new Error('createCommitPsbt requires bitcoinjs-lib and @bitcoinerlab/secp256k1. Install them or use external create_psbt.');
  }

  const network = (options.mainnet !== false) ? bitcoin.networks.bitcoin : bitcoin.networks.testnet;
  const psbt = new bitcoin.Psbt({ network });

  let totalIn = 0;
  for (const u of utxos) {
    const txid = u.txid || u.txId;
    const vout = u.vout ?? u.index ?? 0;
    const value = Number(u.value ?? u.satoshi ?? 0);
    let script = u.scriptPubKey;
    if (!script) throw new Error('UTXO must have scriptPubKey');
    if (typeof script === 'string') script = Buffer.from(script, 'hex');
    else if (script.type === 'Buffer' && Array.isArray(script.data)) script = Buffer.from(script.data);
    else if (!Buffer.isBuffer(script)) script = Buffer.from(script);
    totalIn += value;
    psbt.addInput({
      hash: Buffer.from(txid, 'hex').reverse(),
      index: vout,
      witnessUtxo: { script, value: BigInt(value) },
    });
  }

  let totalOut = 0;
  for (const o of outputs) {
    const value = Number(o.value ?? o.requiredAmount ?? 0);
    totalOut += value;
    const script = bitcoin.address.toOutputScript(o.address, network);
    psbt.addOutput({ script, value: BigInt(value) });
  }

  const estimatedVsize = 10 + utxos.length * 100 + outputs.length * 43;
  const fee = Math.max(Math.ceil(estimatedVsize * feeRate), 250);
  const changeAmount = totalIn - totalOut - fee;
  if (changeAmount < 0) throw new Error('Insufficient UTXOs for outputs + fee');
  if (changeAmount >= 546 && changeAddress) {
    const changeScript = bitcoin.address.toOutputScript(changeAddress, network);
    psbt.addOutput({ script: changeScript, value: BigInt(changeAmount) });
  }

  return { psbtBase64: psbt.toBase64(), fee, changeAmount: changeAmount >= 546 ? changeAmount : 0 };
}

// ─── OP_RETURN message (simple: one OP_RETURN output + change) ─────────────
// Standard relay: max 80 bytes in OP_RETURN. Message as UTF-8 string or hex.

const OP_RETURN_MAX_BYTES = 80;

function encodeOpReturnMessage(message, maxBytes = OP_RETURN_MAX_BYTES) {
  let data;
  if (typeof message === 'string') {
    if (/^(0x)?[0-9a-fA-F]+$/.test(message.replace(/^0x/, '')) && message.replace(/^0x/, '').length % 2 === 0) {
      data = Buffer.from(message.replace(/^0x/, ''), 'hex');
    } else {
      data = Buffer.from(message, 'utf8');
    }
  } else {
    data = Buffer.isBuffer(message) ? message : Buffer.from(message);
  }
  if (maxBytes > 0 && data.length > maxBytes) throw new Error(`OP_RETURN message max ${maxBytes} bytes (got ${data.length}). Use hex or truncate.`);
  return data;
}

function buildOpReturnTx(utxos, message, changeAddress, options = {}) {
  let bitcoin, ecc;
  try {
    bitcoin = require('bitcoinjs-lib');
    ecc = require('@bitcoinerlab/secp256k1');
    bitcoin.initEccLib(ecc);
  } catch (e) {
    throw new Error('buildOpReturnTx requires bitcoinjs-lib and @bitcoinerlab/secp256k1.');
  }
  const network = (options.mainnet !== false) ? bitcoin.networks.bitcoin : bitcoin.networks.testnet;
  const feeRate = options.feeRate ?? 2;
  const maxOpReturn = options.maxOpReturnBytes ?? OP_RETURN_MAX_BYTES;
  const data = encodeOpReturnMessage(message, maxOpReturn);
  const opReturnScript = bitcoin.script.compile([bitcoin.opcodes.OP_RETURN, data]);
  const psbt = new bitcoin.Psbt({ network });
  let totalIn = 0;
  for (const u of utxos) {
    const txid = u.txid || u.txId;
    const vout = u.vout ?? u.index ?? 0;
    const value = Number(u.value ?? u.satoshi ?? 0);
    let script = u.scriptPubKey;
    if (!script) throw new Error('UTXO must have scriptPubKey');
    if (typeof script === 'string') script = Buffer.from(script, 'hex');
    else if (!Buffer.isBuffer(script)) script = Buffer.from(script);
    totalIn += value;
    psbt.addInput({
      hash: Buffer.from(txid, 'hex').reverse(),
      index: vout,
      witnessUtxo: { script, value: BigInt(value) },
    });
  }
  psbt.addOutput({ script: opReturnScript, value: BigInt(0) });
  const vsize = 10 + utxos.length * 100 + 43 + (changeAddress ? 43 : 0);
  const fee = Math.max(Math.ceil(vsize * feeRate), 250);
  const changeAmount = totalIn - fee;
  if (changeAmount < 0) throw new Error('Insufficient UTXOs for fee');
  if (changeAmount >= 546 && changeAddress) {
    const changeScript = bitcoin.address.toOutputScript(changeAddress, network);
    psbt.addOutput({ script: changeScript, value: BigInt(changeAmount) });
  }
  return { psbt, fee, changeAmount, opReturnScript };
}

async function buildSignedOpReturnTx(utxos, message, changeAddress, wif, options = {}) {
  const { psbt } = buildOpReturnTx(utxos, message, changeAddress, options);
  let bitcoin, ecc;
  try {
    bitcoin = require('bitcoinjs-lib');
    ecc = require('@bitcoinerlab/secp256k1');
    bitcoin.initEccLib(ecc);
  } catch (e) {
    throw new Error('buildSignedOpReturnTx requires bitcoinjs-lib and @bitcoinerlab/secp256k1.');
  }
  const network = (options.mainnet !== false) ? bitcoin.networks.bitcoin : bitcoin.networks.testnet;
  const ECPairFactory = require('ecpair');
  const ECPair = (ECPairFactory.default || ECPairFactory)(ecc);
  const keyPair = ECPair.fromWIF(wif, network);
  for (let i = 0; i < utxos.length; i++) {
    psbt.signInput(i, keyPair);
  }
  psbt.finalizeAllInputs();
  const tx = psbt.extractTransaction();
  return { rawTxHex: tx.toHex(), txid: tx.getId() };
}

// ─── Parent–child (placeholder) ────────────────────────────────────────────

function parseInscriptionId(inscriptionId) {
  const s = String(inscriptionId);
  const i = s.lastIndexOf('i');
  if (i === -1) return null;
  const txid = s.slice(0, i);
  const index = parseInt(s.slice(i + 1), 10);
  if (isNaN(index)) return null;
  return { txid, index };
}

// buildInscriptionPayloadWithParent: when micro-ordinals supports parent, add metadata here.
function buildInscriptionPayloadWithParent(file, parentOutpoint) {
  const payload = buildInscriptionPayload(file);
  if (parentOutpoint && ordinals && typeof ordinals.buildInscription === 'function') {
    // If your ordinals lib supports parent, set payload.metadata or payload.parent
  }
  return payload;
}

// ─── Rune etch (commit address + reveal) ───────────────────────────────────

async function getEtchCommitAddress(etchParams, pubKey, options = {}) {
  let EtchInscription;
  try {
    const runelib = await import('runelib');
    EtchInscription = runelib.EtchInscription;
  } catch (_) {
    throw new Error('runelib required for etch');
  }
  const bitcoin = require('bitcoinjs-lib');
  const ecc = require('@bitcoinerlab/secp256k1');
  bitcoin.initEccLib(ecc);
  const mainnet = options.mainnet !== false;
  const network = mainnet ? bitcoin.networks.bitcoin : bitcoin.networks.testnet;
  const runeName = etchParams.rune || etchParams.name;
  if (!runeName) throw new Error('etch requires rune name');
  const ins = new EtchInscription();
  ins.setRune(runeName);
  const contentType = etchParams.contentType || 'text/plain';
  const body = etchParams.body != null
    ? (Buffer.isBuffer(etchParams.body) ? etchParams.body : Buffer.from(etchParams.body))
    : Buffer.from(etchParams.content || '', 'utf8');
  ins.setContent(contentType, body);
  const encipher = Buffer.from(ins.encipher());
  const pub = typeof pubKey === 'string' ? Buffer.from(pubKey, 'hex') : Buffer.from(pubKey);
  if (pub.length !== 32) throw new Error('pubKey must be 32-byte x-only');
  const scriptAsm = pub.toString('hex') + ' OP_CHECKSIG';
  const etchingScript = Buffer.concat([
    bitcoin.script.fromASM(scriptAsm),
    encipher,
  ]);
  const scriptTree = { output: etchingScript };
  const payment = bitcoin.payments.p2tr({
    internalPubkey: pub,
    scriptTree,
    network,
  });
  const address = payment.address;
  if (!address) throw new Error('Failed to derive etch commit address');
  const estimatedVsize = 200;
  const feeRate = options.feeRate ?? 6;
  const requiredAmount = 546 + Math.max(Math.ceil(estimatedVsize * feeRate * 1.1), 250);
  return {
    address,
    scriptHex: etchingScript.toString('hex'),
    runeName,
    requiredAmount: String(requiredAmount),
    vsize: estimatedVsize,
  };
}

// Build rune etch reveal tx: spend commit UTXO (taproot script path) + OP_RETURN Runestone(etching).
async function buildEtchRevealTx(commitUtxo, etchParams, scriptHex, pubKey, privKey, options = {}) {
  const runelib = await import('runelib');
  const { Runestone, RuneId } = runelib;
  const bitcoin = require('bitcoinjs-lib');
  const ecc = require('@bitcoinerlab/secp256k1');
  bitcoin.initEccLib(ecc);
  const network = (options.mainnet !== false) ? bitcoin.networks.bitcoin : bitcoin.networks.testnet;
  const feeRate = options.feeRate ?? 2;
  const scriptBuf = Buffer.from(scriptHex, 'hex');
  const pubBuf = Buffer.isBuffer(pubKey) ? pubKey : Buffer.from(pubKey, 'hex');
  const internalPubkey = pubBuf.length === 32 ? pubBuf : (bitcoin.toXOnly ? bitcoin.toXOnly(pubBuf) : pubBuf.slice(1, 33));
  const tapleaf = { output: scriptBuf, version: 0xc0 };
  const payment = bitcoin.payments.p2tr({
    internalPubkey,
    scriptTree: tapleaf,
    redeem: { output: scriptBuf, redeemVersion: 0xc0 },
    network,
  });
  if (!payment.witness || payment.witness.length < 2) throw new Error('Etch reveal: could not build witness');
  const controlBlock = payment.witness[payment.witness.length - 1];
  const inputAmount = Number(commitUtxo.value ?? commitUtxo.satoshi ?? 0);
  const etchJson = {
    name: etchParams.rune || etchParams.name,
    amount: etchParams.amount ?? 1,
    cap: etchParams.cap ?? 0,
    divisibility: etchParams.divisibility,
    symbol: etchParams.symbol,
    premine: etchParams.premine,
    startHeight: etchParams.startHeight,
    endHeight: etchParams.endHeight,
    startOffset: etchParams.startOffset,
    endOffset: etchParams.endOffset,
    pointer: etchParams.pointer,
  };
  const runestone = Runestone.create(etchJson, 'etch');
  const runestoneScript = Buffer.from(runestone.encipher());
  const psbt = new bitcoin.Psbt({ network });
  psbt.addInput({
    hash: Buffer.from(commitUtxo.txid, 'hex').reverse(),
    index: commitUtxo.vout ?? commitUtxo.index ?? 0,
    witnessUtxo: { script: payment.output, value: BigInt(inputAmount) },
    tapLeafScript: [{ leafVersion: 0xc0, script: scriptBuf, controlBlock }],
  });
  psbt.addOutput({ script: runestoneScript, value: BigInt(0) });
  const fee = Math.max(200 * feeRate, 250);
  let change = inputAmount - fee;
  if (change >= 546 && payment.address) {
    psbt.addOutput({ address: payment.address, value: BigInt(change) });
  }
  const ECPairFactory = require('ecpair');
  const ECPair = (ECPairFactory.default || ECPairFactory)(ecc);
  const privBuf = Buffer.isBuffer(privKey) ? privKey : Buffer.from(privKey, 'hex');
  const keyPair = ECPair.fromPrivateKey(privBuf, { network });
  psbt.signInput(0, keyPair);
  psbt.finalizeAllInputs();
  const tx = psbt.extractTransaction();
  return { rawTxHex: tx.toHex(), txid: tx.getId() };
}

// ─── Rune transfer / edicts ───────────────────────────────────────────────
// Runestone with edicts (runeId, amount, outputIndex) and optional pointer.

async function buildRuneTransferRunestone(edicts, pointer) {
  const runelib = await import('runelib');
  const { Runestone, RuneId, Edict, none, some } = runelib;
  const list = edicts.map((e) => {
    const [block, txIdx] = String(e.id || e.runeId).split(':').map(Number);
    return new Edict(new RuneId(block, txIdx), BigInt(e.amount), e.output ?? e.outputIndex ?? 0);
  });
  const stone = new Runestone(list, none(), none(), pointer != null ? some(pointer) : none());
  return Buffer.from(stone.encipher());
}

// Build tx: inputs = utxos, output = OP_RETURN runestone (transfer) + change.
async function buildRuneTransferTx(utxos, edicts, changeAddress, pointer, wif, options = {}) {
  const runestoneScript = await buildRuneTransferRunestone(edicts, pointer);
  const bitcoin = require('bitcoinjs-lib');
  const ecc = require('@bitcoinerlab/secp256k1');
  bitcoin.initEccLib(ecc);
  const network = (options.mainnet !== false) ? bitcoin.networks.bitcoin : bitcoin.networks.testnet;
  const feeRate = options.feeRate ?? 2;
  const psbt = new bitcoin.Psbt({ network });
  let totalIn = 0;
  for (const u of utxos) {
    const value = Number(u.value ?? u.satoshi ?? 0);
    let script = u.scriptPubKey;
    if (typeof script === 'string') script = Buffer.from(script, 'hex');
    else if (!Buffer.isBuffer(script)) script = Buffer.from(script);
    totalIn += value;
    psbt.addInput({
      hash: Buffer.from(u.txid || u.txId, 'hex').reverse(),
      index: u.vout ?? u.index ?? 0,
      witnessUtxo: { script, value: BigInt(value) },
    });
  }
  psbt.addOutput({ script: runestoneScript, value: BigInt(0) });
  const vsize = 10 + utxos.length * 100 + 43 + 43;
  const fee = Math.max(Math.ceil(vsize * feeRate), 250);
  const changeAmount = totalIn - fee;
  if (changeAmount < 0) throw new Error('Insufficient UTXOs for rune transfer fee');
  if (changeAmount >= 546 && changeAddress) {
    const changeScript = bitcoin.address.toOutputScript(changeAddress, network);
    psbt.addOutput({ script: changeScript, value: BigInt(changeAmount) });
  }
  const ECPairFactory = require('ecpair');
  const ECPair = (ECPairFactory.default || ECPairFactory)(ecc);
  const keyPair = ECPair.fromWIF(wif, network);
  for (let i = 0; i < utxos.length; i++) {
    psbt.signInput(i, keyPair);
  }
  psbt.finalizeAllInputs();
  const tx = psbt.extractTransaction();
  return { rawTxHex: tx.toHex(), txid: tx.getId() };
}

// ─── Unisat API (inscription info) ───────────────────────────────────────

const UNISAT_BASE_URL_FRACTAL = 'https://open-api-fractal.unisat.io';
const UNISAT_BASE_URL_BTC = 'https://open-api.unisat.io';

async function fetchInscriptionInfo(inscriptionId, options = {}) {
  const baseUrl = (options.baseUrl || '').replace(/\/$/, '') || (options.chain === 'bitcoin' ? UNISAT_BASE_URL_BTC : UNISAT_BASE_URL_FRACTAL);
  const apiKey = options.apiKey || (typeof process !== 'undefined' && process.env && process.env.UNISAT_API_KEY) || '';
  const url = `${baseUrl}/v1/indexer/inscription/info/${encodeURIComponent(inscriptionId)}`;
  const headers = { Accept: 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Unisat inscription info failed: ${res.status} ${res.statusText}`);
  const json = await res.json();
  if (json.code !== 0 || !json.data) throw new Error(json.msg || 'Unisat returned no data');
  return json.data;
}

// ─── Compression (gzip for cheaper large inscriptions) ─────────────────────

const CONTENT_ENCODING_GZIP = 'gzip';

function compressGzip(buffer) {
  const zlib = require('zlib');
  return zlib.gzipSync(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer), { level: 9 });
}

function decompressGzip(buffer) {
  const zlib = require('zlib');
  return zlib.gunzipSync(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
}

// ─── Exports ──────────────────────────────────────────────────────────────

module.exports = {
  decodeFileContent,
  encodeFileContent,
  buildInscriptionPayload,
  brc20Deploy,
  brc20Mint,
  brc20MintBatch,
  brc20Transfer,
  BP07_ADDRESS_TYPE,
  buildBp07TransferScript,
  buildBp07RevealTx,
  getCommitAddresses,
  buildRevealTx,
  buildRuneMintRunestone,
  getRuneMintCommitAddresses,
  buildRuneMintRevealTx,
  getEtchCommitAddress,
  buildEtchRevealTx,
  buildRuneTransferRunestone,
  buildRuneTransferTx,
  fetchInscriptionInfo,
  UNISAT_BASE_URL_FRACTAL,
  UNISAT_BASE_URL_BTC,
  compressGzip,
  decompressGzip,
  CONTENT_ENCODING_GZIP,
  createCommitPsbt,
  parseInscriptionId,
  buildInscriptionPayloadWithParent,
  buildOpReturnTx,
  buildSignedOpReturnTx,
  encodeOpReturnMessage,
  OP_RETURN_MAX_BYTES,
  MIN_INSCRIPTION_VALUE,
  BRC20_MINT_MAX,
  ensureGlobals,
};
