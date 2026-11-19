#!/bin/bash
# Deploys the Numrati API to Google Cloud Run (project "Capstone project", region Belgium).
# The Supabase keys are read from .env on this Mac and sent straight to Cloud Run.
cd "$(dirname "$0")"

PROJECT=midyear-diorama-514913-a7
REGION=europe-west1
SERVICE=numrati-api
RUN_AS=numrati-backend@$PROJECT.iam.gserviceaccount.com

G="$HOME/google-cloud-sdk/bin/gcloud"
export CLOUDSDK_PYTHON="$("$HOME/.local/bin/uv" python find 3.12)"
if [ ! -x "$G" ]; then
  echo "Google's tool is missing. Run 'Connect Sanadak.command' first."
  read -r -p "Press Enter to close."; exit 1
fi

echo "1) Signing in to Google Cloud (Chrome opens the first time: choose awsshawareb1@gmail.com, tick all boxes, Continue)..."
if [ -z "$("$G" auth list --filter=status:ACTIVE --format='value(account)')" ]; then
  "$G" auth login || { read -r -p "Sign-in failed. Press Enter to close."; exit 1; }
fi
"$G" config set project "$PROJECT" --quiet

echo ""
echo "2) Reading the settings from .env..."
ENV_FILE="$(mktemp)"
trap 'rm -f "$ENV_FILE"' EXIT
for NAME in DATABASE_URL SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY; do
  VALUE="$(grep -E "^$NAME=" .env | head -1 | cut -d= -f2-)"
  if [ -z "$VALUE" ]; then
    echo "Missing $NAME in .env"; read -r -p "Press Enter to close."; exit 1
  fi
  printf '%s: "%s"\n' "$NAME" "$VALUE" >> "$ENV_FILE"
done
# Websites allowed to call the API (add the live website address here when it is published)
echo 'CLIENT_ORIGIN: "http://localhost:5173,http://localhost:5174"' >> "$ENV_FILE"

echo ""
echo "3) Building and deploying (this takes about 3 to 6 minutes)..."
"$G" run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --service-account "$RUN_AS" \
  --env-vars-file "$ENV_FILE" \
  --no-invoker-iam-check \
  --quiet

echo ""
echo "The API address is:"
"$G" run services describe "$SERVICE" --region "$REGION" --format='value(status.url)'
echo ""
read -r -p "Done. Press Enter to close."
