# Prefunding an ICME API Key for Floe Devs

This guide walks through creating and funding an ICME Preflight API key that you can share with Floe developers.

## Floe Devs API Key (Already Created)

```bash
ICME_API_KEY=sk-smt-floe-devs-d26d0ac324f04f7aa8bd5f5afcff6800
ICME_BASE_URL=https://api.icme.io/v1
```

| Field | Value |
|-------|-------|
| **API Key** | `sk-smt-floe-devs-d26d0ac324f04f7aa8bd5f5afcff6800` |
| **Username** | `floe-devs` |
| **User ID** | `7c7ab46f-4597-4490-ab93-bce729b0cb34` |

**Check balance anytime:**
```bash
curl -s https://api.icme.io/v1/me \
  -H 'X-API-Key: sk-smt-floe-devs-d26d0ac324f04f7aa8bd5f5afcff6800'
```

---

## Overview

- **Cost:** $5 USDC on Base (account creation) + additional top-ups as needed
- **Result:** API key + credits that Floe devs can use immediately
- **Network:** Base (chain ID 8453)
- **USDC Contract on Base:** `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`

---

## Step 1: Set Up a Base Wallet

You need an Ethereum-compatible wallet that supports the Base network.

**Options:**
- [Coinbase Wallet](https://www.coinbase.com/wallet) - Native Base support (recommended)
- [MetaMask](https://metamask.io/) - Browser extension + mobile
- [Rainbow](https://rainbow.me/) - Mobile-first

**Add Base network to MetaMask (if needed):**
- Network Name: `Base`
- RPC URL: `https://mainnet.base.org`
- Chain ID: `8453`
- Currency: `ETH`
- Explorer: `https://basescan.org`

---

## Step 2: Get USDC on Base

You need USDC (not ETH) on the Base network. Options:

1. **From Coinbase:** Buy USDC, withdraw to your wallet selecting "Base" as the network
2. **Bridge:** Use [bridge.base.org](https://bridge.base.org) to bridge USDC from Ethereum
3. **Swap:** If you have ETH on Base, swap for USDC on [Uniswap](https://app.uniswap.org/)

**Recommended amount:**
- **$25 USDC** - Basic experimentation (~10 policy compilations)
- **$50 USDC** - Comfortable experimentation (~18 policy compilations + 600 checks)

**Credit costs:**
- Compile policy (`makeRules`): 300 credits
- Run check (`checkIt`): 1 credit
- Verify proof (`verifyProof`): Free

---

## Step 3: Create the ICME Account

> **IMPORTANT:** Use `POST /v1/createUser` (NOT `createUserX402`). The x402 endpoint requires EIP-3009 signatures which need special client libraries. The `createUser` endpoint accepts regular USDC transfers.

### 3a. Initial Request (get deposit address)

```bash
curl -s -X POST https://api.icme.io/v1/createUser \
  -H 'Content-Type: application/json' \
  -d '{"username":"your-username"}'
```

**Example response:**
```json
{
  "payTo": "0xca3cf27448bef5c07756fe80f1eb58bd7a1d1bfb",
  "stripePaymentIntentId": "pi_3TWFBNIk3or7l4Yr2npI7nix",
  "error": "Payment required. Send $5.00 USDC to the deposit address below, then retry with stripe_payment_intent_id."
}
```

**Important:** The `payTo` address is **unique per request**. Always use the address returned by the API.

### 3b. Send USDC Payment

Send **exactly $5.00 USDC** on Base to the `payTo` address from step 3a.

**Checklist:**
- ✅ Exactly $5.00 USDC (not more, not less)
- ✅ Base network (chain ID 8453)
- ✅ To the `payTo` address from the API response
- ✅ Save the `stripePaymentIntentId` for the next step

### 3c. Complete Account Creation

After the transaction confirms (~30 seconds on Base), retry with the `stripe_payment_intent_id`:

```bash
curl -s -X POST https://api.icme.io/v1/createUser \
  -H 'Content-Type: application/json' \
  -d '{
    "username":"your-username",
    "stripe_payment_intent_id":"pi_3TWFBNIk3or7l4Yr2npI7nix"
  }'
```

**Success response:**
```json
{
  "user_id": "7c7ab46f-4597-4490-ab93-bce729b0cb34",
  "username": "floe-devs",
  "api_key": "sk-smt-floe-devs-d26d0ac324f04f7aa8bd5f5afcff6800",
  "credits": 325,
  "message": "Account created with 325 starting credits."
}
```

> **⚠️ CRITICAL:** Save the `api_key` immediately! It is shown only once and cannot be recovered.

---

## Step 4: Top Up Credits

### 4a. Get top-up tiers and deposit address

```bash
curl -s -X POST https://api.icme.io/v1/topUp \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: YOUR_API_KEY' \
  -d '{"amount_usd": 10}'
```

**Example response:**
```json
{
  "payTo": "0xc9c2745c74d56130c553e55fdbd128d3ec12c92f",
  "stripePaymentIntentId": "pi_3TWGc0Ik3or7l4Yr24sdY58a",
  "amountUsd": 10,
  "creditsToAdd": 1050,
  "currentCredits": 325
}
```

### 4b. Send payment and complete

Send the exact USDC amount to the `payTo` address, then retry:

```bash
curl -s -X POST https://api.icme.io/v1/topUp \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: YOUR_API_KEY' \
  -d '{
    "amount_usd": 10,
    "stripe_payment_intent_id": "pi_3TWGc0Ik3or7l4Yr24sdY58a"
  }'
```

### Credit Tiers

| Amount | Credits | Bonus |
|--------|---------|-------|
| $5     | 500     | -     |
| $10    | 1,050   | 5%    |
| $25    | 2,750   | 10%   |
| $50    | 5,750   | 15%   |
| $100   | 12,000  | 20%   |

---

## Step 5: Share with Floe Devs

Provide Floe developers with:

**Environment variables:**
```bash
ICME_API_KEY=sk-smt-floe-devs-d26d0ac324f04f7aa8bd5f5afcff6800
ICME_BASE_URL=https://api.icme.io/v1
```

**Key endpoints:**
- `POST /v1/makeRules` - Compile a policy (300 credits)
- `POST /v1/checkIt` - Run policy checks (1 credit)
- `POST /v1/verifyProof` - Verify proofs (free, no auth)
- `GET /v1/me` - Check remaining credits

---

## Compiling Custom Policies

Floe devs can compile their own policies using `makeRules`:

```bash
curl -s -X POST https://api.icme.io/v1/makeRules \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: sk-smt-floe-devs-d26d0ac324f04f7aa8bd5f5afcff6800' \
  -d '{
    "name": "floe-borrow-limits",
    "rules": [
      "Principal must not exceed $50,000 per loan",
      "Borrower credit score must be at least 650",
      "Loan-to-value ratio must not exceed 80%"
    ]
  }'
```

**Response:**
```json
{
  "policy_id": "pol_xxxxxxxx",
  "name": "floe-borrow-limits",
  "rules_count": 3
}
```

Then use the `policy_id` in `checkIt` calls:

```bash
curl -s -X POST https://api.icme.io/v1/checkIt \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: sk-smt-floe-devs-d26d0ac324f04f7aa8bd5f5afcff6800' \
  -d '{
    "policy_id": "pol_xxxxxxxx",
    "action": "Borrow $25,000 at 75% LTV for borrower with 700 credit score"
  }'
```

---

## Quick Reference

| Endpoint | Auth | Cost | Returns |
|----------|------|------|---------|
| `createUser` | None | $5 USDC | API key + 325 credits |
| `topUp` | API key | $5-100 USDC | Tiered credits |
| `makeRules` | API key | 300 credits | policy_id |
| `checkIt` | API key | 1 credit | SAT/UNSAT + proof_id |
| `verifyProof` | None | Free | Proof verification |
| `me` | API key | Free | Account info + balance |

---

## Troubleshooting

**"Payment not yet received"** - Wait for Base transaction to confirm (~30 seconds), then retry

**"PAYMENT_NOT_VERIFIED"** - Transaction may still be pending. Wait 1-2 minutes and retry.

**"Insufficient funds"** - Check USDC balance on Base (not ETH, not other networks)

**API key lost** - Cannot be recovered. Must create a new account.

**Wrong address** - Each API request generates a unique `payTo` address. Always use the one from your current request.

---

## Transaction History (floe-devs account)

| Date | Action | Amount | Tx Hash | Credits |
|------|--------|--------|---------|---------|
| 2025-05-12 | Account creation | $5 USDC | `0xfd0d461c7716c6ee8ec8d71219014d64c9d1f0579c391fbc09b32264cb374e0a` | +325 |
| 2025-05-12 | Top-up (5% bonus) | $10 USDC | `0x099371cd3d989fe7314f4dedd5130f91ff13157e6e63e3bdd3f42e9fe5ccf010` | +1,050 |

**Current balance: 1,375 credits**

---

## Links

- [ICME Docs](https://docs.icme.io)
- [ICME API Reference](https://api.icme.io/openapi.json)
- [Base Bridge](https://bridge.base.org)
- [BaseScan](https://basescan.org) - Check transactions
- [USDC on Base](https://basescan.org/token/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
