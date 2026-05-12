# Prefunding an ICME API Key for Floe Devs

This guide walks through creating and funding an ICME Preflight API key that you can share with Floe developers.

## Overview

- **Cost:** $5 USDC on Base (account creation) + additional top-ups as needed
- **Result:** API key + credits that Floe devs can use immediately
- **Network:** Base (chain ID 8453)

---

## Step 1: Set Up a Base Wallet

You need an Ethereum-compatible wallet that supports the Base network.

**Options:**
- [MetaMask](https://metamask.io/) - Browser extension + mobile
- [Coinbase Wallet](https://www.coinbase.com/wallet) - Native Base support
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
- **$25 USDC** - Basic experimentation (3,075 credits = ~10 policy compilations)
- **$50 USDC** - Comfortable experimentation (6,075 credits = ~18 policy compilations + 600 checks)

**Credit costs:**
- Compile policy (`makeRules`): 300 credits
- Run check (`checkIt`): 1 credit
- Verify proof (`verifyProof`): Free

---

## Step 3: Create the ICME Account

The x402 flow is a 3-step process:

### 3a. Initial Request (triggers 402 response)

```bash
curl -s -X POST https://api.icme.io/v1/createUserX402 \
  -H 'Content-Type: application/json' \
  -d '{"username":"floe-preflight"}' | jq .
```

This returns a `402 Payment Required` response with:
- `payTo` - The address to send USDC to
- `amount` - Exact amount required ($5.00 USDC)
- Payment instructions

### 3b. Send USDC Payment

Send **exactly $5.00 USDC** on Base to the `payTo` address from the 402 response.

**Important:** Amount must be exact. Transaction must be on Base network.

### 3c. Retry with Payment Signature

After the transaction confirms, retry with the payment signature:

```bash
curl -s -X POST https://api.icme.io/v1/createUserX402 \
  -H 'Content-Type: application/json' \
  -H 'Payment-Signature: <signature-from-payment>' \
  -d '{"username":"floe-preflight"}' | jq .
```

**Response includes:**
```json
{
  "api_key": "icme_xxxxxxxxxxxxxxxxxxxxxxxx",
  "credits": 325,
  "username": "floe-preflight"
}
```

> **CRITICAL:** Save the `api_key` immediately! It is shown only once and cannot be recovered.

---

## Step 4: Top Up Credits (Optional)

Add more credits using the same x402 flow:

### 4a. Initial top-up request

```bash
curl -s -X POST https://api.icme.io/v1/topUpX402 \
  -H 'X-API-Key: YOUR_API_KEY' | jq .
```

### 4b. Pay and retry

Send $5 USDC to the `payTo` address, then retry with signature.

**Credit tiers (via POST /v1/topUp for larger amounts):**
| Amount | Credits | Bonus |
|--------|---------|-------|
| $5     | 500     | -     |
| $10    | 1,050   | 5%    |
| $25    | 2,750   | 10%   |
| $50    | 5,750   | 15%   |
| $100   | 12,000  | 20%   |

---

## Step 5: Verify the Account

Check account status and balance:

```bash
curl -s https://api.icme.io/v1/me \
  -H 'X-API-Key: YOUR_API_KEY' | jq .
```

---

## Step 6: Share with Floe Devs

Provide Floe developers with:

1. **API Key:** `icme_xxxxxxxxxxxxxxxxxxxxxxxx`
2. **Base URL:** `https://api.icme.io/v1`
3. **Key endpoints:**
   - `POST /v1/checkIt` - Run policy checks (1 credit each)
   - `POST /v1/verifyProof` - Verify proofs (no auth needed)
   - `GET /v1/me` - Check remaining credits

**Example .env for their project:**
```
ICME_API_KEY=icme_xxxxxxxxxxxxxxxxxxxxxxxx
ICME_BASE_URL=https://api.icme.io/v1
```

---

## Monitoring Usage

Check remaining credits anytime:

```bash
curl -s https://api.icme.io/v1/me \
  -H 'X-API-Key: YOUR_API_KEY' | jq '.credits'
```

---

## Compiling Custom Policies

Floe devs can compile their own policies using `makeRules`:

```bash
curl -s -X POST https://api.icme.io/v1/makeRules \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: YOUR_API_KEY' \
  -d '{
    "name": "floe-borrow-limits",
    "rules": [
      "Principal must not exceed $50,000 per loan",
      "Borrower credit score must be at least 650",
      "Loan-to-value ratio must not exceed 80%"
    ]
  }'
```

**Response includes:**
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
  -H 'X-API-Key: YOUR_API_KEY' \
  -d '{
    "policy_id": "pol_xxxxxxxx",
    "action": "Borrow $25,000 at 75% LTV for borrower with 700 credit score"
  }'
```

---

## Quick Reference

| Endpoint | Auth | Cost | Returns |
|----------|------|------|---------|
| `createUserX402` | None | $5 USDC | API key + 325 credits |
| `topUpX402` | API key | $5 USDC | +500 credits |
| `topUp` | API key | $5-100 USDC | Tiered credits |
| `makeRules` | API key | 300 credits | policy_id |
| `checkIt` | API key | 1 credit | SAT/UNSAT + proof_id |
| `verifyProof` | None | Free | Proof verification |

---

## Troubleshooting

**"Payment not found"** - Wait for Base transaction to confirm (usually <2 min)

**"Invalid signature"** - Ensure you're using the signature from the correct transaction

**"Insufficient funds"** - Check USDC balance on Base (not ETH, not other networks)

**API key lost** - Cannot be recovered. Must create a new account.

---

## Links

- [ICME Docs](https://docs.icme.io)
- [ICME API Reference](https://api.icme.io/openapi.json)
- [Base Bridge](https://bridge.base.org)
- [BaseScan](https://basescan.org) - Check transactions
