import { execFileSync } from 'node:child_process'
import { readFileSync, unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repoRoot = new URL('../', import.meta.url)
const packageDir = new URL('../packages/lightning-cloudflare/', import.meta.url)
const sourcePackageJson = JSON.parse(
  readFileSync(new URL('../packages/lightning-cloudflare/package.json', import.meta.url), 'utf8'),
)
const expectedVersion = sourcePackageJson.version

function run(cmd, args, options = {}) {
  return execFileSync(cmd, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

const releasePrepScript = new URL('./prepare-release-package.mjs', import.meta.url)
let tarballPath
let filename

try {
  const packOutput = run('npm', ['pack', '--silent'], { cwd: packageDir })
  const lines = packOutput.trim().split(/\r?\n/).filter(Boolean)
  filename = lines[lines.length - 1]
  tarballPath = path.join(fileURLToPath(packageDir), filename)

  const packageJson = JSON.parse(
    run('tar', ['-xOf', tarballPath, 'package/package.json'], { cwd: repoRoot }),
  )
  const tarEntries = run('tar', ['-tf', tarballPath], { cwd: repoRoot })
    .trim()
    .split('\n')

  assert(
    packageJson.dependencies?.['ldk-wasm'] === expectedVersion,
    `packed dependency spec must be ${expectedVersion}, got ${packageJson.dependencies?.['ldk-wasm'] ?? 'missing'}`,
  )
  assert(
    tarEntries.includes('package/README.md'),
    'packed tarball is missing package/README.md',
  )
  assert(
    tarEntries.includes('package/LICENSE-MIT') && tarEntries.includes('package/LICENSE-APACHE'),
    'packed tarball is missing license files',
  )
  assert(
    tarEntries.includes('package/node_modules/ldk-wasm/package.json'),
    'packed tarball is missing bundled ldk-wasm/package.json',
  )
  assert(
    tarEntries.includes('package/node_modules/ldk-wasm/ldk_wasm_bg.wasm'),
    'packed tarball is missing bundled WASM binary',
  )

  console.log(`Verified ${filename}`)
} finally {
  if (tarballPath) {
    unlinkSync(tarballPath)
  }
  run('node', [fileURLToPath(releasePrepScript), 'postpack'], { cwd: repoRoot })
}
