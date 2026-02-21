#!/usr/bin/env node
/**
 * Comprehensive CLI for inscribing: files, BRC-20 deploy/mint (bulk up to 1000),
 * rune mint, commit-reveal. Easy to use, bulk-friendly.
 *
 * Usage:
 *   node lib/inscribe-cli.js <command> [options]
 *   node lib/inscribe-cli.js help
 *   node lib/inscribe-cli.js help <command>
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SCRIPT_DIR = __dirname;
const inscribe = require(path.join(SCRIPT_DIR, 'inscribe.js'));

async function bootstrapBtcOrdinals() {
  if (global.btc && global.ordinals) return;
  const btc = await import('@scure/btc-signer');
  const ordinals = await import('micro-ordinals');
  const base = await import('@scure/base');
  global.btc = btc;
  global.ordinals = ordinals;
  global.hex = base.hex;
  global.customScripts = [ordinals.OutOrdinalReveal];
  try {
    const runelib = await import('runelib');
    global.Runestone = runelib.Runestone;
    global.RuneId = runelib.RuneId;
    global.none = runelib.none;
    global.some = runelib.some;
  } catch (_) {
    global.Runestone = null;
    global.RuneId = null;
    global.none = () => null;
    global.some = (v) => v;
  }
}

// ─── Key helpers (WIF → privKey + x-only pubKey for Taproot) ───────────────

function keyFromWif(wif, network = undefined) {
  try {
    const bitcoin = require('bitcoinjs-lib');
    const ecc = require('@bitcoinerlab/secp256k1');
    const ECPairFactory = require('ecpair');
    bitcoin.initEccLib(ecc);
    const net = network === 'testnet' ? bitcoin.networks.testnet : undefined;
    const ECPair = (ECPairFactory.default || ECPairFactory)(ecc);
    const keyPair = ECPair.fromWIF(wif, net);
    const privKey = keyPair.privateKey;
    if (!privKey || privKey.length !== 32) throw new Error('Invalid WIF');
    const pubCompressed = Buffer.isBuffer(keyPair.publicKey) ? keyPair.publicKey : Buffer.from(keyPair.publicKey);
    const pubKeyX = pubCompressed.slice(1, 33);
    return {
      privKey: new Uint8Array(privKey),
      pubKey: new Uint8Array(pubKeyX),
      pubKeyHex: pubKeyX.toString('hex'),
    };
  } catch (e) {
    throw new Error('Invalid WIF or missing bitcoinjs-lib/@bitcoinerlab/secp256k1/ecpair: ' + e.message);
  }
}

function nativeSegwitAddressFromWif(wif, network = undefined) {
  const bitcoin = require('bitcoinjs-lib');
  const ecc = require('@bitcoinerlab/secp256k1');
  const ECPairFactory = require('ecpair');
  bitcoin.initEccLib(ecc);
  const net = network === 'testnet' ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;
  const ECPair = (ECPairFactory.default || ECPairFactory)(ecc);
  const keyPair = ECPair.fromWIF(wif.trim(), net);
  const { address } = bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network: net });
  return address;
}

function contentTypeFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = {
    '.txt': 'text/plain;charset=utf-8',
    '.json': 'application/json',
    '.html': 'text/html;charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.pdf': 'application/pdf',
  };
  return mime[ext] || 'application/octet-stream';
}

// ─── Arg parsing ──────────────────────────────────────────────────────────

function getArg(name, short) {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` || (short && args[i] === short)) {
      if (args[i + 1] !== undefined && !args[i + 1].startsWith('-')) return args[i + 1];
      return true;
    }
    const eq = args[i].match(new RegExp(`^--${name}=(.*)$`));
    if (eq) return eq[1];
  }
  return process.env[`INSCRIBE_${name.toUpperCase().replace(/-/g, '_')}`] ?? null;
}

function getArgNum(name, def) {
  const v = getArg(name);
  if (v == null) return def;
  const n = parseInt(v, 10);
  if (isNaN(n)) return def;
  return n;
}

function getArgBool(name) {
  const v = getArg(name);
  return v === true || v === '1' || v === 'yes' || v === 'true';
}

function hasArg(name) {
  return process.argv.includes(`--${name}`);
}

// ─── Interactive WIF prompt (so key is not on command line) ─────────────────

function promptWif() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question('WIF (signing key): ', (line) => {
      rl.close();
      resolve((line && line.trim()) || null);
    });
  });
}

async function getWifOrPrompt() {
  const wif = getArg('wif') || process.env.INSCRIBE_WIF;
  if (wif) return wif.trim();
  if (hasArg('prompt-wif')) return await promptWif();
  return null;
}

// ─── Broadcast (push tx to FB or BTC chain) ─────────────────────────────────

const PUSH_URLS = {
  fractal: 'https://mempool.fractalbitcoin.io/api/tx',
  bitcoin: 'https://mempool.space/api/tx',
};

const UNISAT_PUSH_URLS = {
  fractal: 'https://open-api-fractal.unisat.io/v1/indexer/local_pushtx',
  bitcoin: 'https://open-api.unisat.io/v1/indexer/local_pushtx',
};

async function pushTx(rawTxHex, chain = 'fractal') {
  const txHex = typeof rawTxHex === 'string' ? rawTxHex : Buffer.from(rawTxHex).toString('hex');
  const mempoolUrl = PUSH_URLS[chain] || PUSH_URLS.fractal;
  let url = getArg('push-url') || mempoolUrl;
  const tryBroadcast = async (targetUrl) => {
    const res = await fetch(targetUrl, {
      method: 'POST',
      body: txHex,
      headers: { 'Content-Type': 'text/plain' },
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, text };
    let data;
    try { data = JSON.parse(text); } catch (_) { data = { txid: text.trim() }; }
    const txid = data.data ?? data.txid ?? data.result ?? text.trim();
    return { ok: true, txid };
  };
  const tryUnisatBroadcast = async () => {
    const apiKey = getArg('api-key') || process.env.UNISAT_API_KEY || '';
    if (!apiKey) return { ok: false, status: 0, text: 'No UNISAT_API_KEY' };
    const unisatUrl = UNISAT_PUSH_URLS[chain] || UNISAT_PUSH_URLS.fractal;
    const res = await fetch(unisatUrl, {
      method: 'POST',
      body: JSON.stringify({ txHex: txHex }),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, text };
    let data;
    try { data = JSON.parse(text); } catch (_) { return { ok: false, status: 0, text } }
    if (data.code !== 0) return { ok: false, status: 400, text: data.msg || text };
    return { ok: true, txid: data.data || data.msg || '' };
  };
  const result = await tryBroadcast(url);
  if (result.ok) return result.txid;
  const isMaxBurn = result.status === 400 && result.text && result.text.includes('maxburnamount');
  if (isMaxBurn) {
    const mempoolRetry = await tryBroadcast(mempoolUrl);
    if (mempoolRetry.ok) {
      process.stderr.write('Broadcast retried with mempool API after maxburnamount error.\n');
      return mempoolRetry.txid;
    }
    const unisatRetry = await tryUnisatBroadcast();
    if (unisatRetry.ok) {
      process.stderr.write('Broadcast retried with Unisat local_pushtx after maxburnamount error.\n');
      return unisatRetry.txid;
    }
    throw new Error(`Broadcast failed (maxburnamount). Mempool: ${mempoolRetry.text}; Unisat: ${unisatRetry.text}`);
  }
  throw new Error(`Broadcast failed (${result.status}): ${result.text}`);
}

// ─── I/O helpers ───────────────────────────────────────────────────────────

function readJson(pathOrStdin) {
  if (!pathOrStdin || pathOrStdin === '-') {
    return new Promise((resolve, reject) => {
      const chunks = [];
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', c => chunks.push(c));
      process.stdin.on('end', () => {
        try { resolve(JSON.parse(chunks.join(''))); } catch (e) { reject(e); }
      });
      process.stdin.on('error', reject);
    });
  }
  const raw = fs.readFileSync(pathOrStdin, 'utf8');
  return Promise.resolve(JSON.parse(raw));
}

function writeOut(obj, outPath, pretty = true) {
  const s = pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj);
  if (outPath && outPath !== '-') {
    fs.writeFileSync(outPath, s, 'utf8');
    process.stderr.write(`Wrote ${outPath}\n`);
  } else {
    process.stdout.write(s + '\n');
  }
}

// ─── Fee rate from API (optional) ──────────────────────────────────────────

async function fetchFeeRate(url = 'https://mempool.space/api/v1/fees/recommended') {
  try {
    const res = await (await import('node:https')).default.get(url, { timeout: 5000 });
    const chunks = [];
    for await (const c of res) chunks.push(c);
    const j = JSON.parse(Buffer.concat(chunks).toString());
    return (j.halfHourFee || j.hourFee || j.fastestFee || 10);
  } catch (_) {
    return 10;
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────

async function cmdHelp(sub) {
  const help = {
    default: `
inscribe-cli — Comprehensive inscribe CLI (files, BRC-20, rune, commit/reveal, bulk)

USAGE
  node lib/inscribe-cli.js <command> [options]
  node lib/inscribe-cli.js help [command]

COMMANDS
  commits       Generate commit addresses (and order manifest for reveal)
  commit-psbt   Build commit PSBT from UTXOs + commit outputs
  reveal        Build one reveal transaction (sign with --wif or --prompt-wif)
  reveal-bulk   Build many reveal transactions from funded commits
  sign-commit   Sign a commit PSBT with your key and optionally --push to chain
  brc20-deploy  Output BRC-20 deploy JSON (or generate commits; --self-mint for BP-04)
  brc20-mint    Output BRC-20 mint batch JSON or generate commits (bulk)
  brc20-transfer     BRC-20 transfer (legacy only)
  brc20-single-step  BRC-20 transfer BP07 single-step (FB only)
  rune-mint     Generate rune mint Runestone or commit addresses (bulk)
  rune-reveal   Build and sign one rune mint reveal tx (OP_RETURN + recipient)
  rune-etch        Get rune etch commit address (--out-order for rune-etch-reveal)
  rune-etch-reveal Spend etch commit UTXO and emit Runestone (etching)
  rune-transfer    Build rune transfer tx (edicts: runeId, amount, output index)
  file             Generate commit addresses for one or more files
  fee-rate      Print current recommended fee rate (sat/vB)
  fetch-utxos   Fetch UTXOs for an address (for real commit flow)
  opreturn      Write message to chain (OP_RETURN, max 80 bytes; WIF for signing)
  address       Derive native SegWit (bc1q) address from --wif
  sign-commit   Sign a commit PSBT with your key; optional --push to chain

GLOBAL OPTIONS (where applicable)
  --mainnet | --testnet   Network (default: mainnet)
  --fee-rate <n>          Sat per vB (default: 10 or from API with --fee-rate fetch)
  --wif <WIF>             Signing key (or set INSCRIBE_WIF)
  --prompt-wif            Ask for WIF interactively (no key on command line)
  --pubkey <hex>          Or use --wif (32-byte x-only pubkey hex for commits-only)
  --to <address>          Receive address for inscriptions
  --out <path>            Write JSON here (default: stdout)
  --push                  After building signed tx, broadcast to chain (FB or BTC)
  --chain <fractal|bitcoin>  Chain to push to (default: fractal)
  --push-url <url>        Override broadcast API URL
  --pretty                Pretty-print JSON (default: true)
  --no-pretty             Compact JSON

BULK
  Use --count for BRC-20 mint and rune-mint. Use --files "a,b,c" or stdin for multiple files.
  reveal-bulk reads a manifest of funded commits and order data to output many reveal tx hexes.
  Parent/child: use --parent <inscriptionId> (e.g. abc123...i0) with commits for reinscriptions.
`,
    commits: `
commits — Generate commit addresses (and optional order manifest for reveal)

  node lib/inscribe-cli.js commits [options]

INPUT (one of)
  --files <path1,path2,...>     File paths (content-type: application/octet-stream or --content-type)
  --brc20 <tick:amt:count>      BRC-20 mint batch (e.g. COIN:1000:100)
  --brc20-deploy <tick:max>     BRC-20 deploy (e.g. COIN:21000000, optional :lim:dec)
  --stdin                        Read files array from stdin: [{ "content": "base64|hex|text", "contentType": "..." }]

OPTIONS
  --pubkey <hex>  32-byte x-only pubkey (hex); or use --wif to derive
  --wif <WIF>     Derive pubkey (and store for reveal if --out-order)
  --fee-rate <n>  Sat/vB (default: 10)
  --dev-fee <n>   Total dev fee (sats) on last commit
  --dev-addresses <addr1,addr2>  Comma-separated (for dev fee)
  --out <path>    Write commit addresses JSON here
  --out-order <path>  Write order manifest (pubKey, inscriptionData, commitAddresses) for reveal-bulk; omit for no key on disk
  --parent <id>       Inscription id for parent-child (e.g. txidi0); applies to all files in this batch
  --compress          Use gzip for inscription body (content-encoding: gzip; cheaper for large files)

OUTPUT (default stdout)
  { "commitAddresses": [ { "address", "requiredAmount", "vsize", "estimatedFee", ... } ], "totalRequired", "count" }
  If --out-order: also writes order manifest with inscriptionData (for reveal).
`,
    'commit-psbt': `
commit-psbt — Build commit PSBT from UTXOs and commit outputs

  node lib/inscribe-cli.js commit-psbt --utxos <path|-> --outputs <path|-> --change-address <addr> [options]

INPUT
  --utxos <path>     JSON array: [{ "txid", "vout"|"index", "value"|"satoshi", "scriptPubKey" (hex) }]
  --outputs <path>   JSON array: [{ "address", "value"|"requiredAmount" }] (e.g. from commits --out)
  --change-address   Where to send change

OPTIONS
  --fee-rate <n>  Sat/vB (default: 10)
  --out <path>    Write { "psbtBase64", "fee", "changeAmount" } (default: stdout)
`,
    reveal: `
reveal — Build one reveal transaction

  node lib/inscribe-cli.js reveal --commit-txid <txid> --vout <n> --to <addr> --order <path> --wif <WIF> [options]

INPUT
  --commit-txid   Funding txid
  --vout          Output index of commit UTXO
  --to            Receive address for inscription
  --order <path>  Order manifest from commits --out-order (has inscriptionData, pubKey; index by vout)
  --inscription-index <n>  Index into order.inscriptionData (default: 0)
  --wif           Signing key

OPTIONS
  --value <sats>  Commit UTXO value (required if not in order)
  --dev-fee <n>   Dev fee amount (sats)
  --dev-addresses <addr1,...>
  --out <path>    Write { "rawTxHex", "txid" } (default: stdout)
`,
    'reveal-bulk': `
reveal-bulk — Build many reveal transactions from funded commits

  node lib/inscribe-cli.js reveal-bulk --funded <path> --order <path> --to <addr> --wif <WIF> [options]

INPUT
  --funded <path>  JSON array: [{ "commitTxid", "vout", "address", "value" }] (funded commit UTXOs)
  --order <path>   Order manifest from commits --out-order (inscriptionData, pubKey)
  --to             Receive address
  --wif            Signing key

OPTIONS
  --dev-fee <n>   Dev fee per reveal (last one gets total)
  --dev-addresses <addr1,...>
  --out <path>    Write array of { "txid", "rawTxHex", "vout" } (default: stdout)
  --push          Broadcast each reveal tx to chain (--chain fractal | bitcoin)
  --chain <fractal|bitcoin>  Default: fractal
  --concurrency <n>  Not used (sequential); reserved for future
`,
    'sign-commit': `
sign-commit — Sign a commit PSBT with your key and optionally broadcast to chain

  node lib/inscribe-cli.js sign-commit --psbt <path|base64> --wif <WIF> [--push] [--chain fractal|bitcoin]

INPUT
  --psbt <path>   Path to JSON with psbtBase64 or path to file containing base64 PSBT
  --psbt -        Read PSBT base64 from stdin

OPTIONS
  --wif           Signing key (or INSCRIBE_WIF or --prompt-wif)
  --prompt-wif    Ask for WIF interactively
  --push          After signing, broadcast to chain
  --chain <fractal|bitcoin>  Default: fractal
  --out <path>    Write { "rawTxHex", "txid" } (default: stdout)
`,
    'brc20-deploy': `
brc20-deploy — Output BRC-20 deploy JSON or generate commits for one deploy

  node lib/inscribe-cli.js brc20-deploy --tick <TICK> --max <n> [--lim <n>] [--dec <n>] [--self-mint] [options]

  --self-mint  BP-04: only deployer can mint (mints must use deploy as parent).
  With --pubkey or --wif: same as commits --brc20-deploy (output commit address). Without: print deploy JSON.
`,
    'brc20-transfer': `
brc20-transfer — BRC-20 transfer (legacy only; commit then reveal to address)

  node lib/inscribe-cli.js brc20-transfer --tick <TICK> --amt <n> [options]

  Ticker is case-sensitive (e.g. TheLonelyBit). Use --out-order for reveal. For BP07 single-step use brc20-single-step.
`,
    'brc20-single-step': `
brc20-single-step — BRC-20 transfer BP07 single-step (one commit→reveal; Fractal Bitcoin only)

  node lib/inscribe-cli.js brc20-single-step --tick <TICK> --amt <n> [--address-type N] [options]

  One commit→reveal sends to recipient (balance source = signer). Active on FB only, not BTC.
  --address-type 1..8. Must match receiver: 1 = P2TR (bc1p), 2 = P2WPKH (bc1q). Default 1; with --wif and bc1q/tb1q signer defaults to 2. Use --out-order for reveal; then reveal --order <file> --to <addr> --chain fractal.
`,
    'brc20-mint': `
brc20-mint — BRC-20 mint batch (up to 1000) or generate commits

  node lib/inscribe-cli.js brc20-mint --tick <TICK> --amt <n> --count <n> [options]

  With --pubkey or --wif: generate commit addresses (same as commits --brc20 tick:amt:count).
  Without: print JSON array of file objects for use with commits --stdin.
`,
    'rune-mint': `
rune-mint — Rune mint Runestone or commit addresses for rune-only mints (bulk)

  node lib/inscribe-cli.js rune-mint --rune-id <block:tx> [--count <n>] [options]

  With --count and --wif/--pubkey: generate N commit addresses; use --out-order to save manifest.
  Then: commit-psbt (with rune commits as outputs) → sign-commit --push → rune-reveal for each vout.
  Without --count: output Runestone encipher hex for one mint (for manual use).
  Chain: --chain fractal|bitcoin (for push; default fractal). Works on both FB and BTC.
`,
    'rune-reveal': `
rune-reveal — Build and sign one rune mint reveal tx (spend commit UTXO → OP_RETURN + recipient)

  node lib/inscribe-cli.js rune-reveal --commit-txid <id> --vout <n> --to <addr> --order <path> [--push]

  Order file from rune-mint --count --out-order. Use --value if not in order.
  Signs with --wif or INSCRIBE_WIF (or order.privKeyHex if present).
  --chain fractal|bitcoin  Default: fractal. Use same chain as commit tx.
`,
    'rune-etch': `
rune-etch — Get rune etch commit address (fund it, then rune-etch-reveal to complete)

  node lib/inscribe-cli.js rune-etch --rune <NAME> [--wif|--pubkey] [--body <file>] [options]

  Outputs address and requiredAmount. Use --out-order <path> to save scriptHex + etchParams for rune-etch-reveal.
  Chain: --chain fractal|bitcoin (for display; push happens at reveal).

OPTIONS (etch terms)
  --amount <n>       Supply per mint (default 1)
  --cap <n>          Max mints (0 = unlimited)
  --divisibility <n> Decimal places
  --symbol <c>       Single character (e.g. ¢)
  --premine <n>      Premine amount
  --start-height, --end-height, --start-offset, --end-offset  Minting window
  --pointer <n>      Etching pointer output index
`,
    'rune-etch-reveal': `
rune-etch-reveal — Spend etch commit UTXO and emit Runestone (etching) on chain

  node lib/inscribe-cli.js rune-etch-reveal --commit-txid <id> --vout <n> --order <path> --wif <WIF> [--push]

  Order file from rune-etch --out-order (scriptHex, etchParams, pubKey). Signs and optionally pushes.
  --chain fractal|bitcoin  Default: fractal
`,
    'rune-transfer': `
rune-transfer — Build (and optionally push) rune transfer tx (edicts)

  node lib/inscribe-cli.js rune-transfer --utxos <path> --edicts "block:tx:amount:outputIndex" [--edicts ...] --change-address <addr> --wif <WIF> [--push]

  Edicts: runeId as block:tx, amount, output index. Comma-separated or multiple --edicts.
  --pointer <n>  Optional runestone pointer. --chain fractal|bitcoin (default: fractal)
`,
    file: `
file — Generate commit addresses for one or more files

  node lib/inscribe-cli.js file --files <path1,path2,...> [options]

  Alias for: commits --files <path1,path2,...>
`,
    'fee-rate': `
fee-rate — Print recommended fee rate (sat/vB)

  node lib/inscribe-cli.js fee-rate [--api <url>]
`,
    'fetch-utxos': `
fetch-utxos — Fetch UTXOs for an address (for use with commit-psbt)

  node lib/inscribe-cli.js fetch-utxos --address <addr> [options]

  Outputs JSON array: [{ "txid", "vout", "value", "scriptPubKey" (hex) }]
  Pipe to a file and pass to commit-psbt --utxos.

OPTIONS
  --chain <fractal|bitcoin>  Default: fractal
  --no-inscriptions  Use Unisat available-utxo (excludes inscription/runes/alkanes UTXOs). Requires --api-key or UNISAT_API_KEY. Use for commit funding so the picked UTXO is not an inscription.
  --out <path>    Write UTXOs JSON (default: stdout)
`,
    address: `
address — Derive native SegWit (P2WPKH, bc1q...) address from WIF

  node lib/inscribe-cli.js address [--wif <WIF>]

  Uses INSCRIBE_WIF if --wif not set. Use this address for funding and change.
  Example: fetch-utxos --address <this-address>; commit-psbt --change-address <this-address>
`,
  opreturn: `
opreturn — Write a message to chain (OP_RETURN output + change)

  node lib/inscribe-cli.js opreturn --utxos <path> --message <text|hex> --change-address <addr> [--push]

  --utxos <path>     JSON array of UTXOs (e.g. from fetch-utxos --out)
  --message <text>   UTF-8 text or hex (0x...); max 80 bytes for standard relay
  --change-address   Where to send change (required)
  --fee-rate <n>     Sat/vB (default: 2)
  --push             Broadcast after signing (use with --chain)
  --chain <fractal|bitcoin>
  WIF required only for signing (INSCRIBE_WIF or --wif or --prompt-wif).
`,
  };
  const text = sub ? (help[sub] || help.default) : help.default;
  process.stdout.write(text.trim() + '\n');
}

async function cmdCommits() {
  const filesArg = getArg('files');
  const brc20Arg = getArg('brc20');
  const brc20DeployArg = getArg('brc20-deploy');
  const stdin = hasArg('stdin');
  let files = [];
  const parentArg = getArg('parent');
  if (filesArg) {
    const paths = filesArg.split(',').map(p => p.trim()).filter(Boolean);
    const defaultContentType = getArg('content-type') || '';
    for (const p of paths) {
      const content = fs.readFileSync(p);
      const contentType = defaultContentType || contentTypeFromPath(p);
      const file = { content: content.toString('base64'), contentType };
      if (parentArg) file.parent = parentArg;
      files.push(file);
    }
  } else if (brc20Arg) {
    const [tick, amt, count] = brc20Arg.split(':');
    const c = parseInt(count || '1', 10);
    if (!tick || !amt || c < 1 || c > inscribe.BRC20_MINT_MAX) throw new Error('--brc20 tick:amt:count (count 1..1000)');
    files = inscribe.brc20MintBatch(tick.trim(), amt.trim(), c);
  } else if (brc20DeployArg) {
    const parts = brc20DeployArg.split(':');
    const tick = parts[0];
    const max = parts[1];
    const lim = parts[2];
    const dec = parts[3];
    const json = inscribe.brc20Deploy(tick, max, lim, dec);
    const file = { content: json, contentType: 'text/plain;charset=utf-8' };
    if (parentArg) file.parent = parentArg;
    files = [file];
  } else if (stdin) {
    const arr = await readJson('-');
    const list = Array.isArray(arr) ? arr : [arr];
    for (const f of list) {
      const file = typeof f.content === 'string' ? { content: f.content, contentType: f.contentType || 'application/octet-stream' } : f;
      if (parentArg) file.parent = parentArg;
      else if (f.parent) file.parent = f.parent;
      files.push(file);
    }
  } else {
    throw new Error('Use --files, --brc20, --brc20-deploy, or --stdin');
  }

  const wif = getArg('wif');
  const pubkeyHex = getArg('pubkey');
  let pubKey;
  let keyPair;
  if (wif) {
    keyPair = keyFromWif(wif, hasArg('testnet') ? 'testnet' : undefined);
    pubKey = keyPair.pubKey;
  } else if (pubkeyHex) {
    if (pubkeyHex.length !== 64 || !/^[0-9a-fA-F]+$/.test(pubkeyHex)) throw new Error('--pubkey must be 32-byte hex');
    pubKey = Buffer.from(pubkeyHex, 'hex');
  } else {
    throw new Error('Use --wif or --pubkey');
  }

  const mainnet = !hasArg('testnet');
  const feeRate = getArgNum('fee-rate', 10);
  const devFee = getArgNum('dev-fee', 0);
  const devAddressesStr = getArg('dev-addresses');
  const devFeeAddresses = devAddressesStr ? devAddressesStr.split(',').map(s => s.trim()).filter(Boolean) : [];

  const opts = { mainnet, feeRate, devFeeTotal: devFee, devFeeAddresses, compress: hasArg('compress') };
  if (keyPair) opts.privKey = keyPair.privKey;
  const { commitAddresses, inscriptionData } = await inscribe.getCommitAddresses(files, pubKey, opts);

  let totalRequired = 0;
  commitAddresses.forEach(c => { totalRequired += Number(c.requiredAmount); });

  const outPath = getArg('out');
  const orderPath = getArg('out-order');
  const pubKeyHexOut = (pubKey instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(pubKey)))
    ? Buffer.from(pubKey).toString('hex') : pubKey;
  const inscriptionDataSerializable = inscriptionData.map(ins => {
    const out = {
      contentType: ins.tags?.contentType || 'application/octet-stream',
      body: Buffer.from(ins.body).toString('base64'),
    };
    if (ins.tags?.parent != null) out.parent = ins.tags.parent;
    if (ins.tags?.contentEncoding) out.contentEncoding = ins.tags.contentEncoding;
    return out;
  });

  const result = {
    commitAddresses,
    totalRequired: String(totalRequired),
    count: commitAddresses.length,
  };
  writeOut(result, outPath, getArgBool('pretty') !== false);

  if (orderPath) {
    const order = {
      pubKey: pubKeyHexOut,
      inscriptionData: inscriptionDataSerializable,
      commitAddresses,
      count: commitAddresses.length,
    };
    if (keyPair) order.privKeyHex = Buffer.from(keyPair.privKey).toString('hex');
    fs.writeFileSync(orderPath, JSON.stringify(order, null, 2), 'utf8');
    process.stderr.write('Wrote order manifest: ' + orderPath + '\n');
    process.stderr.write('\nRecovery / next steps:\n');
    process.stderr.write('  • Save ' + orderPath + ' (needed for reveal). Without --wif, you will need --wif at reveal time.\n');
    process.stderr.write('  • Send exactly ' + totalRequired + ' sats total to the commit address(es) above (or use commit-psbt with UTXOs).\n');
    process.stderr.write('  • After commit tx confirms: reveal --commit-txid <TXID> --vout <N> --to <RECIPIENT> --order ' + orderPath + ' [--push]\n');
  }
}

async function cmdCommitPsbt() {
  const utxosPath = getArg('utxos');
  const outputsPath = getArg('outputs');
  const changeAddress = getArg('change-address');
  if (!utxosPath || !outputsPath || !changeAddress) throw new Error('Need --utxos, --outputs, --change-address');
  const utxos = await readJson(utxosPath);
  const outputs = await readJson(outputsPath);
  const feeRate = getArgNum('fee-rate', 10);
  const mainnet = !hasArg('testnet');
  const outArr = Array.isArray(outputs) ? outputs : (outputs.commitAddresses || [outputs]);
  const outForPsbt = outArr.map(o => ({
    address: o.address,
    value: Number(o.requiredAmount || o.value || 0),
  }));
  const { psbtBase64, fee, changeAmount } = await inscribe.createCommitPsbt(
    utxos,
    outForPsbt,
    feeRate,
    changeAddress,
    { mainnet }
  );
  const result = { psbtBase64, fee, changeAmount };
  writeOut(result, getArg('out'), getArgBool('pretty') !== false);
  process.stderr.write('\nNext: sign-commit --psbt <file|base64> [--push] (WIF required only for this step).\n');
  process.stderr.write('Recovery: save the PSBT output; after signing and broadcasting, save the commit txid for reveal.\n');
}

async function cmdReveal() {
  const commitTxid = getArg('commit-txid');
  const vout = getArgNum('vout', 0);
  const to = getArg('to');
  const orderPath = getArg('order');
  const value = getArgNum('value', 0);
  if (!commitTxid || !to || !orderPath) throw new Error('Need --commit-txid, --to, --order');
  const order = await readJson(orderPath);
  let wif = await getWifOrPrompt();
  if (!wif && order.privKeyHex) {
    process.stderr.write('Using key from order file. For security, prefer --wif or INSCRIBE_WIF instead of storing key in order.\n');
  } else if (!wif) {
    throw new Error('Need --wif, INSCRIBE_WIF, or --prompt-wif to sign reveal (WIF only needed for signing; use --pubkey for commits)');
  }
  let k;
  if (wif) {
    k = keyFromWif(wif, hasArg('testnet') ? 'testnet' : undefined);
  } else {
    k = {
      privKey: Buffer.from(order.privKeyHex, 'hex'),
      pubKey: Buffer.from(order.pubKey, 'hex'),
    };
  }
  const inscriptionIndex = getArgNum('inscription-index', vout);
  const inscriptionData = order.inscriptionData || [];
  const ins = inscriptionData[inscriptionIndex];
  if (!ins) throw new Error('No inscription at index ' + inscriptionIndex);
  const inscription = {
    tags: { contentType: ins.contentType || 'application/octet-stream' },
    body: Buffer.from(ins.body, 'base64'),
  };
  if (ins.parent != null) inscription.tags.parent = ins.parent;
  if (ins.contentEncoding) inscription.tags.contentEncoding = ins.contentEncoding;
  const pubKey = order.pubKey ? Buffer.from(order.pubKey, 'hex') : k.pubKey;
  const commitUtxo = {
    txid: commitTxid,
    vout,
    value: value || (order.commitAddresses && order.commitAddresses[vout] && Number(order.commitAddresses[vout].requiredAmount)),
  };
  if (!commitUtxo.value) throw new Error('Commit UTXO value unknown; set --value');
  const devFee = getArgNum('dev-fee', 0);
  const devAddressesStr = getArg('dev-addresses');
  const devFeeAddresses = devAddressesStr ? devAddressesStr.split(',').map(s => s.trim()).filter(Boolean) : [];
  const feeRate = getArgNum('fee-rate', 2);
  const commitRec = order.commitAddresses && (order.commitAddresses[vout] || order.commitAddresses[inscriptionIndex]);
  let singleStepScriptHex = commitRec && commitRec.singleStepScriptHex;
  if (order._singleStep === true && !singleStepScriptHex) {
    singleStepScriptHex = (order.commitAddresses && order.commitAddresses[0] && order.commitAddresses[0].singleStepScriptHex) || (ins && ins.singleStepScriptHex);
    if (!singleStepScriptHex) {
      throw new Error('Order is BP07 single-step (_singleStep: true) but singleStepScriptHex is missing. Use brc20-single-step (not brc20-transfer) to generate the order.');
    }
  }
  if (singleStepScriptHex) {
    const scriptBuf = Buffer.from(singleStepScriptHex, 'hex');
    let scriptXOnly = null;
    if (scriptBuf.length >= 34 && scriptBuf[0] === 0x20) scriptXOnly = scriptBuf.slice(1, 33);
    else if (scriptBuf.length >= 34 && scriptBuf[0] === 0x51 && scriptBuf[1] === 0x20) scriptXOnly = scriptBuf.slice(2, 34);
    if (scriptXOnly) {
      const ourPub = Buffer.isBuffer(k.pubKey) ? k.pubKey : Buffer.from(order.pubKey, 'hex');
      const ourXOnly = ourPub.length === 32 ? ourPub : ourPub.slice(1, 33);
      if (!scriptXOnly.equals(ourXOnly)) {
        process.stderr.write('Script embedded x-only pubkey: ' + scriptXOnly.toString('hex') + '\n');
        process.stderr.write('Your key x-only:                ' + ourXOnly.toString('hex') + '\n');
        throw new Error('Signing key does not match the commit script. Use the WIF for the wallet that funded the commit address (the key in the script).');
      }
    }
  }
  const opts = { mainnet: !hasArg('testnet'), devFeeAmount: devFee, devFeeAddresses, feeRate };
  if (singleStepScriptHex) opts.singleStepScriptHex = singleStepScriptHex;
  const { rawTxHex, txid } = await inscribe.buildRevealTx(
    commitUtxo,
    inscription,
    pubKey,
    k.privKey,
    to,
    opts
  );
  const chain = getArg('chain') || 'fractal';
  if (hasArg('push')) {
    const pushed = await pushTx(rawTxHex, chain);
    process.stderr.write(`Pushed to ${chain}: ${pushed}\n`);
    process.stderr.write('\nRecovery: save commit txid ' + (commitTxid || '') + ' and vout ' + vout + ' for reveal. Reveal: --commit-txid <this-txid> --vout ' + vout + ' --to <recipient> --order <order-file> [--push]\n');
  }
  writeOut({ rawTxHex, txid }, getArg('out'), getArgBool('pretty') !== false);
}

// Legacy BRC-20 transfer only (commit → reveal to address). For BP07 single-step use brc20-single-step.
async function cmdBrc20Transfer() {
  if (hasArg('single-step')) {
    throw new Error('Use "brc20-single-step" for BP07 single-step transfer. This command is for legacy transfer only.');
  }
  const tick = getArg('tick');
  const amt = getArg('amt');
  const wif = getArg('wif');
  const pubkeyHex = getArg('pubkey');
  if (!tick || !amt) throw new Error('Need --tick and --amt');
  if (tick === 'thelonelybit') {
    process.stderr.write('Warning: Ticker "thelonelybit" may be invalid. The official token on Fractal uses "TheLonelyBit" (capital T,L,B). Use --tick TheLonelyBit for valid transfers.\n');
  }
  const payload = inscribe.brc20Transfer(tick, amt);
  const file = { content: payload, contentType: 'text/plain;charset=utf-8' };
  const files = [file];
  let pubKey, keyPair;
  if (wif) {
    keyPair = keyFromWif(wif, hasArg('testnet') ? 'testnet' : undefined);
    pubKey = keyPair.pubKey;
  } else if (pubkeyHex) {
    if (pubkeyHex.length !== 64 || !/^[0-9a-fA-F]+$/.test(pubkeyHex)) throw new Error('--pubkey must be 32-byte hex');
    pubKey = Buffer.from(pubkeyHex, 'hex');
  } else {
    throw new Error('Need --wif or --pubkey');
  }
  const opts = { mainnet: !hasArg('testnet'), feeRate: getArgNum('fee-rate', 10) };
  if (keyPair) opts.privKey = keyPair.privKey;
  const { commitAddresses, inscriptionData } = await inscribe.getCommitAddresses(files, pubKey, opts);
  let totalRequired = 0;
  commitAddresses.forEach(c => { totalRequired += Number(c.requiredAmount); });
  const outPath = getArg('out');
  const orderPath = getArg('out-order');
  const inscriptionDataSerializable = inscriptionData.map((ins) => ({
    contentType: ins.tags?.contentType || 'application/octet-stream',
    body: Buffer.from(ins.body).toString('base64'),
  }));
  const result = { commitAddresses, totalRequired: String(totalRequired), count: 1, inscriptionData: inscriptionDataSerializable };
  writeOut(result, outPath, getArgBool('pretty') !== false);
  if (orderPath) {
    const order = {
      _singleStep: false,
      pubKey: Buffer.from(pubKey).toString('hex'),
      inscriptionData: inscriptionDataSerializable,
      commitAddresses,
      count: 1,
    };
    if (keyPair) order.privKeyHex = Buffer.from(keyPair.privKey).toString('hex');
    order._recovery = {
      hint: 'Legacy transfer. For reveal: --commit-txid <TXID> --vout 0 --to <RECIPIENT> --order ' + orderPath + ' [--push].',
      commitAddress: commitAddresses[0]?.address,
      requiredSats: commitAddresses[0]?.requiredAmount,
    };
    fs.writeFileSync(orderPath, JSON.stringify(order, null, 2), 'utf8');
    process.stderr.write('Wrote order manifest (legacy): ' + orderPath + '\n');
    process.stderr.write('  • Send ' + commitAddresses[0]?.requiredAmount + ' sats to: ' + commitAddresses[0]?.address + '\n');
    process.stderr.write('  • Then: reveal --commit-txid <TXID> --vout 0 --to <ADDR> --order ' + orderPath + ' [--push]\n');
  }
}

// BP07 single-step BRC-20 transfer only (one commit→reveal; FB only). Separate from legacy brc20-transfer.
async function cmdBrc20SingleStep() {
  const tick = getArg('tick');
  const amt = getArg('amt');
  const wif = getArg('wif');
  const pubkeyHex = getArg('pubkey');
  let addressType = getArgNum('address-type', 1);
  if (getArg('address-type') == null && wif) {
    try {
      const derivedAddr = nativeSegwitAddressFromWif(wif, hasArg('testnet') ? 'testnet' : undefined);
      if (derivedAddr && (derivedAddr.startsWith('bc1q') || derivedAddr.startsWith('tb1q'))) {
        addressType = 2;
        process.stderr.write('Using address-type 2 (P2WPKH) for native segwit signer.\n');
      }
    } catch (_) { /* keep default 1 */ }
  }
  if (!tick || !amt) throw new Error('Need --tick and --amt');
  process.stderr.write('BP07 single-step is active on Fractal Bitcoin (FB) only. Use --chain fractal.\n');
  if (tick === 'thelonelybit') {
    process.stderr.write('Warning: Ticker "thelonelybit" may be invalid. Use --tick TheLonelyBit for valid transfers.\n');
  }
  const payload = inscribe.brc20Transfer(tick, amt);
  const file = { content: payload, contentType: 'text/plain;charset=utf-8', singleStepTransfer: true, addressType };
  const files = [file];
  let pubKey, keyPair;
  if (wif) {
    keyPair = keyFromWif(wif, hasArg('testnet') ? 'testnet' : undefined);
    pubKey = keyPair.pubKey;
  } else if (pubkeyHex) {
    if (pubkeyHex.length !== 64 || !/^[0-9a-fA-F]+$/.test(pubkeyHex)) throw new Error('--pubkey must be 32-byte hex');
    pubKey = Buffer.from(pubkeyHex, 'hex');
  } else {
    throw new Error('Need --wif or --pubkey');
  }
  const opts = { mainnet: !hasArg('testnet'), feeRate: getArgNum('fee-rate', 10) };
  if (keyPair) opts.privKey = keyPair.privKey;
  const { commitAddresses, inscriptionData } = await inscribe.getCommitAddresses(files, pubKey, opts);
  let totalRequired = 0;
  commitAddresses.forEach(c => { totalRequired += Number(c.requiredAmount); });
  const outPath = getArg('out');
  const orderPath = getArg('out-order');
  const inscriptionDataSerializable = inscriptionData.map((ins, idx) => {
    const out = {
      contentType: ins.tags?.contentType || 'application/octet-stream',
      body: Buffer.from(ins.body).toString('base64'),
    };
    const rec = commitAddresses[idx];
    if (rec && rec.singleStepScriptHex) {
      out.singleStepScriptHex = rec.singleStepScriptHex;
      out.singleStepAddressType = rec.singleStepAddressType;
    }
    return out;
  });
  const result = { commitAddresses, totalRequired: String(totalRequired), count: 1, inscriptionData: inscriptionDataSerializable };
  writeOut(result, outPath, getArgBool('pretty') !== false);
  if (orderPath) {
    const order = {
      _singleStep: true,
      pubKey: Buffer.from(pubKey).toString('hex'),
      inscriptionData: inscriptionDataSerializable,
      commitAddresses,
      count: 1,
    };
    if (keyPair) order.privKeyHex = Buffer.from(keyPair.privKey).toString('hex');
    order._recovery = {
      hint: 'BP07 single-step. For reveal: --commit-txid <TXID> --vout 0 --to <RECIPIENT> --order ' + orderPath + ' [--push].',
      commitAddress: commitAddresses[0]?.address,
      requiredSats: commitAddresses[0]?.requiredAmount,
    };
    fs.writeFileSync(orderPath, JSON.stringify(order, null, 2), 'utf8');
    process.stderr.write('Wrote order manifest (BP07 single-step): ' + orderPath + '\n');
    process.stderr.write('  • Send ' + commitAddresses[0]?.requiredAmount + ' sats to: ' + commitAddresses[0]?.address + '\n');
    process.stderr.write('  • Then: reveal --commit-txid <TXID> --vout 0 --to <ADDR> --order ' + orderPath + ' [--push] --chain fractal\n');
  }
}

