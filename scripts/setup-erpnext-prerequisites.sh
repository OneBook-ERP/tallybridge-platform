#!/bin/bash
# Setup ERPNext prerequisites for TallyBridge sync.
# Usage: ./setup-erpnext-prerequisites.sh <erpnext_url> <api_key> <api_secret> <company_name> <gstin>
#
# Creates:
#   1. Custom fields (calls setup-erpnext-custom-fields.sh)
#   2. Missing UOMs (KGS, MTS, PCS, LTR, etc.)
#   3. Company billing address with GSTIN

set -euo pipefail

ERPNEXT_URL="${1:?Usage: $0 <erpnext_url> <api_key> <api_secret> <company_name> <gstin>}"
API_KEY="${2:?Missing api_key}"
API_SECRET="${3:?Missing api_secret}"
COMPANY="${4:?Missing company_name}"
GSTIN="${5:?Missing gstin}"
AUTH="Authorization: token ${API_KEY}:${API_SECRET}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== TallyBridge ERPNext Setup ==="
echo "    URL: ${ERPNEXT_URL}"
echo "    Company: ${COMPANY}"
echo "    GSTIN: ${GSTIN}"
echo ""

# 1. Custom fields
"${SCRIPT_DIR}/setup-erpnext-custom-fields.sh" "$ERPNEXT_URL" "$API_KEY" "$API_SECRET"
echo ""

# 2. UOMs commonly used by Tally
UOMS=("KGS" "MTS" "PCS" "LTR" "SQM" "SQF" "CFT" "BAG" "BOX" "PKT" "DOZ" "GMS" "TON" "RFT" "BTL")
echo "=== Creating UOMs ==="
for UOM in "${UOMS[@]}"; do
    echo -n "  ${UOM} ... "
    RESP=$(curl -s -X POST "${ERPNEXT_URL}/api/resource/UOM" \
        -H "$AUTH" \
        -H "Content-Type: application/json" \
        -d "{\"uom_name\": \"${UOM}\", \"enabled\": 1}" 2>&1)
    if echo "$RESP" | grep -q '"name"'; then
        echo "OK"
    elif echo "$RESP" | grep -q 'DuplicateEntryError\|already exists'; then
        echo "SKIP (exists)"
    else
        echo "ERROR"
    fi
done
echo ""

# 3. Company billing address with GSTIN
# Derive state from GSTIN (first 2 digits = state code)
STATE_CODE="${GSTIN:0:2}"
case "$STATE_CODE" in
    33) STATE="Tamil Nadu"; CITY="Coimbatore" ;;
    27) STATE="Maharashtra"; CITY="Mumbai" ;;
    29) STATE="Karnataka"; CITY="Bengaluru" ;;
    07) STATE="Delhi"; CITY="New Delhi" ;;
    36) STATE="Telangana"; CITY="Hyderabad" ;;
    *) STATE=""; CITY="City" ;;
esac

echo "=== Creating Company Address ==="
echo -n "  ${COMPANY}-Billing (${STATE}) ... "
RESP=$(curl -s -X POST "${ERPNEXT_URL}/api/resource/Address" \
    -H "$AUTH" \
    -H "Content-Type: application/json" \
    -d "{
        \"address_title\": \"${COMPANY}\",
        \"address_type\": \"Billing\",
        \"address_line1\": \"${CITY}\",
        \"city\": \"${CITY}\",
        \"state\": \"${STATE}\",
        \"country\": \"India\",
        \"pincode\": \"000000\",
        \"gstin\": \"${GSTIN}\",
        \"gst_category\": \"Registered Regular\",
        \"is_your_company_address\": 1,
        \"links\": [{\"link_doctype\": \"Company\", \"link_name\": \"${COMPANY}\"}]
    }" 2>&1)
if echo "$RESP" | grep -q '"name"'; then
    echo "OK"
elif echo "$RESP" | grep -q 'DuplicateEntryError\|already exists'; then
    echo "SKIP (exists)"
else
    echo "ERROR: $(echo "$RESP" | head -c 150)"
fi

echo ""
echo "=== Setup complete! ==="
