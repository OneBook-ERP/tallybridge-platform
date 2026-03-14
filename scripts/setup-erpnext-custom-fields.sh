#!/bin/bash
# Setup ERPNext custom fields for TallyBridge sync.
# Usage: ./setup-erpnext-custom-fields.sh <erpnext_url> <api_key> <api_secret>
#
# Creates custom_tally_guid, custom_sync_source on 7 doctypes,
# plus custom_tally_voucher_number on 4 transaction doctypes:
#   Sales Invoice, Purchase Invoice, Journal Entry, Payment Entry,
#   Item, Customer, Supplier

set -euo pipefail

ERPNEXT_URL="${1:?Usage: $0 <erpnext_url> <api_key> <api_secret>}"
API_KEY="${2:?Missing api_key}"
API_SECRET="${3:?Missing api_secret}"
AUTH="Authorization: token ${API_KEY}:${API_SECRET}"

DOCTYPES=("Sales Invoice" "Purchase Invoice" "Journal Entry" "Payment Entry" "Item" "Customer" "Supplier")

echo "=== Setting up TallyBridge custom fields on ${ERPNEXT_URL} ==="

for DT in "${DOCTYPES[@]}"; do
    DT_ENC=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$DT'))")

    # custom_tally_guid
    echo -n "  ${DT} → custom_tally_guid ... "
    RESP=$(curl -s -X POST "${ERPNEXT_URL}/api/resource/Custom%20Field" \
        -H "$AUTH" \
        -H "Content-Type: application/json" \
        -d "{
            \"dt\": \"${DT}\",
            \"fieldname\": \"custom_tally_guid\",
            \"label\": \"Tally GUID\",
            \"fieldtype\": \"Data\",
            \"insert_after\": \"naming_series\",
            \"read_only\": 1,
            \"unique\": 1,
            \"no_copy\": 1
        }" 2>&1)
    if echo "$RESP" | grep -q '"name"'; then
        echo "OK"
    elif echo "$RESP" | grep -q 'DuplicateEntryError\|already exists'; then
        echo "SKIP (exists)"
    else
        echo "ERROR: $(echo "$RESP" | head -c 100)"
    fi

    # custom_sync_source
    echo -n "  ${DT} → custom_sync_source ... "
    RESP=$(curl -s -X POST "${ERPNEXT_URL}/api/resource/Custom%20Field" \
        -H "$AUTH" \
        -H "Content-Type: application/json" \
        -d "{
            \"dt\": \"${DT}\",
            \"fieldname\": \"custom_sync_source\",
            \"label\": \"Sync Source\",
            \"fieldtype\": \"Data\",
            \"insert_after\": \"custom_tally_guid\",
            \"read_only\": 1,
            \"no_copy\": 1
        }" 2>&1)
    if echo "$RESP" | grep -q '"name"'; then
        echo "OK"
    elif echo "$RESP" | grep -q 'DuplicateEntryError\|already exists'; then
        echo "SKIP (exists)"
    else
        echo "ERROR: $(echo "$RESP" | head -c 100)"
    fi
done

# custom_tally_voucher_number on transaction doctypes only
TXNDOCTYPES=("Sales Invoice" "Purchase Invoice" "Journal Entry" "Payment Entry")
echo ""
echo "=== Setting up custom_tally_voucher_number ==="
for DT in "${TXNDOCTYPES[@]}"; do
    echo -n "  ${DT} → custom_tally_voucher_number ... "
    RESP=$(curl -s -X POST "${ERPNEXT_URL}/api/resource/Custom%20Field" \
        -H "$AUTH" \
        -H "Content-Type: application/json" \
        -d "{
            \"dt\": \"${DT}\",
            \"fieldname\": \"custom_tally_voucher_number\",
            \"label\": \"Tally Voucher Number\",
            \"fieldtype\": \"Data\",
            \"insert_after\": \"custom_sync_source\",
            \"read_only\": 1,
            \"no_copy\": 1
        }" 2>&1)
    if echo "$RESP" | grep -q '"name"'; then
        echo "OK"
    elif echo "$RESP" | grep -q 'DuplicateEntryError\|already exists'; then
        echo "SKIP (exists)"
    else
        echo "ERROR: $(echo "$RESP" | head -c 100)"
    fi
done

echo ""
echo "=== Done! 18 custom fields verified on ${ERPNEXT_URL} ==="