async function cmdRevealBulk() {
  const fundedPath = getArg('funded');
  const orderPath = getArg('order');
  const to = getArg('to');
  const wif = await getWifOrPrompt();
  if (!fundedPath || !orderPath || !to) throw new Error('Need --funded, --order, --to');
  if (!wif) throw new Error('Need --wif, INSCRIBE_WIF, or --prompt-wif to sign');
  const funded = await readJson(fundedPath);
  const order = await readJson(orderPath);
  const k = keyFromWif(wif, hasArg('testnet') ? 'testnet' : undefined);
  const pubKey = order.pubKey ? Buffer.from(order.pubKey, 'hex') : k.pubKey;
  const inscriptionData = order.inscriptionData || [];
  const devFee = getArgNum('dev-fee', 0);
  const devAddressesStr = getArg('dev-addresses');
  const devFeeAddresses = devAddressesStr ? devAddressesStr.split(',').map(s => s.trim()).filter(Boolean) : [];
  const results = [];
  const arr = Array.isArray(funded) ? funded : [funded];
  for (let i = 0; i < arr.length; i++) {
    const f = arr[i];
    const vout = f.vout ?? f.index ?? i;
    const ins = inscriptionData[i] || inscriptionData[vout];
    if (!ins) {
      process.stderr.write('Skip index ' + i + ': no inscriptionData\n');
      continue;
    }
    const inscription = {
      tags: { contentType: ins.contentType || 'application/octet-stream' },
      body: Buffer.from(ins.body, 'base64'),
    };
    if (ins.parent != null) inscription.tags.parent = ins.parent;
    if (ins.contentEncoding) inscription.tags.contentEncoding = ins.contentEncoding;
    const commitUtxo = {
      txid: f.commitTxid || f.txid,
      vout: f.vout ?? f.index ?? i,
      value: f.value ?? f.satoshi ?? 0,
    };
    if (!commitUtxo.value) {
      process.stderr.write('Skip index ' + i + ': no value for commit UTXO\n');
      continue;
    }
    const commitRec = order.commitAddresses && (order.commitAddresses[i] || order.commitAddresses[vout]);
    const singleStepScriptHex = (commitRec && commitRec.singleStepScriptHex) || (ins && ins.singleStepScriptHex);
    const opts = { mainnet: !hasArg('testnet'), devFeeAmount: devFee, devFeeAddresses, feeRate: getArgNum('fee-rate', 2) };
    if (singleStepScriptHex) opts.singleStepScriptHex = singleStepScriptHex;
    const { rawTxHex, txid } = await inscribe.buildRevealTx(commitUtxo, inscription, pubKey, k.privKey, to, opts);
    const chain = getArg('chain') || 'fractal';
    if (hasArg('push')) {
      try {
        const pushed = await pushTx(rawTxHex, chain);
        process.stderr.write(`Pushed [${i}] ${txid}: ${pushed}\n`);
      } catch (e) {
        process.stderr.write(`Push failed [${i}]: ${e.message}\n`);
      }
    }
    results.push({ txid, rawTxHex, vout, index: i });
  }
  writeOut(results, getArg('out'), getArgBool('pretty') !== false);
}

