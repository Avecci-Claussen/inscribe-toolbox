# Inscribe Toolbox — Full CLI Reference

CLI and library for inscribing on **Fractal Bitcoin (FB)** and **Bitcoin (BTC)**: arbitrary files, BRC-20 deploy/mint/transfer (including **BP07 single-step** on FB), rune mint/etch/transfer, and OP_RETURN messages.

**Non-custodial.** This tool does not hold, store, or transmit your keys. You run it on your own machine. You keep full control of your keys and funds at all times.

**Build without your key.** Almost all "build" steps (generating commit addresses, building PSBTs, fetching UTXOs) work with your **public key only** (`--pubkey <hex>`). You never have to give the tool your private key for those steps. The tool outputs **PSBTs** (Partially Signed Bitcoin Transactions) and commit addresses; no signature is created until you run a **signing** command. Only when you run **sign-commit**, **reveal**, **rune-reveal**, **rune-etch-reveal**, **rune-transfer**, or **opreturn** do you need to provide your signing key—and only to sign, locally. So you can separate: (1) **building** (no key, use `--pubkey`) and (2) **signing** (key only at sign time, e.g. on an offline machine or dedicated signer).

---

## Table of contents

1. [Install & run](#1-install--run)
2. [Build without key vs sign when needed](#2-build-without-key-vs-sign-when-needed)
3. [Global options](#3-global-options)
4. [Core flow: commit → reveal](#4-core-flow-commit--reveal)
5. [Commands reference](#5-commands-reference)
6. [End-to-end examples](#6-end-to-end-examples)
7. [Chains & BP07](#7-chains--bp07)
8. [Security](#8-security)
9. [License](#9-license)

---

## 1. Install & run

### Requirements

- **Node.js** ≥ 18  
- For **building** (commit addresses, PSBTs): your **public key** (32-byte hex, x-only) is enough; use `--pubkey <hex>`.  
- For **signing** (sign-commit, reveal, rune-reveal, etc.): your **signing key** (Bitcoin private key in WIF format). You provide it only when you run a signing command; the tool never stores it or sends it anywhere. Use `INSCRIBE_WIF`, `--wif`, or `--prompt-wif` so it does not appear in shell history.

### Install

```bash
cd inscribe-toolbox
npm install
```

### Run the CLI

```bash
# List all commands
node lib/inscribe-cli.js help

# Help for a specific command
node lib/inscribe-cli.js help reveal
node lib/inscribe-cli.js help brc20-transfer
```

If you install globally or link the bin, you can run `inscribe help` (see `package.json` → `bin`).

---

## 2. Build without key vs sign when needed

| **No private key needed** (use `--pubkey` or nothing) | **Signing key needed** (only to sign) |
|------------------------------------------------------|---------------------------------------|
| `commits` (with `--pubkey`) — commit addresses + order | `sign-commit` — sign PSBT |
| `commit-psbt` — build PSBT from UTXOs + outputs | `reveal` — sign reveal tx |
| `fetch-utxos` — list UTXOs for an address | `reveal-bulk` — sign many reveals |
| `fee-rate` — recommended fee | `rune-reveal` — sign rune mint reveal |
| `brc20-deploy` (with `--pubkey`) — deploy commit address | `rune-etch-reveal` — sign etch reveal |
| `brc20-mint` (with `--pubkey`) — mint commit addresses | `rune-transfer` — sign transfer tx |
| `brc20-transfer` (with `--pubkey`) — transfer order + commit addresses | `opreturn` — sign OP_RETURN tx |
| `rune-mint` (with `--pubkey`) — rune mint commit addresses | `address` — derive address from key (optional; you can use another wallet's address) |
| `rune-etch` (with `--pubkey`) — etch commit address | |

**Typical split:** A **builder** (or script) runs commits with `--pubkey`, fetch-utxos, commit-psbt → produces a **PSBT** and order file. The **signer** (you or a dedicated device) runs sign-commit with the PSBT and, later, reveal with the order file. The signer never has to run build steps; the builder never has to see the private key.

---

## 3. Global options

These apply wherever the CLI supports them:

| Option | Description |
|--------|-------------|
| `--chain <fractal\|bitcoin>` | Chain for broadcast and APIs. Default: **fractal**. |
| `--wif <WIF>` | Your signing key (WIF format). Used only to sign locally; not stored or sent. Prefer `INSCRIBE_WIF` or `--prompt-wif` so the key is not on the command line. |
| `--prompt-wif` | Ask for your signing key interactively (key is not stored in shell history). |
| `--pubkey <hex>` | Public key only (32-byte hex). Use for **commits-only** when you do not want to provide a signing key yet; signing (e.g. reveal) still requires your key. |
| `--to <address>` | Recipient address for inscriptions (used by reveal, rune-reveal, etc.). |
| `--out <path>` | Write JSON output to file. Default: stdout. |
| `--push` | After building a signed tx, broadcast it to the chain. |
| `--push-url <url>` | Override broadcast API (e.g. Unisat: `https://open-api-fractal.unisat.io/v1/indexer/local_pushtx`). |
| `--fee-rate <n>` | Fee in sat/vB (defaults vary by command). |
| `--mainnet` / `--testnet` | Network; default mainnet. |
| `--pretty` / `--no-pretty` | Pretty-print JSON (default: pretty). |

---

## 4. Core flow: commit → reveal

Inscribing uses a **two-phase** flow:

1. **Commit** — You create one or more **commit outputs** (addresses that receive sats and will later be spent to reveal the inscription). You pay for those outputs with a normal Bitcoin tx (built via UTXOs + `commit-psbt` + `sign-commit`).
2. **Reveal** — You spend each commit UTXO in a **reveal tx** that attaches the inscription to an output (usually the `--to` address).

### Step-by-step (generic)

```bash
# 1) Generate commit addresses + order manifest (no key: use --pubkey)
node lib/inscribe-cli.js commits --brc20 "TICK:100:1" --pubkey <YOUR_32BYTE_PUBKEY_HEX> --out commits.json --out-order order.json

# 2) Fetch UTXOs for the address that will pay for the commit (no key)
node lib/inscribe-cli.js fetch-utxos --address <your-funding-address> --chain fractal --out utxos.json

# 3) Build the commit PSBT — UTXOs → commit outputs + change (no key)
node lib/inscribe-cli.js commit-psbt --utxos utxos.json --outputs commits.json --change-address <your-funding-address> --out psbt.json

# 4) Sign the PSBT and optionally broadcast (key needed only here)
node lib/inscribe-cli.js sign-commit --psbt psbt.json --wif <WIF> --push --chain fractal --out commit-result.json

# 5) Reveal: sign and send inscription to --to (key needed)
node lib/inscribe-cli.js reveal --commit-txid <TXID_FROM_STEP_4> --vout 0 --to <recipient> --order order.json --value <requiredAmount_from_commits> --wif <WIF> --push --chain fractal
```

- **commit txid** and **vout** identify the commit UTXO.  
- **value** must match the commit output's amount (e.g. from `commits.json` or `order.json` → `commitAddresses[vout].requiredAmount`).  
- For multiple inscriptions in one commit tx, repeat step 5 with `--vout 1`, `--vout 2`, … and the correct `--value` for each.
- You can run steps 1–3 with `--pubkey` only; then hand the PSBT and order file to a signer who runs steps 4 and 5 with the key.

---

## 5. Commands reference

### commits

Generate **commit addresses** (and optionally an **order manifest** for reveal). Input is one of: files, BRC-20 batch, BRC-20 deploy, or stdin. **No private key needed:** use `--pubkey <hex>` (your 32-byte x-only public key) to build; only signing steps (sign-commit, reveal) need your key.

```bash
node lib/inscribe-cli.js commits [options]
```

**Input (one of):**

| Option | Description |
|--------|-------------|
| `--files <path1,path2,...>` | File paths. Content-type from extension or `--content-type`. |
| `--brc20 <tick:amt:count>` | BRC-20 mint batch (e.g. `COIN:1000:100`). |
| `--brc20-deploy <tick:max>` | BRC-20 deploy (e.g. `COIN:21000000`, optional `:lim:dec`). |
| `--stdin` | Read files array from stdin. |

**Options:**

| Option | Description |
|--------|-------------|
| `--pubkey <hex>` | 32-byte x-only pubkey; or use `--wif` to derive. |
| `--wif <WIF>` | Derive pubkey; store in order if `--out-order` is set. |
| `--out <path>` | Write commit addresses JSON. |
| `--out-order <path>` | Write order manifest (pubKey, inscriptionData, commitAddresses) for reveal. |
| `--parent <inscriptionId>` | Parent for parent–child (e.g. `txidi0`). |
| `--compress` | Gzip inscription body (content-encoding: gzip). |
| `--fee-rate <n>` | Sat/vB (default 10). |
| `--dev-fee <n>` | Total dev fee (sats) on last commit. |
| `--dev-addresses <addr1,addr2>` | Dev fee recipients. |

**Output:** `{ "commitAddresses": [ { "address", "requiredAmount", "vsize", ... } ], "totalRequired", "count" }`. With `--out-order`, the order file is required for `reveal`. `requiredAmount` is sized for the **reveal** tx (inscription output + fee) so little or no sats are left in the tap wallet after reveal.

---

### commit-psbt

Build a **commit PSBT**: your UTXOs fund the commit outputs and change.

```bash
node lib/inscribe-cli.js commit-psbt --utxos <path> --outputs <path> --change-address <addr> [options]
```

| Option | Description |
|--------|-------------|
| `--utxos <path>` | JSON array: `[{ "txid", "vout" or "index", "value" or "satoshi", "scriptPubKey" (hex) }]`. |
| `--outputs <path>` | JSON array: `[{ "address", "value" or "requiredAmount" }]` (e.g. from `commits --out`). |
| `--change-address` | Where change goes. |
| `--fee-rate <n>` | Sat/vB (default 10). |
| `--out <path>` | Write `{ "psbtBase64", "fee", "changeAmount" }`. |

---

### sign-commit

Sign the commit PSBT and optionally broadcast.

```bash
node lib/inscribe-cli.js sign-commit --psbt <path|base64> [--wif <WIF>] [--push] [--chain fractal|bitcoin]
```

| Option | Description |
|--------|-------------|
| `--psbt <path>` | File with `psbtBase64` or raw base64. Use `-` to read base64 from stdin. |
| `--wif` | Signing key (or `INSCRIBE_WIF` or `--prompt-wif`). |
| `--push` | Broadcast after signing. |
| `--chain` | fractal (default) or bitcoin. |
| `--out <path>` | Write `{ "rawTxHex", "txid" }`. |

---

### reveal

Build **one** reveal transaction: spend a commit UTXO and send the inscription to `--to`.

```bash
node lib/inscribe-cli.js reveal --commit-txid <txid> --vout <n> --to <addr> --order <path> --value <sats> [--wif <WIF>] [--push]
```

| Option | Description |
|--------|-------------|
| `--commit-txid` | Funding txid (the commit tx). |
| `--vout` | Output index of the commit UTXO (usually 0, 1, …). |
| `--to` | Recipient address for the inscription. |
| `--order <path>` | Order manifest from `commits --out-order`. |
| `--value <sats>` | Commit UTXO value (required if not in order). |
| `--inscription-index <n>` | Index into order's inscriptionData (default 0). |
| `--wif` | Signing key. |
| `--dev-fee`, `--dev-addresses` | Optional dev fee. |
| `--out <path>` | Write `{ "rawTxHex", "txid" }`. |

---

### reveal-bulk

Build **many** reveal transactions from a list of funded commits.

```bash
node lib/inscribe-cli.js reveal-bulk --funded <path> --order <path> --to <addr> --wif <WIF> [--push]
```

| Option | Description |
|--------|-------------|
| `--funded <path>` | JSON array: `[{ "commitTxid", "vout", "address", "value" }]`. |
| `--order <path>` | Order from `commits --out-order`. |
| `--to` | Recipient for all reveals. |
| `--wif` | Signing key. |
| `--push` | Broadcast each reveal. |
| `--out <path>` | Write array of `{ "txid", "rawTxHex", "vout" }`. |

---

### brc20-deploy

Output BRC-20 **deploy** JSON or generate commit address for one deploy.

```bash
node lib/inscribe-cli.js brc20-deploy --tick <TICK> --max <n> [--lim <n>] [--dec <n>] [--self-mint] [options]
```

- **Without** `--pubkey` / `--wif`: prints deploy JSON only.  
- **With** `--pubkey` or `--wif`: same as `commits --brc20-deploy` (outputs commit address + optional `--out` / `--out-order`).

| Option | Description |
|--------|-------------|
| `--tick` | Ticker (e.g. COIN). |
| `--max` | Max supply. |
| `--lim` | Mint limit per tx (optional). |
| `--dec` | Decimals (optional). |
| `--self-mint` | BP-04: only deployer can mint (mints use deploy as parent). |

Use the generated commit address in the usual commit → reveal flow.

---

### brc20-mint

BRC-20 **mint** batch (up to 1000) or generate commits.

```bash
node lib/inscribe-cli.js brc20-mint --tick <TICK> --amt <n> --count <n> [options]
```

- **Without** `--pubkey` / `--wif`: prints JSON array of file objects (for `commits --stdin`).  
- **With** `--pubkey` or `--wif`: generates commit addresses (same as `commits --brc20 tick:amt:count`). Use `--out` and `--out-order` for the commit flow.

---

### brc20-transfer

BRC-20 **transfer**: legacy (commit → reveal to address) or **BP07 single-step** (one commit→reveal, balance from signer; FB only).

```bash
node lib/inscribe-cli.js brc20-transfer --tick <TICK> --amt <n> [--single-step] [--address-type N] [options]
```

**Important:** Ticker is **case-sensitive** (e.g. `TheLonelyBit` not `thelonelybit`).

| Option | Description |
|--------|-------------|
| `--tick` | Exact ticker from token deploy. |
| `--amt` | Amount to transfer. |
| `--single-step` | BP07: one commit→reveal sends to recipient; balance source = signer. **Active on FB only.** |
| `--address-type <1..8>` | Default 1 (P2TR). With `--single-step` and `--wif`, defaults to 2 (P2WPKH) for bc1q/tb1q so indexers accept. |
| `--wif` | Required for signing; used with `--out-order` for reveal. |
| `--out` | Write commit addresses JSON. |
| `--out-order` | Write order for reveal (required for single-step reveal). |

**Single-step flow (FB):**  
1) `brc20-transfer --tick TICK --amt N --single-step --wif <WIF> --out-order order.json`  
2) Fetch UTXOs (`--no-inscriptions` recommended), build commit PSBT, sign-commit --push  
3) `reveal --commit-txid <id> --vout 0 --to <recipient> --order order.json --value <requiredAmount> --wif <WIF> --push --chain fractal`

---

### rune-mint

Rune **mint**: output Runestone hex (no commit) or generate commit addresses for bulk mints.

```bash
node lib/inscribe-cli.js rune-mint --rune-id <block:tx> [--count <n>] [options]
```

- **Without** `--count`: outputs Runestone encipher hex for one mint.  
- **With** `--count` and `--wif`/`--pubkey`: generates N commit addresses; use `--out-order` for rune-reveal. Then: commit-psbt → sign-commit --push → **rune-reveal** for each vout.

| Option | Description |
|--------|-------------|
| `--rune-id <block:tx>` | Rune ID (e.g. block:tx of etch). |
| `--count <n>` | Number of mints (commit addresses). |
| `--out`, `--out-order` | Same as commits. |

---

### rune-reveal

Build and sign **one** rune mint reveal: spend commit UTXO → OP_RETURN Runestone + recipient.

```bash
node lib/inscribe-cli.js rune-reveal --commit-txid <id> --vout <n> --to <addr> --order <path> [--value <sats>] [--push]
```

Order from `rune-mint --count --out-order`. Use `--value` if not in order. Signs with `--wif` or `INSCRIBE_WIF`.

---

### rune-etch

Get rune **etch** commit address. Fund it, then use **rune-etch-reveal** to complete the etch.

```bash
node lib/inscribe-cli.js rune-etch --rune <NAME> [--wif|--pubkey] [--body <file>] [options]
```

| Option | Description |
|--------|-------------|
| `--rune` | Rune name. |
| `--body <file>` | Optional body file for the etching. |
| `--amount <n>` | Supply per mint (default 1). |
| `--cap <n>` | Max mints (0 = unlimited). |
| `--divisibility <n>` | Decimal places. |
| `--symbol <c>` | Single character (e.g. ¢). |
| `--premine <n>` | Premine amount. |
| `--start-height`, `--end-height`, `--start-offset`, `--end-offset` | Minting window. |
| `--pointer <n>` | Etching pointer output index. |
| `--out-order <path>` | Save scriptHex + etchParams for rune-etch-reveal. |

---

### rune-etch-reveal

Spend the etch commit UTXO and emit the Runestone (etching) on chain.

```bash
node lib/inscribe-cli.js rune-etch-reveal --commit-txid <id> --vout <n> --order <path> --wif <WIF> [--push]
```

Order from `rune-etch --out-order`. Same chain as commit.

---

### rune-transfer

Build (and optionally push) a **rune transfer** tx with edicts.

```bash
node lib/inscribe-cli.js rune-transfer --utxos <path> --edicts "block:tx:amount:outputIndex" [--edicts ...] --change-address <addr> --wif <WIF> [--push]
```

| Option | Description |
|--------|-------------|
| `--utxos` | JSON array of UTXOs (must include rune UTXOs to transfer). |
| `--edicts` | One or more `block:tx:amount:outputIndex` (runeId = block:tx). |
| `--change-address` | Change output. |
| `--pointer <n>` | Optional runestone pointer. |
| `--chain` | fractal (default) or bitcoin. |

---

### file

Alias for **commits --files**: generate commit addresses for one or more files.

```bash
node lib/inscribe-cli.js file --files <path1,path2,...> [options]
```

Same options as commits (--out, --out-order, --wif, --compress, etc.).

---

### fee-rate

Print recommended fee rate (sat/vB) from a mempool API.

```bash
node lib/inscribe-cli.js fee-rate [--api <url>]
```

---

### fetch-utxos

Fetch UTXOs for an address (for use with commit-psbt).

```bash
node lib/inscribe-cli.js fetch-utxos --address <addr> [options]
```

**Output:** JSON array `[{ "txid", "vout", "value", "scriptPubKey" (hex) }]`.

| Option | Description |
|--------|-------------|
| `--chain` | fractal (default) or bitcoin. |
| `--no-inscriptions` | Use Unisat available-utxo API: only UTXOs with no inscriptions/runes/alkanes. Requires `--api-key` or `UNISAT_API_KEY`. Use so commit funding does not spend an inscription. |
| `--out <path>` | Write UTXOs to file. |

---

### address

Derive **native SegWit (P2WPKH, bc1q...)** address from WIF.

```bash
node lib/inscribe-cli.js address [--wif <WIF>]
```

Uses `INSCRIBE_WIF` if `--wif` not set. Use this address for funding and as change-address.

---

### opreturn

Write a message to chain (OP_RETURN output + change). Max **80 bytes** for standard relay.

```bash
node lib/inscribe-cli.js opreturn --utxos <path> --message <text|hex> --change-address <addr> [--push]
```

| Option | Description |
|--------|-------------|
| `--utxos` | JSON array (e.g. from fetch-utxos --out). |
| `--message` | UTF-8 text or hex (0x...). |
| `--change-address` | Change output. |
| `--fee-rate <n>` | Sat/vB (default 2). |
| `--push`, `--chain` | Broadcast. |

WIF: `INSCRIBE_WIF` or `--wif` or `--prompt-wif`.

---

## 6. End-to-end examples

### A. Inscribe a text file

```bash
node lib/inscribe-cli.js commits --files note.txt --wif <WIF> --out c.json --out-order o.json
node lib/inscribe-cli.js fetch-utxos --address $(node lib/inscribe-cli.js address --wif <WIF>) --chain fractal --out u.json
node lib/inscribe-cli.js commit-psbt --utxos u.json --outputs c.json --change-address $(node lib/inscribe-cli.js address --wif <WIF>) --out psbt.json
node lib/inscribe-cli.js sign-commit --psbt psbt.json --wif <WIF> --push --chain fractal --out res.json
# Use txid from res.json and requiredAmount from c.json:
node lib/inscribe-cli.js reveal --commit-txid <TXID> --vout 0 --to bc1q... --order o.json --value <requiredAmount> --wif <WIF> --push --chain fractal
```

### B. BRC-20 deploy

```bash
node lib/inscribe-cli.js brc20-deploy --tick MYCOIN --max 21000000 --wif <WIF> --out c.json --out-order o.json
# Then: fetch-utxos → commit-psbt → sign-commit --push → reveal (same as above).
```

### C. BRC-20 mint (batch of 10)

```bash
node lib/inscribe-cli.js brc20-mint --tick MYCOIN --amt 1000 --count 10 --wif <WIF> --out c.json --out-order o.json
# Then: fetch-utxos → commit-psbt (outputs from c.json) → sign-commit --push.
# Then for each vout 0..9: reveal --commit-txid <TXID> --vout <i> --to <addr> --order o.json --value <requiredAmount> --push
# Or use reveal-bulk with a funded manifest.
```

### D. BRC-20 transfer (single-step BP07 on Fractal)

```bash
node lib/inscribe-cli.js brc20-transfer --tick TheLonelyBit --amt 10 --single-step --wif <WIF> --chain fractal --out-order order.json
node lib/inscribe-cli.js fetch-utxos --address $(node lib/inscribe-cli.js address --wif <WIF>) --no-inscriptions --chain fractal --out utxos.json
node lib/inscribe-cli.js commit-psbt --utxos utxos.json --outputs <commits-from-order> --change-address $(node lib/inscribe-cli.js address --wif <WIF>) --out psbt.json
node lib/inscribe-cli.js sign-commit --psbt psbt.json --wif <WIF> --chain fractal --push
node lib/inscribe-cli.js reveal --commit-txid <TXID> --vout 0 --to <recipient> --order order.json --value <requiredAmount> --wif <WIF> --chain fractal --push
```

### E. Rune mint (3 mints)

```bash
node lib/inscribe-cli.js rune-mint --rune-id 123456:0 --count 3 --wif <WIF> --out c.json --out-order o.json
# fetch-utxos → commit-psbt → sign-commit --push
node lib/inscribe-cli.js rune-reveal --commit-txid <TXID> --vout 0 --to bc1q... --order o.json --push --chain fractal
node lib/inscribe-cli.js rune-reveal --commit-txid <TXID> --vout 1 --to bc1q... --order o.json --push --chain fractal
node lib/inscribe-cli.js rune-reveal --commit-txid <TXID> --vout 2 --to bc1q... --order o.json --push --chain fractal
```

### F. Rune etch

```bash
node lib/inscribe-cli.js rune-etch --rune MYRUNE --wif <WIF> --out e.json --out-order e-order.json
# Send requiredAmount from e.json to the address in e.json
node lib/inscribe-cli.js rune-etch-reveal --commit-txid <FUNDING_TXID> --vout 0 --order e-order.json --wif <WIF> --push --chain fractal
```

### G. Rune transfer (edicts)

```bash
node lib/inscribe-cli.js rune-transfer --utxos utxos.json --edicts "1448178:1873:1000:0" --change-address bc1q... --wif <WIF> --push --chain fractal
# outputIndex 0 = first output (e.g. recipient), 1 = second, etc.
```

### H. OP_RETURN message (≤80 bytes)

```bash
node lib/inscribe-cli.js fetch-utxos --address bc1q... --out u.json
node lib/inscribe-cli.js opreturn --utxos u.json --message "Hello chain" --change-address bc1q... --wif <WIF> --push --chain fractal
```

---

## 7. Chains & BP07

- **Fractal Bitcoin (FB):** `--chain fractal` (default). Used for FB testnet/mainnet.
- **Bitcoin (BTC):** `--chain bitcoin` for Bitcoin mainnet.

**BP07 single-step transfer:**  
Single-step BRC-20 transfer (one commit→reveal, balance from signer) is **active only on Fractal Bitcoin**. On Bitcoin mainnet it is not activated; the CLI warns. Use `--single-step` only when targeting FB. Spec: [bp07-single-step-transfer](https://github.com/unisat-wallet/brc20-proposals/tree/main/bp07-single-step-transfer).

---

## 8. Security

- **Your keys stay with you.** The tool is non-custodial: it never stores or transmits your signing key. You provide it only when signing, and you can use `INSCRIBE_WIF` or `--prompt-wif` so it never appears on the command line or in shell history.
- **Order files** (`--out-order`) may contain your public key; do not add or commit files that contain your private key (`privKeyHex`).
- **fetch-utxos --no-inscriptions** (with Unisat API key) returns only "available" UTXOs so you do not accidentally spend an inscription UTXO as fee/change.
- Keep your keys secure and never share them or paste them in issues, PRs, or public channels.

---

## 9. License

MIT. See `LICENSE`.
