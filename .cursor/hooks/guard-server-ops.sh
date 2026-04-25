#!/usr/bin/env bash
set -euo pipefail

input=$(cat)
command=$(echo "$input" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('command',''))" 2>/dev/null || echo "")

if echo "$command" | grep -qE "npm start|node dist/server"; then
  echo '{
    "permission": "ask",
    "user_message": "This will start the MCP server. Make sure no existing instance is running and that ALLOWED_DIRS is configured.",
    "agent_message": "Starting the MCP server. Confirm ALLOWED_DIRS env var is set before proceeding."
  }'
  exit 0
fi

echo '{ "permission": "allow" }'
exit 0