async function cmdBrc20Deploy() {
  const tick = getArg('tick');
  const max = getArg('max');
  const lim = getArg('lim');
  const dec = getArg('dec');
  const selfMint = hasArg('self-mint');
  if (!tick || !max) throw new Error('Need --tick and --max');
  const json = inscribe.brc20Deploy(tick, max, lim, dec, selfMint);
  if (!getArg('pubkey') && !getArg('wif')) {
    process.stdout.write(json + '\n');
    return;
  }
  const files = [{ content: json, contentType: 'text/plain;charset=utf-8' }];
  const wif = getArg('wif');
  const pubkeyHex = getArg('pubkey');
  let pubKey;
  if (wif) pubKey = keyFromWif(wif).pubKey;
  else if (pubkeyHex) pubKey = Buffer.from(pubkeyHex, 'hex');
  else throw new Error('--pubkey or --wif');
  const { commitAddresses, inscriptionData } = await inscribe.getCommitAddresses(files, pubKey, {
    mainnet: !hasArg('testnet'),
    feeRate: getArgNum('fee-rate', 10),
  });
  writeOut({ commitAddresses, inscriptionData, deployJson: json }, getArg('out'), getArgBool('pretty') !== false);
}

async function cmdBrc20Mint() {
  const tick = getArg('tick');
  const amt = getArg('amt');
  const count = getArgNum('count', 1);
  if (!tick || !amt) throw new Error('Need --tick and --amt');
  if (count > inscribe.BRC20_MINT_MAX) throw new Error('--count max ' + inscribe.BRC20_MINT_MAX);
  if (!getArg('pubkey') && !getArg('wif')) {
    const files = inscribe.brc20MintBatch(tick, amt, count);
    writeOut(files, getArg('out'), getArgBool('pretty') !== false);
    return;
  }
  const files = inscribe.brc20MintBatch(tick, amt, count);
  const wif = getArg('wif');
  const pubkeyHex = getArg('pubkey');
  let pubKey;
  if (wif) pubKey = keyFromWif(wif).pubKey;
  else pubKey = Buffer.from(pubkeyHex, 'hex');
  const { commitAddresses, inscriptionData } = await inscribe.getCommitAddresses(files, pubKey, {
    mainnet: !hasArg('testnet'),
    feeRate: getArgNum('fee-rate', 10),
    devFeeTotal: getArgNum('dev-fee', 0),
    devFeeAddresses: (getArg('dev-addresses') || '').split(',').map(s => s.trim()).filter(Boolean),
  });
  let totalRequired = 0;
  commitAddresses.forEach(c => { totalRequired += Number(c.requiredAmount); });
  writeOut({
    commitAddresses,
    inscriptionData: inscriptionData.map(ins => ({
      contentType: ins.tags?.contentType,
      body: Buffer.from(ins.body).toString('base64'),
    })),
    totalRequired: String(totalRequired),
    count: commitAddresses.length,
  }, getArg('out'), getArgBool('pretty') !== false);
}

