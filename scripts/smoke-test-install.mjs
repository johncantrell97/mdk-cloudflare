import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const repoRoot = resolve(new URL('..', import.meta.url).pathname)
const scratchRoot = mkdtempSync(join(tmpdir(), 'mdk-cloudflare-smoke-'))
const packDir = join(scratchRoot, 'packs')
mkdirSync(packDir, { recursive: true })

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, {
    cwd,
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim()
}

function pack(packageDir) {
  const output = run('npm', ['pack', '--silent', '--pack-destination', packDir], packageDir)
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  return join(packDir, lines[lines.length - 1])
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function smokeWorkerInstall(backendTgz) {
  const dir = join(scratchRoot, 'worker')
  mkdirSync(join(dir, 'src'), { recursive: true })

  writeJson(join(dir, 'package.json'), { name: 'worker-smoke', private: true, type: 'module' })
  writeJson(join(dir, 'tsconfig.json'), {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      lib: ['ES2022'],
      strict: true,
      noEmit: true,
      types: ['@cloudflare/workers-types'],
    },
    include: ['src'],
  })

  writeFileSync(
    join(dir, 'src/index.ts'),
    `import { LightningNode, createUnifiedHandler, type CreateCheckoutOptions } from 'mdk-cloudflare'

export { LightningNode }

interface Env {
  LIGHTNING_NODE: DurableObjectNamespace<LightningNode>
  MDK_ACCESS_TOKEN: string
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const node = env.LIGHTNING_NODE.get(env.LIGHTNING_NODE.idFromName('default'))
    const options: CreateCheckoutOptions = { amount: 1000, currency: 'SAT' }
    void options

    if (new URL(request.url).pathname === '/api/mdk') {
      return createUnifiedHandler({
        node,
        accessToken: env.MDK_ACCESS_TOKEN,
      })(request)
    }

    return new Response('ok')
  },
}
`,
  )

  run('npm', ['install', '--silent', backendTgz, 'typescript', '@cloudflare/workers-types'], dir)
  run('npx', ['tsc', '-p', 'tsconfig.json'], dir)
}

function smokeReactInstall(backendTgz) {
  const dir = join(scratchRoot, 'react')
  mkdirSync(join(dir, 'src'), { recursive: true })

  writeJson(join(dir, 'package.json'), { name: 'react-smoke', private: true, type: 'module' })
  writeJson(join(dir, 'tsconfig.json'), {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      jsx: 'react-jsx',
      strict: true,
      noEmit: true,
    },
    include: ['src'],
  })

  writeFileSync(
    join(dir, 'src/index.tsx'),
    `import '@moneydevkit/core/mdk-styles.css'
import { Checkout, useCheckout, useCheckoutSuccess, useProducts } from '@moneydevkit/core/client'

export function App() {
  const { createCheckout } = useCheckout()
  void createCheckout
  const { products } = useProducts()
  void products
  const success = useCheckoutSuccess()
  void success
  return <Checkout id="chk_123" />
}
`,
  )

  run(
    'npm',
    [
      'install',
      '--silent',
      backendTgz,
      '@moneydevkit/core@0.14.0',
      'react',
      'react-dom',
      'typescript',
      '@types/react',
      '@types/react-dom',
    ],
    dir,
  )
  run('npx', ['tsc', '-p', 'tsconfig.json'], dir)
}

try {
  const backendTgz = pack(join(repoRoot, 'packages/lightning-cloudflare'))

  smokeWorkerInstall(backendTgz)
  smokeReactInstall(backendTgz)

  console.log('Smoke install checks passed')
} finally {
  rmSync(scratchRoot, { recursive: true, force: true })
}
