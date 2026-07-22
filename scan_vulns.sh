#!/bin/bash
# scan_vulns.sh - Improved Node.js vulnerability scanner with progress

set -euo pipefail

#MODEL="openrouter/poolside/laguna-s-2.1:free"
MODEL="opencode/deepseek-v4-flash-free"
PROMPT="Analyze this file for security vulnerabilities common in Node.js/TypeScript projects:
- Injection flaws, path traversal, XSS, prototype pollution
- Insecure dependencies, deserialization issues
- Auth/session weaknesses, input validation gaps
- File I/O or network risks
- Other code smells or best-practice violations.
Be specific, cite line numbers if possible, and implement fixes. Only analyze the provided file."

echo "Starting scan in: $(pwd)"
echo "Model: $MODEL"

# Collect files safely into an array
mapfile -t files < <(find . -type f \
  \( -name "*.js" -o -name "*.ts" -o -name "*.jsx" -o -name "*.tsx" \
     -o -name "*.mjs" -o -name "*.cjs" -o -name "package*.json" \) \
  -not -path "*/node_modules/*" \
  -not -path "*/dist/*" \
  -not -path "*/build/*" \
  -not -path "*/.next/*" \
  -not -path "*/test/*" \
  -not -path "*/coverage/*" | sort)

total=${#files[@]}
echo "Found $total files to scan."

if [ "$total" -eq 0 ]; then
  echo "No files found. Exiting."
  exit 0
fi

for i in "${!files[@]}"; do
  file="${files[$i]}"
  index=$((i + 1))

  echo "=== [$index/$total] Scanning: $file ==="

  if opencode run "$PROMPT" \
    --model "$MODEL" \
    --file "$file" \
    --auto; then
    echo "✅ Completed [$index/$total]: $file"
  else
    echo "❌ Failed [$index/$total] on $file" >&2
  fi

  echo "-----------------------------------"
  sleep 2
done

echo "Scan finished. Processed $total files."