async function cmdRuneMint() {
  const runeId = getArg('rune-id');
  if (!runeId) throw new Error('Need --rune-id block:tx');
  const count = getArgNum('count', 0);
  const pointer = getArgNum('pointer', 1);
  if (count === 0) {
    const encipher = await inscribe.buildRuneMintRunestone(runeId, pointer);
    process.stdout.write(Buffer.from(encipher).toString('hex') + '\n');
    return;
  }
  const wif = getArg('wif');
  const pubkeyHex = getArg('pubkey');
  let pubKey;
  let keyPair;
  if (wif) {
    keyPair = keyFromWif(wif, hasArg('testnet') ? 'testnet' : undefined);
    pubKey = keyPair.pubKey;
  } else if (pubkeyHex) {
    if (pubkeyHex.length !== 64 || !/^[0-9a-fA-F]+$/.test(pubkeyHex)) throw new Error('--pubkey must be 32-byte hex');
    pubKey = Buffer.from(pubkeyHex, 'hex');
  } else {
    throw new Error('For rune-mint --count use --wif or --pubkey');
  }
  const { commitAddresses, totalRequired } = await inscribe.getRuneMintCommitAddresses(count, pubKey, {
    mainnet: !hasArg('testnet'),
    feeRate: getArgNum('fee-rate', 10),
  });
  const outPath = getArg('out');
  const orderPath = getArg('out-order');
  const result = { commitAddresses, totalRequired, count, runeId, pointer };
  writeOut(result, outPath, getArgBool('pretty') !== false);
  if (orderPath) {
    const order = {
      pubKey: Buffer.from(pubKey).toString('hex'),
      commitAddresses,
      count,
      runeId,
      pointer,
    };
    if (keyPair) order.privKeyHex = Buffer.from(keyPair.privKey).toString('hex');
    fs.writeFileSync(orderPath, JSON.stringify(order, null, 2), 'utf8');
    process.stderr.write('Wrote order manifest: ' + orderPath + '\n');
  }
}

