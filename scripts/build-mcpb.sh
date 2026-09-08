#!/bin/sh
# Builds dist/bankmcp.mcpb, a one-click Claude Desktop extension bundle.
set -e
cd "$(dirname "$0")/.."
rm -rf dist/mcpb && mkdir -p dist/mcpb
npm run build
cp -R bin package.json package-lock.json LICENSE README.md dist/mcpb/
mkdir -p dist/mcpb/dist && cp -R dist/lib dist/mcpb/dist/lib
cp mcpb/manifest.json dist/mcpb/manifest.json
(cd dist/mcpb && npm ci --omit=dev --ignore-scripts --silent)
npx -y @anthropic-ai/mcpb pack dist/mcpb dist/bankmcp.mcpb
ls -la dist/bankmcp.mcpb
