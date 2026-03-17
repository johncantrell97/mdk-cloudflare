#!/usr/bin/env node

/**
 * Lightning payer tool for testing ldk-cf.
 *
 * Uses @moneydevkit/lightning-js to run a full LDK node that can
 * receive funds (via invoice) and pay BOLT11 invoices.
 *
 * Usage:
 *   node payer.js setup              # Generate mnemonic and show node ID
 *   node payer.js invoice <sats>     # Generate invoice to receive funds
 *   node payer.js pay <bolt11>       # Pay a BOLT11 invoice
 *   node payer.js balance            # Show balance and channels
 *   node payer.js info               # Show node ID and status
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STATE_FILE = join(__dirname, '.payer-state.json')

// MDK mainnet config
const MDK_CONFIG = {
  network: 'mainnet',
  vssUrl: 'https://vss.moneydevkit.com/vss',
  esploraUrl: 'https://esplora.moneydevkit.com/api',
  rgsUrl: 'https://rapidsync.lightningdevkit.org/snapshot/v2',
  lspNodeId: '02a63339cc6b913b6330bd61b2f469af8785a6011a6305bb102298a8e76697473b',
  lspAddress: 'lsp.moneydevkit.com:9735',
}

function loadState() {
  if (existsSync(STATE_FILE)) {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'))
  }
  return null
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

async function loadLightning() {
  const ljs = await import('@moneydevkit/lightning-js')
  return ljs
}

async function createNode(ljs, mnemonic, mdkApiKey) {
  ljs.setLogListener((_level, msg) => {
    const text = typeof msg === 'object' ? msg.message : msg
    // Verbose logging for debugging
    console.error(`  [ldk] ${text}`)
  })

  const node = new ljs.MdkNode({
    ...MDK_CONFIG,
    mnemonic,
    mdkApiKey: mdkApiKey || 'test-payer',
  })

  return node
}

async function cmdSetup(ljs) {
  let state = loadState()
  if (state?.mnemonic) {
    console.log('Already set up. Mnemonic exists in .payer-state.json')
    const nodeId = ljs.deriveNodeId(state.mnemonic, MDK_CONFIG.network)
    console.log(`Node ID: ${nodeId}`)
    return
  }

  const mnemonic = ljs.generateMnemonic()
  state = { mnemonic }
  saveState(state)

  const nodeId = ljs.deriveNodeId(mnemonic, MDK_CONFIG.network)
  console.log('Generated new mnemonic (saved to .payer-state.json)')
  console.log(`Mnemonic: ${mnemonic}`)
  console.log(`Node ID:  ${nodeId}`)
}

function getNode(ljs) {
  const state = loadState()
  if (!state?.mnemonic) {
    console.error('No mnemonic found. Run: node payer.js setup')
    process.exit(1)
  }
  return createNode(ljs, state.mnemonic, state.mdkApiKey)
}

async function cmdInvoice(ljs, amountSats) {
  if (!amountSats || amountSats < 1) {
    console.error('Usage: node payer.js invoice <amount_sats>')
    process.exit(1)
  }

  const node = await getNode(ljs)
  console.log(`Generating invoice for ${amountSats} sats...`)
  const invoice = node.getInvoice(amountSats * 1000, `Payer funding ${amountSats} sats`, 3600)
  console.log(`\nInvoice:\n${invoice.bolt11}\n`)
  console.log(`SCID: ${invoice.scid}`)
  console.log(`Payment hash: ${invoice.paymentHash}`)
  // getInvoice() internally starts then stops the node.
  // Restart it so we stay online to receive the payment.
  node.start()
  console.log('Waiting for payment... (node must stay online, Ctrl+C to abort)\n')

  const shutdown = () => {
    console.log('\nShutting down...')
    try { node.stop() } catch {}
    node.destroy()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  while (true) {
    const event = node.nextEvent()
    if (event) {
      if (event.eventType === ljs.PaymentEventType.Received) {
        console.log(`Payment received! ${event.amountMsat / 1000} sats (hash: ${event.paymentHash})`)
        node.ackEvent()
        break
      } else if (event.eventType === ljs.PaymentEventType.Claimable) {
        console.log(`Payment claimable: ${event.amountMsat / 1000} sats`)
        node.ackEvent()
      } else {
        console.log(`Event: type=${event.eventType} hash=${event.paymentHash}`)
        node.ackEvent()
      }
    }
    await new Promise((r) => setTimeout(r, 1000))
  }

  const balance = node.getBalanceWhileRunning()
  console.log(`\nBalance: ${balance} sats`)
  console.log('Funding complete.')
  try { node.stop() } catch {}
  node.destroy()
}

async function cmdPay(ljs, bolt11) {
  if (!bolt11) {
    console.error('Usage: node payer.js pay <bolt11_invoice>')
    process.exit(1)
  }

  const node = await getNode(ljs)
  try {
    // pay()/getBalance() internally start/stop the node
    const balance = node.getBalance()
    console.log(`Current balance: ${balance} sats`)

    console.log(`Paying invoice...`)
    const result = node.pay(bolt11)
    console.log(`Payment result:`, JSON.stringify(result, null, 2))

    // Monitor payment events — pay() starts the node, keep it running to see result
    console.log('Monitoring payment events for 15 seconds...')
    node.start()
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const event = node.nextEvent()
      if (event) {
        console.log(`Event: type=${event.eventType} hash=${event.paymentHash} amount=${event.amountMsat}msat`)
        console.log(`Full event:`, JSON.stringify(event, null, 2))
        node.ackEvent()
        if (event.eventType === ljs.PaymentEventType.Sent ||
            event.eventType === ljs.PaymentEventType.Failed) {
          console.log(`Payment ${event.eventType === ljs.PaymentEventType.Sent ? 'SUCCEEDED' : 'FAILED'}`)
          break
        }
      }
      await new Promise(r => setTimeout(r, 500))
    }

    const newBalance = node.getBalanceWhileRunning()
    console.log(`Final balance: ${newBalance} sats`)
    try { node.stop() } catch {}
  } finally {
    node.destroy()
  }
}

async function cmdBalance(ljs) {
  const node = await getNode(ljs)
  try {
    // getBalance() self-manages start/stop
    const balance = node.getBalance()
    console.log(`Balance: ${balance} sats`)

    const channels = node.listChannels()
    if (channels.length === 0) {
      console.log('No channels yet.')
    } else {
      console.log(`\nChannels (${channels.length}):`)
      for (const ch of channels) {
        console.log(`  ${ch.channelId}`)
        console.log(`    Counterparty: ${ch.counterpartyNodeId}`)
        console.log(`    Outbound: ${Math.floor(ch.outboundCapacityMsat / 1000)} sats`)
        console.log(`    Inbound:  ${Math.floor(ch.inboundCapacityMsat / 1000)} sats`)
        console.log(`    Usable: ${ch.isUsable}, Ready: ${ch.isChannelReady}`)
      }
    }
  } finally {
    node.destroy()
  }
}

async function cmdInfo(ljs) {
  const state = loadState()
  if (!state?.mnemonic) {
    console.error('No mnemonic found. Run: node payer.js setup')
    process.exit(1)
  }
  const nodeId = ljs.deriveNodeId(state.mnemonic, MDK_CONFIG.network)
  console.log(`Node ID: ${nodeId}`)
  console.log(`Network: ${MDK_CONFIG.network}`)
  console.log(`LSP:     ${MDK_CONFIG.lspAddress}`)
}

async function main() {
  const args = process.argv.slice(2)
  const cmd = args[0]

  if (!cmd) {
    console.log('Usage: node payer.js <command>')
    console.log('')
    console.log('Commands:')
    console.log('  setup              Generate mnemonic and show node ID')
    console.log('  invoice <sats>     Generate invoice to receive funds')
    console.log('  pay <bolt11>       Pay a BOLT11 invoice')
    console.log('  balance            Show balance and channels')
    console.log('  info               Show node ID (no network needed)')
    process.exit(0)
  }

  const ljs = await loadLightning()

  switch (cmd) {
    case 'setup':
      await cmdSetup(ljs)
      break
    case 'invoice':
      await cmdInvoice(ljs, parseInt(args[1]))
      break
    case 'pay':
      await cmdPay(ljs, args[1])
      break
    case 'balance':
      await cmdBalance(ljs)
      break
    case 'info':
      await cmdInfo(ljs)
      break
    default:
      console.error(`Unknown command: ${cmd}`)
      process.exit(1)
  }
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