async function cmdRuneReveal() {
  const commitTxid = getArg('commit-txid');
  const vout = getArgNum('vout', 0);
  const to = getArg('to');
  const orderPath = getArg('order');
  const wif = await getWifOrPrompt();
  if (!commitTxid || !to || !orderPath) throw new Error('Need --commit-txid, --to, --order');
  const order = await readJson(orderPath);
  const runeId = order.runeId;
  const pointer = order.pointer != null ? order.pointer : 1;
  if (!runeId) throw new Error('Order file must have runeId (from rune-mint --count --out-order)');
  const commitAddresses = order.commitAddresses || [];
  const requiredAmount = commitAddresses[vout]?.requiredAmount || order.commitAddresses?.[vout]?.requiredAmount;
  const value = getArgNum('value', requiredAmount ? Number(requiredAmount) : 0);
  if (!value) throw new Error('Commit UTXO value unknown; set --value or ensure order has commitAddresses[vout].requiredAmount');
  let privKey;
  let pubKey;
  if (wif) {
    const k = keyFromWif(wif, hasArg('testnet') ? 'testnet' : undefined);
    privKey = k.privKey;
    pubKey = k.pubKey;
  } else if (order.privKeyHex && order.pubKey) {
    privKey = new Uint8Array(Buffer.from(order.privKeyHex, 'hex'));
    pubKey = Buffer.from(order.pubKey, 'hex');
  } else {
    throw new Error('Need --wif, INSCRIBE_WIF, or --prompt-wif to sign rune reveal');
  }
  const commitUtxo = { txid: commitTxid, vout, value };
  const { rawTxHex, txid } = await inscribe.buildRuneMintRevealTx(
    commitUtxo,
    runeId,
    pointer,
    pubKey,
    privKey,
    to,
    { mainnet: !hasArg('testnet'), feeRate: getArgNum('fee-rate', 2) }
  );
  const chain = getArg('chain') || 'fractal';
  if (hasArg('push')) {
    const pushed = await pushTx(rawTxHex, chain);
    process.stderr.write(`Pushed to ${chain}: ${pushed}\n`);
  }
  writeOut({ rawTxHex, txid }, getArg('out'), getArgBool('pretty') !== false);
}

