#!/usr/bin/env bash
set -euo pipefail

# === Twilio AI Photo Generator — Azure Container Apps Deployment ===

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Error: required command '$1' is not installed." >&2
    exit 1
  fi
}

prompt_with_default() {
  local prompt="$1"
  local default_value="$2"
  local user_value
  read -r -p "$prompt [$default_value]: " user_value
  if [[ -z "$user_value" ]]; then
    echo "$default_value"
  else
    echo "$user_value"
  fi
}

prompt_secret() {
  local prompt="$1"
  local user_value
  read -r -p "$prompt: " user_value
  echo "$user_value"
}

echo ""
echo "=== Twilio AI Photo Generator — Azure Container Apps Deployment ==="
echo ""

require_cmd az

if ! az account show >/dev/null 2>&1; then
  echo "No active Azure login found. Running 'az login'..."
  az login >/dev/null
fi

SUB_ID=$(az account show --query id -o tsv)
echo "Using subscription: $SUB_ID"

# --- Configuration ---
RG=$(prompt_with_default "Resource group name" "rg-twilio-cartoon-printer")
APP_NAME=$(prompt_with_default "Container app name" "twilio-cartoon-printer")
LOCATION=$(prompt_with_default "Azure location" "centralus")
ENV_NAME=$(prompt_with_default "Container Apps environment name" "cae-twilio-cartoon-printer")
ACR=$(prompt_with_default "ACR name (must be globally unique, lowercase alphanumeric)" "twiliocartoonprinter")
STORAGE_ACCT=$(prompt_with_default "Storage account name (globally unique, lowercase)" "twiliocartoonprinter")
FILE_SHARE="twilioprinterdata"
IMAGE="${APP_NAME}:latest"

echo ""
echo "--- Configuration Summary ---"
echo "  Resource Group:    $RG"
echo "  App Name:          $APP_NAME"
echo "  Location:          $LOCATION"
echo "  Environment:       $ENV_NAME"
echo "  ACR:               $ACR"
echo "  Storage Account:   $STORAGE_ACCT"
echo "  File Share:        $FILE_SHARE"
echo "  Image:             $IMAGE"
echo "-----------------------------"
echo ""

# --- App Secrets ---
echo "Enter application secrets (these are stored securely in Azure Container Apps):"
TWILIO_SID=$(prompt_secret "Twilio Account SID")
TWILIO_TOKEN=$(prompt_secret "Twilio Auth Token")
TWILIO_PHONE=$(prompt_secret "Twilio Phone Number (e.g. +14155551234)")
OPENAI_KEY=$(prompt_secret "OpenAI API Key")
EVENT_NAME=$(prompt_with_default "Event name" "default")

# --- Azure Extensions ---
echo ""
echo "Ensuring Azure Container Apps extension is installed..."
az extension add --name containerapp --upgrade 2>/dev/null || true

# --- Resource Group ---
echo "Creating resource group '$RG' in '$LOCATION'..."
az group create --name "$RG" --location "$LOCATION" >/dev/null

# --- Container Registry ---
if ! az acr show --resource-group "$RG" --name "$ACR" >/dev/null 2>&1; then
  echo "Creating Azure Container Registry '$ACR'..."
  az acr create --resource-group "$RG" --name "$ACR" --sku Basic --admin-enabled true >/dev/null
else
  echo "ACR '$ACR' already exists."
fi

echo "Building image '$IMAGE' in ACR '$ACR' (this may take a few minutes)..."
az acr build --registry "$ACR" --image "$IMAGE" .

# --- Storage Account + File Share ---
if ! az storage account show --resource-group "$RG" --name "$STORAGE_ACCT" --subscription "$SUB_ID" >/dev/null 2>&1; then
  echo "Creating storage account '$STORAGE_ACCT'..."
  az storage account create \
    --name "$STORAGE_ACCT" \
    --resource-group "$RG" \
    --location "$LOCATION" \
    --sku Standard_LRS \
    --subscription "$SUB_ID" >/dev/null
else
  echo "Storage account '$STORAGE_ACCT' already exists."
fi

STORAGE_KEY=$(az storage account keys list \
  --resource-group "$RG" \
  --account-name "$STORAGE_ACCT" \
  --subscription "$SUB_ID" \
  --query '[0].value' -o tsv)

echo "Creating file share '$FILE_SHARE'..."
az storage share create \
  --name "$FILE_SHARE" \
  --account-name "$STORAGE_ACCT" \
  --account-key "$STORAGE_KEY" \
  --quota 10 >/dev/null 2>&1 || true

