#!/bin/bash
set -euo pipefail

OUT_DIR="${1:-packages/ldk-wasm}"
FILE="$OUT_DIR/ldk_wasm.js"

if [ ! -f "$FILE" ]; then
  echo "Error: $FILE not found"
  exit 1
fi

node -e "
const fs = require('fs');
const code = fs.readFileSync('$FILE', 'utf8');
const lines = code.split('\n');

// Replace a function by name (handles functions with any params)
function replaceFunction(lines, funcName, newFuncLine) {
  const result = [];
  let i = 0;
  while (i < lines.length) {
    const lineStr = lines[i].trim();
    if (lineStr.startsWith('function ' + funcName + '(')) {
      let braceCount = 0;
      let started = false;
      let j = i;
      while (j < lines.length) {
        for (const ch of lines[j]) {
          if (ch === '{') { braceCount++; started = true; }
          if (ch === '}') { braceCount--; }
        }
        j++;
        if (started && braceCount === 0) break;
      }
      result.push(newFuncLine);
      i = j;
    } else {
      result.push(lines[i]);
      i++;
    }
  }
  return result;
}

let patched = lines;

// Always create fresh views
patched = replaceFunction(patched, 'getUint8ArrayMemory0',
  'function getUint8ArrayMemory0() { cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer); return cachedUint8ArrayMemory0; }');
patched = replaceFunction(patched, 'getDataViewMemory0',
  'function getDataViewMemory0() { cachedDataViewMemory0 = new DataView(wasm.memory.buffer); return cachedDataViewMemory0; }');

// Use slice() instead of subarray() in decodeText.
// CF Workers throws 'Invalid array buffer length' on subarray() for
// Uint8Array views backed by large WASM memory ArrayBuffers.
// slice() creates a copy, bypassing the issue.
patched = replaceFunction(patched, 'decodeText',
  'function decodeText(ptr, len) { return cachedTextDecoder.decode(new Uint8Array(wasm.memory.buffer, ptr, len)); }');

// Also fix getArrayU8FromWasm0 which uses subarray
patched = replaceFunction(patched, 'getArrayU8FromWasm0',
  'function getArrayU8FromWasm0(ptr, len) { ptr = ptr >>> 0; return new Uint8Array(wasm.memory.buffer, ptr, len); }');

fs.writeFileSync('$FILE', patched.join('\n'));
console.log('Patched ' + '$FILE');
"