async function cmdRuneEtch() {
  const runeName = getArg('rune') || getArg('name');
  if (!runeName) throw new Error('Need --rune <name> (e.g. AABBCCDD)');
  const wif = getArg('wif');
  const pubkeyHex = getArg('pubkey');
  let pubKey;
  if (wif) {
    pubKey = keyFromWif(wif, hasArg('testnet') ? 'testnet' : undefined).pubKey;
  } else if (pubkeyHex) {
    if (pubkeyHex.length !== 64 || !/^[0-9a-fA-F]+$/.test(pubkeyHex)) throw new Error('--pubkey must be 32-byte hex');
    pubKey = Buffer.from(pubkeyHex, 'hex');
  } else {
    throw new Error('Need --wif or --pubkey');
  }
  const etchParams = { rune: runeName };
  const amount = getArgNum('amount', null);
  if (amount != null) etchParams.amount = amount;
  const cap = getArgNum('cap', null);
  if (cap != null) etchParams.cap = cap;
  const divisibility = getArgNum('divisibility', null);
  if (divisibility != null) etchParams.divisibility = divisibility;
  const symbol = getArg('symbol');
  if (symbol != null && symbol !== '') etchParams.symbol = symbol;
  const premine = getArgNum('premine', null);
  if (premine != null) etchParams.premine = premine;
  const startHeight = getArgNum('start-height', null);
  if (startHeight != null) etchParams.startHeight = startHeight;
  const endHeight = getArgNum('end-height', null);
  if (endHeight != null) etchParams.endHeight = endHeight;
  const startOffset = getArgNum('start-offset', null);
  if (startOffset != null) etchParams.startOffset = startOffset;
  const endOffset = getArgNum('end-offset', null);
  if (endOffset != null) etchParams.endOffset = endOffset;
  const pointer = getArgNum('pointer', null);
  if (pointer != null) etchParams.pointer = pointer;
  const contentType = getArg('content-type');
  const bodyPath = getArg('body');
  if (bodyPath) {
    etchParams.body = fs.readFileSync(bodyPath);
    etchParams.contentType = contentType || 'text/plain';
  } else if (contentType) {
    etchParams.contentType = contentType;
    etchParams.body = Buffer.from(getArg('content') || '', 'utf8');
  }
  const info = await inscribe.getEtchCommitAddress(etchParams, pubKey, {
    mainnet: !hasArg('testnet'),
    feeRate: getArgNum('fee-rate', 10),
  });
  writeOut(info, getArg('out'), getArgBool('pretty') !== false);
  const outOrderPath = getArg('out-order');
  if (outOrderPath) {
    const etchParamsSerializable = { ...etchParams };
    if (Buffer.isBuffer(etchParams.body)) etchParamsSerializable.body = etchParams.body.toString('base64');
    else if (etchParams.body instanceof Uint8Array) etchParamsSerializable.body = Buffer.from(etchParams.body).toString('base64');
    const pubKeyHexOut = Buffer.isBuffer(pubKey) ? pubKey.toString('hex') : (pubKey instanceof Uint8Array ? Buffer.from(pubKey).toString('hex') : pubKey);
    const order = {
      scriptHex: info.scriptHex,
      etchParams: etchParamsSerializable,
      pubKey: pubKeyHexOut,
      address: info.address,
      requiredAmount: info.requiredAmount,
    };
    fs.writeFileSync(outOrderPath, JSON.stringify(order, null, 2), 'utf8');
    process.stderr.write('Wrote etch order: ' + outOrderPath + ' (use rune-etch-reveal with --order ' + outOrderPath + ')\n');
  }
  process.stderr.write('Send ' + info.requiredAmount + ' sats to ' + info.address + ' then rune-etch-reveal --commit-txid <TXID> --vout 0 --order ' + (outOrderPath || '<order.json>') + ' [--push]\n');
}