# --- Container Apps Environment ---
if ! az containerapp env show --resource-group "$RG" --name "$ENV_NAME" >/dev/null 2>&1; then
  echo "Creating Container Apps environment '$ENV_NAME'..."
  az containerapp env create \
    --resource-group "$RG" \
    --name "$ENV_NAME" \
    --location "$LOCATION" >/dev/null
else
  echo "Container Apps environment '$ENV_NAME' already exists."
fi

# --- Mount Azure Files to Environment ---
echo "Configuring Azure Files storage mount..."
az containerapp env storage set \
  --name "$ENV_NAME" \
  --resource-group "$RG" \
  --storage-name appdata \
  --azure-file-account-name "$STORAGE_ACCT" \
  --azure-file-account-key "$STORAGE_KEY" \
  --azure-file-share-name "$FILE_SHARE" \
  --access-mode ReadWrite >/dev/null

# --- Container App ---
ACR_SERVER="${ACR}.azurecr.io"
ACR_USERNAME=$(az acr credential show --name "$ACR" --query username -o tsv)
ACR_PASSWORD=$(az acr credential show --name "$ACR" --query 'passwords[0].value' -o tsv)

# Create a YAML template for the container app with volume mount
# (Azure CLI doesn't support volume mounts via flags alone)
YAML_FILE=$(mktemp /tmp/containerapp-XXXXXX.yaml)

cat > "$YAML_FILE" <<EOF
properties:
  configuration:
    ingress:
      external: true
      targetPort: 8080
    registries:
      - server: ${ACR_SERVER}
        username: ${ACR_USERNAME}
        passwordSecretRef: acr-password
    secrets:
      - name: acr-password
        value: "${ACR_PASSWORD}"
      - name: twilio-sid
        value: "${TWILIO_SID}"
      - name: twilio-token
        value: "${TWILIO_TOKEN}"
      - name: twilio-phone
        value: "${TWILIO_PHONE}"
      - name: openai-key
        value: "${OPENAI_KEY}"
  template:
    containers:
      - name: ${APP_NAME}
        image: ${ACR_SERVER}/${IMAGE}
        resources:
          cpu: 1.0
          memory: 2Gi
        env:
          - name: PORT
            value: "8080"
          - name: NODE_ENV
            value: production
          - name: ENABLE_PRINTING
            value: "false"
          - name: EVENT_NAME
            value: "${EVENT_NAME}"
          - name: DATA_MOUNT
            value: /app/appdata
          - name: TWILIO_ACCOUNT_SID
            secretRef: twilio-sid
          - name: TWILIO_AUTH_TOKEN
            secretRef: twilio-token
          - name: TWILIO_PHONE_NUMBER
            secretRef: twilio-phone
          - name: OPENAI_API_KEY
            secretRef: openai-key
        volumeMounts:
          - volumeName: appdata
            mountPath: /app/appdata
    scale:
      minReplicas: 1
      maxReplicas: 1
    volumes:
      - name: appdata
        storageName: appdata
        storageType: AzureFile
EOF

if az containerapp show --resource-group "$RG" --name "$APP_NAME" >/dev/null 2>&1; then
  echo "Container app '$APP_NAME' already exists. Updating..."
  az containerapp update \
    --resource-group "$RG" \
    --name "$APP_NAME" \
    --yaml "$YAML_FILE" >/dev/null
else
  echo "Creating container app '$APP_NAME'..."
  az containerapp create \
    --resource-group "$RG" \
    --name "$APP_NAME" \
    --environment "$ENV_NAME" \
    --yaml "$YAML_FILE" >/dev/null
fi

rm -f "$YAML_FILE"

# --- Get FQDN and set BASE_URL ---
FQDN=$(az containerapp show \
  --resource-group "$RG" \
  --name "$APP_NAME" \
  --query properties.configuration.ingress.fqdn -o tsv)

echo "Setting BASE_URL to https://${FQDN}..."
az containerapp update \
  --resource-group "$RG" \
  --name "$APP_NAME" \
  --set-env-vars "BASE_URL=https://${FQDN}" \
  --min-replicas 1 \
  --max-replicas 1 >/dev/null

echo ""
echo "================================================"
echo "  Deployment complete!"
echo "================================================"
echo ""
echo "  App URL:        https://${FQDN}"
echo "  Admin Console:  https://${FQDN}/home"
echo "  Dashboard:      https://${FQDN}/dashboard"
echo "  Outreach:       https://${FQDN}/outreach"
echo ""
echo "  Next steps:"
echo "  1. Set your Twilio phone number's webhook to:"
echo "     https://${FQDN}/sms"
echo "  2. Visit https://${FQDN}/home to configure settings"
echo "  3. Send a selfie to your Twilio number to test"
echo ""
