#!/bin/bash
# Verify that the wasm-bindgen patch was applied correctly.
# Run after build:wasm to ensure no subarray() calls remain in critical functions.
# These cause RangeError on CF Workers production (not reproducible locally).
set -euo pipefail

OUT_DIR="${1:-packages/ldk-wasm}"
FILE="$OUT_DIR/ldk_wasm.js"

if [ ! -f "$FILE" ]; then
  echo "Error: $FILE not found — run build:wasm first"
  exit 1
fi

node - "$FILE" <<'NODE'
const fs = require('fs');

const file = process.argv[2];
const code = fs.readFileSync(file, 'utf8');
const lines = code.split('\n');

function extractFunction(funcName) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith(`function ${funcName}(`)) continue;

    let body = [];
    let braceCount = 0;
    let started = false;
    let j = i;
    while (j < lines.length) {
      const current = lines[j];
      body.push(current);
      for (const ch of current) {
        if (ch === '{') {
          braceCount++;
          started = true;
        } else if (ch === '}') {
          braceCount--;
        }
      }
      j++;
      if (started && braceCount === 0) {
        break;
      }
    }
    return body.join('\n');
  }
  return null;
}

let errors = 0;

function assertPatched(name, checks, okMessage, failMessage) {
  const body = extractFunction(name);
  if (!body) {
    console.log(`WARN: ${name} not found`);
    return;
  }

  if (checks(body)) {
    console.log(`OK: ${okMessage}`);
    return;
  }

  console.log(`FAIL: ${failMessage}`);
  errors++;
}

assertPatched(
  'decodeText',
  (body) => !body.includes('subarray'),
  'decodeText() patched',
  'decodeText() still uses subarray()',
);

assertPatched(
  'getArrayU8FromWasm0',
  (body) => !body.includes('subarray'),
  'getArrayU8FromWasm0() patched',
  'getArrayU8FromWasm0() still uses subarray()',
);

assertPatched(
  'getUint8ArrayMemory0',
  (body) => !body.includes('=== null') && !body.includes('.length'),
  'getUint8ArrayMemory0() patched (always fresh)',
  'getUint8ArrayMemory0() still has stale-cache check',
);

assertPatched(
  'getDataViewMemory0',
  (body) => !body.includes('=== null') && !body.includes('.length'),
  'getDataViewMemory0() patched (always fresh)',
  'getDataViewMemory0() still has stale-cache check',
);

if (errors > 0) {
  console.log('');
  console.log(`FAILED: ${errors} function(s) not patched. Run: bash scripts/patch-wasm-bindgen.sh`);
  process.exit(1);
}

console.log('');
console.log('All critical functions patched correctly.');
NODE