async function cmdRuneEtchReveal() {
  const commitTxid = getArg('commit-txid');
  const vout = getArgNum('vout', 0);
  const orderPath = getArg('order');
  if (!commitTxid || !orderPath) throw new Error('Need --commit-txid and --order (from rune-etch --out-order)');
  const order = await readJson(orderPath);
  if (!order.scriptHex || !order.etchParams) throw new Error('Order must have scriptHex and etchParams');
  const value = getArgNum('value', null) ?? (order.requiredAmount ? Number(order.requiredAmount) : null);
  if (value == null) throw new Error('Need --value <sats> or order.requiredAmount');
  const wif = await getWifOrPrompt();
  if (!wif) throw new Error('Need --wif (or INSCRIBE_WIF or --prompt-wif) to sign etch reveal');
  const keyPair = keyFromWif(wif.trim(), hasArg('testnet') ? 'testnet' : undefined);
  const commitUtxo = { txid: commitTxid, vout, value };
  const etchParams = order.etchParams;
  if (etchParams.body && typeof etchParams.body === 'string') {
    etchParams.body = Buffer.from(etchParams.body, 'base64');
  }
  const pubKey = typeof order.pubKey === 'string' ? Buffer.from(order.pubKey, 'hex') : order.pubKey;
  const { rawTxHex, txid } = await inscribe.buildEtchRevealTx(
    commitUtxo,
    etchParams,
    order.scriptHex,
    pubKey,
    keyPair.privKey,
    { mainnet: !hasArg('testnet'), feeRate: getArgNum('fee-rate', 2) }
  );
  const chain = getArg('chain') || 'fractal';
  if (hasArg('push')) {
    const pushed = await pushTx(rawTxHex, chain);
    process.stderr.write('Pushed to ' + chain + ': ' + pushed + '\n');
  }
  writeOut({ rawTxHex, txid }, getArg('out'), getArgBool('pretty') !== false);
}

async function cmdRuneTransfer() {
  const utxosPath = getArg('utxos');
  const edictsArg = getArg('edicts');
  const changeAddress = getArg('change-address');
  if (!utxosPath || !edictsArg || !changeAddress) throw new Error('Need --utxos, --edicts, --change-address');
  const utxos = await readJson(utxosPath);
  const list = Array.isArray(utxos) ? utxos : (utxos.utxos || [utxos]);
  if (!list.length) throw new Error('No UTXOs in --utxos');
  const edictParts = [];
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--edicts' && args[i + 1]) {
      const v = args[i + 1];
      edictParts.push(...v.split(',').map(s => s.trim()).filter(Boolean));
    }
  }
  if (edictParts.length === 0) edictParts.push(...edictsArg.split(',').map(s => s.trim()).filter(Boolean));
  const edicts = edictParts.map(s => {
    const parts = s.split(':');
    if (parts.length < 4) throw new Error('Each edict: block:tx:amount:outputIndex (e.g. 123456:0:1000:1)');
    const [block, txIdx, amount, outputIndex] = parts;
    return { id: block + ':' + txIdx, amount: Number(amount), output: parseInt(outputIndex, 10) };
  });
  const pointer = getArgNum('pointer', null);
  const wif = await getWifOrPrompt();
  if (!wif) throw new Error('Need --wif for rune transfer');
  const opts = { mainnet: !hasArg('testnet'), feeRate: getArgNum('fee-rate', 2) };
  const { rawTxHex, txid } = await inscribe.buildRuneTransferTx(list, edicts, changeAddress, pointer, wif.trim(), opts);
  const chain = getArg('chain') || 'fractal';
  if (hasArg('push')) {
    const pushed = await pushTx(rawTxHex, chain);
    process.stderr.write('Pushed to ' + chain + ': ' + pushed + '\n');
  }
  writeOut({ rawTxHex, txid }, getArg('out'), getArgBool('pretty') !== false);
}

async function cmdFile() {
  const filesArg = getArg('files');
  if (!filesArg) throw new Error('Need --files path1,path2,...');
  process.argv.push('--files', filesArg);
  return cmdCommits();
}

async function cmdFeeRate() {
  const url = getArg('api') || 'https://mempool.space/api/v1/fees/recommended';
  const rate = await fetchFeeRate(url);
  process.stdout.write(String(rate) + '\n');
}

const UTXO_API = {
  fractal: 'https://mempool.fractalbitcoin.io/api/address',
  bitcoin: 'https://mempool.space/api/address',
};

const UNISAT_BASE = {
  fractal: 'https://open-api-fractal.unisat.io',
  bitcoin: 'https://open-api.unisat.io',
};

