import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const packageJsonUrl = new URL('../packages/lightning-cloudflare/package.json', import.meta.url)
const backupUrl = new URL('../packages/lightning-cloudflare/.package.json.release-backup', import.meta.url)

const packageJsonPath = fileURLToPath(packageJsonUrl)
const backupPath = fileURLToPath(backupUrl)
const mode = process.argv[2]
const currentVersion = JSON.parse(readFileSync(packageJsonPath, 'utf8')).version

if (mode === 'prepack') {
  if (!existsSync(backupPath)) {
    copyFileSync(packageJsonPath, backupPath)
  }

  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  if (pkg.dependencies?.['ldk-wasm'] === `workspace:${currentVersion}`) {
    pkg.dependencies['ldk-wasm'] = currentVersion
  }

  writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`)
} else if (mode === 'postpack') {
  if (existsSync(backupPath)) {
    copyFileSync(backupPath, packageJsonPath)
    rmSync(backupPath)
  }
} else {
  throw new Error(`Unknown mode: ${mode}`)
}
