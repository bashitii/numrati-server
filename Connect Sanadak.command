#!/bin/bash
# One-time setup: lets the Numrati server on this Mac talk to the Sanadak agent in Google Cloud.
cd "$HOME"
G="$HOME/google-cloud-sdk/bin/gcloud"
UV="$HOME/.local/bin/uv"

echo "1) Getting Python 3.12 (the Mac's own Python 3.9 is too old for Google's tool)..."
if [ ! -x "$UV" ]; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
fi
"$UV" python install 3.12
export CLOUDSDK_PYTHON="$("$UV" python find 3.12)"
echo "Using Python: $CLOUDSDK_PYTHON"

echo ""
echo "2) Getting the Google Cloud tool..."
if [ ! -x "$G" ]; then
  curl -sSLO https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-darwin-arm.tar.gz
  tar -xzf google-cloud-cli-darwin-arm.tar.gz
  rm google-cloud-cli-darwin-arm.tar.gz
fi
if ! "$G" --version; then
  echo "The Google tool still does not start. Send a screenshot of this window to Claude."
  read -r -p "Press Enter to close."
  exit 1
fi

echo ""
echo "3) Chrome will open. Choose awsshawareb1@gmail.com."
echo "   On the permissions page, tick ALL the boxes (or \"Select all\"), then click Continue."
"$G" auth application-default login

echo ""
echo "4) Setting the Google Cloud project..."
"$G" auth application-default set-quota-project midyear-diorama-514913-a7

echo ""
echo "Done. You can close this window."
read -r -p "Press Enter to close."