async function cmdFetchUtxos() {
  const address = getArg('address');
  if (!address) throw new Error('Need --address');
  const chain = getArg('chain') || 'fractal';
  const noInscriptions = hasArg('no-inscriptions') || hasArg('available-only');

  if (noInscriptions) {
    const apiKey = getArg('api-key') || process.env.UNISAT_API_KEY || '';
    if (!apiKey) throw new Error('--no-inscriptions requires --api-key or UNISAT_API_KEY (Unisat available-utxo excludes inscriptions/runes/alkanes)');
    const base = UNISAT_BASE[chain] || UNISAT_BASE.fractal;
    const bitcoin = require('bitcoinjs-lib');
    const ecc = require('@bitcoinerlab/secp256k1');
    bitcoin.initEccLib(ecc);
    const network = hasArg('testnet') ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;
    const defaultScriptPk = Buffer.from(bitcoin.address.toOutputScript(address, network)).toString('hex');
    const all = [];
    let cursor = 0;
    const size = 100;
    for (;;) {
      const url = `${base}/v1/indexer/address/${encodeURIComponent(address)}/available-utxo-data?cursor=${cursor}&size=${size}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!res.ok) throw new Error(`Unisat available-utxo failed: ${res.status} ${url}`);
      const json = await res.json();
      if (json.code !== 0) throw new Error(json.msg || 'Unisat available-utxo error');
      const list = json.data?.utxo || [];
      for (const u of list) {
        all.push({
          txid: u.txid,
          vout: u.vout ?? u.vout_index ?? u.index ?? 0,
          value: u.satoshi ?? u.value ?? 0,
          scriptPubKey: u.scriptPk || u.scriptPubKey || defaultScriptPk,
        });
      }
      if (list.length < size) break;
      cursor = json.data?.cursor ?? cursor + size;
    }
    process.stderr.write(`Fetched ${all.length} UTXOs (no inscriptions/runes/alkanes) for commit funding.\n`);
    writeOut(all, getArg('out'), getArgBool('pretty') !== false);
    return;
  }

  const base = UTXO_API[chain] || UTXO_API.fractal;
  const url = `${base}/${address}/utxo`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`UTXO fetch failed: ${res.status} ${url}`);
  const list = await res.json();
  if (!Array.isArray(list)) throw new Error('UTXO API did not return an array');
  const bitcoin = require('bitcoinjs-lib');
  const ecc = require('@bitcoinerlab/secp256k1');
  bitcoin.initEccLib(ecc);
  const network = hasArg('testnet') ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;
  const scriptBuf = bitcoin.address.toOutputScript(address, network);
  const scriptPubKey = Buffer.from(scriptBuf).toString('hex');
  const utxos = list.map((u) => ({
    txid: u.txid,
    vout: u.vout ?? u.vout_index ?? u.index ?? 0,
    value: u.value ?? u.satoshi ?? 0,
    scriptPubKey,
  }));
  writeOut(utxos, getArg('out'), getArgBool('pretty') !== false);
}

async function cmdAddress() {
  const wif = getArg('wif') || process.env.INSCRIBE_WIF;
  if (!wif) throw new Error('Need --wif or INSCRIBE_WIF');
  const network = hasArg('testnet') ? 'testnet' : undefined;
  const addr = nativeSegwitAddressFromWif(wif, network);
  process.stdout.write(addr + '\n');
}

async function cmdOpReturn() {
  const utxosPath = getArg('utxos');
  const message = getArg('message');
  const changeAddress = getArg('change-address');
  if (!utxosPath || message == null || !changeAddress) throw new Error('Need --utxos, --message, --change-address');
  const utxos = await readJson(utxosPath);
  const list = Array.isArray(utxos) ? utxos : (utxos.utxos || [utxos]);
  if (!list.length) throw new Error('No UTXOs in --utxos');
  const wif = await getWifOrPrompt();
  if (!wif) throw new Error('Need --wif, INSCRIBE_WIF, or --prompt-wif to sign OP_RETURN tx');
  const opts = { mainnet: !hasArg('testnet'), feeRate: getArgNum('fee-rate', 2) };
  const { rawTxHex, txid } = await inscribe.buildSignedOpReturnTx(list, message, changeAddress, wif.trim(), opts);
  const chain = getArg('chain') || 'fractal';
  if (hasArg('push')) {
    const pushed = await pushTx(rawTxHex, chain);
    process.stderr.write(`Pushed to ${chain}: ${pushed}\n`);
  }
  writeOut({ rawTxHex, txid }, getArg('out'), getArgBool('pretty') !== false);
}

async function cmdSignCommit() {
  const psbtArg = getArg('psbt');
  if (!psbtArg) throw new Error('Need --psbt (path to JSON with psbtBase64, or base64 string, or - for stdin)');
  let psbtBase64;
  if (psbtArg === '-') {
    const chunks = [];
    process.stdin.setEncoding('utf8');
    for await (const c of process.stdin) chunks.push(c);
    psbtBase64 = chunks.join('').trim();
  } else if (psbtArg.length < 200 && !psbtArg.includes('\n')) {
    try {
      const j = await readJson(psbtArg);
      psbtBase64 = j.psbtBase64 || j.psbt;
    } catch (_) {
      psbtBase64 = psbtArg;
    }
  } else {
    psbtBase64 = psbtArg;
  }
  const wif = await getWifOrPrompt();
  if (!wif) throw new Error('Need --wif, INSCRIBE_WIF, or --prompt-wif to sign');
  const bitcoin = require('bitcoinjs-lib');
  const ecc = require('@bitcoinerlab/secp256k1');
  const ECPairFactory = require('ecpair');
  bitcoin.initEccLib(ecc);
  const network = hasArg('testnet') ? bitcoin.networks.testnet : undefined;
  const ECPair = (ECPairFactory.default || ECPairFactory)(ecc);
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network });
  const keyPair = ECPair.fromWIF(wif.trim(), network);
  psbt.signAllInputs(keyPair);
  const validator = (pubkey, hash, signature) => {
    try {
      if (ecc.verify(hash, pubkey, signature)) return true;
    } catch (_) {}
    try {
      if (ecc.verifySchnorr && ecc.verifySchnorr(hash, pubkey, signature)) return true;
    } catch (_) {}
    return false;
  };
  try {
    psbt.validateSignaturesOfAllInputs(validator);
  } catch (e) {
    throw new Error('Signature validation failed: ' + e.message);
  }
  psbt.finalizeAllInputs();
  const tx = psbt.extractTransaction();
  const rawTxHex = tx.toHex();
  const txid = tx.getId();
  const chain = getArg('chain') || 'fractal';
  if (hasArg('push')) {
    const pushed = await pushTx(rawTxHex, chain);
    process.stderr.write(`Pushed to ${chain}: ${pushed}\n`);
  }
  writeOut({ rawTxHex, txid }, getArg('out'), getArgBool('pretty') !== false);
}

// ─── Main ──────────────────────────────────────────────────────────────────

const commands = {
  help: cmdHelp,
  commits: cmdCommits,
  'commit-psbt': cmdCommitPsbt,
  reveal: cmdReveal,
  'reveal-bulk': cmdRevealBulk,
  'sign-commit': cmdSignCommit,
  'brc20-deploy': cmdBrc20Deploy,
  'brc20-transfer': cmdBrc20Transfer,
  'brc20-single-step': cmdBrc20SingleStep,
  'brc20-mint': cmdBrc20Mint,
  'rune-mint': cmdRuneMint,
  'rune-reveal': cmdRuneReveal,
  'rune-etch': cmdRuneEtch,
  'rune-etch-reveal': cmdRuneEtchReveal,
  'rune-transfer': cmdRuneTransfer,
  file: cmdFile,
  'fee-rate': cmdFeeRate,
  'fetch-utxos': cmdFetchUtxos,
  opreturn: cmdOpReturn,
  address: cmdAddress,
};

async function main() {
  const args = process.argv.slice(2);
  const sub = args[0];
  if (!sub || sub === '-h' || sub === '--help') {
    await cmdHelp(args[1] || null);
    process.exit(0);
  }
  if (sub === 'help') {
    await cmdHelp(args[1] || null);
    process.exit(0);
  }
  const cmd = commands[sub];
  if (!cmd) {
    process.stderr.write('Unknown command: ' + sub + '\n');
    await cmdHelp(null);
    process.exit(1);
  }
  if (['commits', 'reveal', 'reveal-bulk', 'rune-etch-reveal', 'rune-transfer'].includes(sub)) {
    await bootstrapBtcOrdinals();
  }
  try {
    await cmd();
  } catch (e) {
    process.stderr.write('Error: ' + e.message + '\n');
    if (process.env.DEBUG) process.stderr.write(e.stack + '\n');
    process.exit(1);
  }
}

main();
