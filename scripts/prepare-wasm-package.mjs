import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const outDir = process.argv[2]

if (!outDir) {
  throw new Error('usage: node scripts/prepare-wasm-package.mjs <out-dir>')
}

const ignorePath = path.join(outDir, '.gitignore')
const packageJsonPath = path.join(outDir, 'package.json')
const ignoreContents = `*
!.gitignore
!README.md
!LICENSE-APACHE
!LICENSE-MIT
!package.json
`

writeFileSync(ignorePath, ignoreContents)

const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
if (!packageJson.author && Array.isArray(packageJson.collaborators) && packageJson.collaborators.length > 0) {
  packageJson.author = packageJson.collaborators[0]
}
delete packageJson.collaborators
writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`)
