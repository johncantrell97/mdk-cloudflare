export function renderDashboard(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MDK Cloudflare</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0a0a0c;
    --surface: #111114;
    --surface-2: #18181c;
    --border: #222228;
    --border-glow: #f7931a22;
    --text: #e8e8ed;
    --text-dim: #6e6e7a;
    --text-muted: #3a3a44;
    --orange: #f7931a;
    --orange-dim: #f7931a44;
    --green: #22c55e;
    --green-dim: #22c55e33;
    --red: #ef4444;
    --red-dim: #ef444433;
    --blue: #3b82f6;
    --blue-dim: #3b82f633;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: 'JetBrains Mono', monospace;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    overflow-x: hidden;
  }

  /* Subtle noise texture overlay */
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.03'/%3E%3C/svg%3E");
    pointer-events: none;
    z-index: 9999;
  }

  .container {
    max-width: 960px;
    margin: 0 auto;
    padding: 2rem 1.5rem 4rem;
  }

  /* ── Header ────────────────────────────────── */

  header {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-bottom: 2.5rem;
    padding-bottom: 1.5rem;
    border-bottom: 1px solid var(--border);
  }

  .logo {
    width: 36px;
    height: 36px;
    background: var(--orange);
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    font-weight: 700;
    color: var(--bg);
    flex-shrink: 0;
    box-shadow: 0 0 20px var(--orange-dim);
  }

  header h1 {
    font-family: 'Outfit', sans-serif;
    font-size: 1.4rem;
    font-weight: 600;
    letter-spacing: -0.02em;
    color: var(--text);
  }

  header .subtitle {
    font-size: 0.7rem;
    color: var(--text-dim);
    font-weight: 400;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    margin-top: 2px;
  }

  .header-right {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .status-badge {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.65rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-dim);
    background: var(--surface);
    border: 1px solid var(--border);
    padding: 0.35rem 0.7rem;
    border-radius: 6px;
  }

  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--green);
    box-shadow: 0 0 6px var(--green);
    animation: pulse 2s ease-in-out infinite;
  }

  .status-dot.loading {
    background: var(--orange);
    box-shadow: 0 0 6px var(--orange);
    animation: pulse 1s ease-in-out infinite;
  }

  .status-dot.error {
    background: var(--red);
    box-shadow: 0 0 6px var(--red);
    animation: none;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  .refresh-btn {
    background: none;
    border: 1px solid var(--border);
    color: var(--text-dim);
    padding: 0.35rem 0.6rem;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.7rem;
    font-family: inherit;
    transition: all 0.2s;
  }

  .refresh-btn:hover {
    border-color: var(--orange);
    color: var(--orange);
  }

  .refresh-btn.spinning svg {
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* ── Grid ───────────────────────────────────── */

  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .grid .full-width {
    grid-column: 1 / -1;
  }

  /* ── Cards ──────────────────────────────────── */

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1.25rem;
    position: relative;
    overflow: hidden;
    transition: border-color 0.3s;
  }

  .card:hover {
    border-color: var(--border-glow);
  }

  .card-label {
    font-size: 0.6rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--text-dim);
    margin-bottom: 0.75rem;
  }

  /* ── Balance Card ──────────────────────────── */

  .balance-card {
    background: linear-gradient(135deg, var(--surface) 0%, #141418 100%);
    border-color: var(--orange-dim);
  }

  .balance-value {
    font-family: 'Outfit', sans-serif;
    font-size: 2.8rem;
    font-weight: 700;
    color: var(--text);
    line-height: 1;
    margin-bottom: 0.25rem;
    letter-spacing: -0.03em;
  }

  .balance-unit {
    font-size: 1rem;
    font-weight: 300;
    color: var(--text-dim);
    margin-left: 0.25rem;
  }

  .balance-sub {
    font-size: 0.7rem;
    color: var(--text-dim);
    font-weight: 400;
  }

  /* ── Chain Card ────────────────────────────── */

  .chain-height {
    font-family: 'Outfit', sans-serif;
    font-size: 2rem;
    font-weight: 600;
    color: var(--text);
    letter-spacing: -0.02em;
  }

  .chain-hash {
    font-size: 0.65rem;
    color: var(--text-muted);
    word-break: break-all;
    line-height: 1.6;
    margin-top: 0.5rem;
  }

  /* ── Node ID ───────────────────────────────── */

  .node-id-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .node-id {
    font-size: 0.68rem;
    color: var(--text-dim);
    word-break: break-all;
    line-height: 1.6;
    flex: 1;
    user-select: all;
  }

  .copy-btn {
    background: none;
    border: 1px solid var(--border);
    color: var(--text-muted);
    padding: 0.3rem 0.5rem;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.6rem;
    font-family: inherit;
    transition: all 0.2s;
    flex-shrink: 0;
  }

  .copy-btn:hover { border-color: var(--text-dim); color: var(--text-dim); }
  .copy-btn.copied { border-color: var(--green); color: var(--green); }

  .network-tag {
    display: inline-block;
    font-size: 0.55rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    padding: 0.2rem 0.5rem;
    border-radius: 4px;
    background: var(--orange-dim);
    color: var(--orange);
    margin-top: 0.6rem;
  }

  /* ── Channels ──────────────────────────────── */

  .channel {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1rem;
    margin-top: 0.75rem;
  }

  .channel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.75rem;
  }

  .channel-id {
    font-size: 0.65rem;
    color: var(--text-dim);
    font-weight: 500;
  }

  .channel-status {
    display: flex;
    gap: 0.4rem;
  }

  .tag {
    font-size: 0.55rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 0.15rem 0.45rem;
    border-radius: 3px;
  }

  .tag.ready { background: var(--green-dim); color: var(--green); }
  .tag.not-ready { background: var(--red-dim); color: var(--red); }
  .tag.private { background: var(--surface); color: var(--text-muted); border: 1px solid var(--border); }

  .capacity-bar {
    height: 6px;
    background: var(--surface);
    border-radius: 3px;
    overflow: hidden;
    margin: 0.6rem 0;
    display: flex;
  }

  .capacity-out {
    background: var(--orange);
    border-radius: 3px 0 0 3px;
    transition: width 0.6s ease;
  }

  .capacity-in {
    background: var(--blue);
    border-radius: 0 3px 3px 0;
    transition: width 0.6s ease;
  }

  .capacity-labels {
    display: flex;
    justify-content: space-between;
    font-size: 0.6rem;
  }

  .capacity-labels .out { color: var(--orange); }
  .capacity-labels .in { color: var(--blue); }

  .channel-peer {
    font-size: 0.6rem;
    color: var(--text-muted);
    margin-top: 0.5rem;
    word-break: break-all;
    line-height: 1.5;
  }

  .no-channels {
    color: var(--text-muted);
    font-size: 0.75rem;
    text-align: center;
    padding: 2rem 0;
  }

  /* ── Config ────────────────────────────────── */

  .config-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 0.4rem 0;
    border-bottom: 1px solid var(--border);
    font-size: 0.68rem;
  }

  .config-row:last-child { border-bottom: none; }
  .config-key { color: var(--text-dim); }

  .config-val {
    color: var(--text);
    text-align: right;
    word-break: break-all;
    max-width: 60%;
  }

  /* ── Invoice Panel ──────────────────────────── */

  .invoice-form {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .invoice-input {
    flex: 1;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    color: var(--text);
    font-family: inherit;
    font-size: 0.75rem;
    outline: none;
    transition: border-color 0.2s;
  }

  .invoice-input:focus {
    border-color: var(--orange);
  }

  .invoice-input::placeholder {
    color: var(--text-muted);
  }

  .invoice-btn {
    background: var(--orange);
    border: none;
    border-radius: 6px;
    padding: 0.5rem 1rem;
    color: var(--bg);
    font-family: inherit;
    font-size: 0.7rem;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.2s;
  }

  .invoice-btn:hover { filter: brightness(1.15); }
  .invoice-btn:disabled { opacity: 0.5; cursor: not-allowed; filter: none; }

  .invoice-result {
    margin-top: 1rem;
    animation: fadeIn 0.3s ease both;
  }

  .qr-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    padding: 1rem 0;
  }

  .qr-wrap {
    background: #fff;
    padding: 12px;
    border-radius: 10px;
    display: inline-block;
    box-shadow: 0 0 30px rgba(247, 147, 26, 0.08);
  }

  .qr-wrap canvas {
    display: block;
  }

  .invoice-amount-label {
    font-family: 'Outfit', sans-serif;
    font-size: 1.3rem;
    font-weight: 600;
    color: var(--text);
  }

  .invoice-amount-label span {
    font-size: 0.8rem;
    font-weight: 300;
    color: var(--text-dim);
  }

  .invoice-string {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.6rem 0.75rem;
    font-size: 0.58rem;
    color: var(--text-dim);
    word-break: break-all;
    line-height: 1.6;
    cursor: pointer;
    transition: border-color 0.2s;
    position: relative;
  }

  .invoice-string:hover {
    border-color: var(--text-muted);
  }

  .invoice-string::after {
    content: 'click to copy';
    position: absolute;
    right: 0.5rem;
    top: 0.4rem;
    font-size: 0.55rem;
    color: var(--text-muted);
    opacity: 0;
    transition: opacity 0.2s;
  }

  .invoice-string:hover::after { opacity: 1; }

  .invoice-string.copied-flash {
    border-color: var(--green);
  }

  .invoice-string.copied-flash::after {
    content: 'copied!';
    opacity: 1;
    color: var(--green);
  }

  .invoice-meta {
    display: flex;
    justify-content: space-between;
    margin-top: 0.5rem;
    font-size: 0.6rem;
    color: var(--text-muted);
  }

  .invoice-status {
    font-size: 0.65rem;
    color: var(--text-dim);
    text-align: center;
    margin-top: 0.5rem;
  }

  .invoice-status.generating {
    color: var(--orange);
  }

  /* ── Loading / Error ───────────────────────── */

  .loading-text {
    color: var(--text-muted);
    font-size: 0.75rem;
    text-align: center;
    padding: 3rem 0;
  }

  .error-banner {
    background: var(--red-dim);
    border: 1px solid var(--red);
    border-radius: 8px;
    padding: 0.75rem 1rem;
    font-size: 0.7rem;
    color: var(--red);
    margin-bottom: 1rem;
  }

  /* ── Animations ────────────────────────────── */

  .fade-in {
    animation: fadeIn 0.4s ease both;
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .card:nth-child(1) { animation-delay: 0ms; }
  .card:nth-child(2) { animation-delay: 60ms; }
  .card:nth-child(3) { animation-delay: 120ms; }
  .card:nth-child(4) { animation-delay: 180ms; }
  .card:nth-child(5) { animation-delay: 240ms; }

  /* ── Responsive ────────────────────────────── */

  @media (max-width: 640px) {
    .grid { grid-template-columns: 1fr; }
    .balance-value { font-size: 2.2rem; }
    .container { padding: 1rem 0.75rem 3rem; }

    header {
      flex-wrap: wrap;
      gap: 0.6rem;
    }

    header h1 { font-size: 1.15rem; }

    .header-right {
      width: 100%;
      justify-content: flex-end;
      margin-top: -0.25rem;
    }

    .invoice-form {
      flex-direction: column;
    }

    .invoice-input,
    .invoice-btn {
      width: 100%;
      padding: 0.65rem 0.75rem;
      font-size: 0.8rem;
    }

    .qr-wrap canvas {
      width: 200px !important;
      height: 200px !important;
    }

    .config-row {
      flex-direction: column;
      gap: 0.15rem;
    }

    .config-val {
      text-align: left;
      max-width: 100%;
      font-size: 0.6rem;
    }

    .channel-header {
      flex-direction: column;
      align-items: flex-start;
      gap: 0.4rem;
    }

    .capacity-labels {
      flex-direction: column;
      gap: 0.15rem;
    }
  }
</style>
</head>
<body>
<div class="container">
  <header>
    <div class="logo">&#9889;</div>
    <div>
      <h1>MDK Cloudflare</h1>
      <div class="subtitle">Lightning Node</div>
    </div>
    <div class="header-right">
      <div class="status-badge">
        <span class="status-dot loading" id="statusDot"></span>
        <span id="statusText">loading</span>
      </div>
      <button class="refresh-btn" id="refreshBtn" onclick="loadData()">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="23 4 23 10 17 10"></polyline>
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
        </svg>
      </button>
    </div>
  </header>

  <div id="error"></div>
  <div id="content">
    <div class="loading-text">Connecting to node...</div>
  </div>
</div>

<script>
  let data = null

  async function loadData() {
    const btn = document.getElementById('refreshBtn')
    const dot = document.getElementById('statusDot')
    const statusText = document.getElementById('statusText')

    btn.classList.add('spinning')
    dot.className = 'status-dot loading'
    statusText.textContent = 'loading'
    document.getElementById('error').innerHTML = ''

    try {
      const res = await fetch('/api/debug')
      if (!res.ok) throw new Error('HTTP ' + res.status)
      data = await res.json()
      render(data)
      dot.className = 'status-dot'
      statusText.textContent = 'online'
    } catch (err) {
      dot.className = 'status-dot error'
      statusText.textContent = 'error'
      document.getElementById('error').innerHTML =
        '<div class="error-banner">' + err.message + '</div>'
    } finally {
      btn.classList.remove('spinning')
    }
  }

  function fmtSats(sats) {
    return sats.toLocaleString()
  }

  function fmtMsat(msat) {
    return fmtSats(Math.floor(msat / 1000))
  }

  function truncate(s, n) {
    if (!s || s.length <= n) return s
    return s.slice(0, n/2) + '...' + s.slice(-n/2)
  }

  function copyText(text, btnId) {
    navigator.clipboard.writeText(text)
    const btn = document.getElementById(btnId)
    btn.textContent = 'copied'
    btn.classList.add('copied')
    setTimeout(() => {
      btn.textContent = 'copy'
      btn.classList.remove('copied')
    }, 1500)
  }

  function render(d) {
    const nodeInfo = d.nodeInfo || {
      balanceSats: 0,
      channels: Array.isArray(d.channels) ? d.channels : [],
    }
    const balance = nodeInfo.balanceSats ?? 0
    const channels = nodeInfo.channels ?? []
    const chain = d.chain || {}
    const node = d.node || {}
    const config = d.config || {}

    let channelsHtml = ''
    if (channels.length === 0) {
      channelsHtml = '<div class="no-channels">No channels yet</div>'
    } else {
      for (const c of channels) {
        const total = (c.inboundCapacityMsat + c.outboundCapacityMsat) || 1
        const outPct = ((c.outboundCapacityMsat / total) * 100).toFixed(1)
        const inPct = ((c.inboundCapacityMsat / total) * 100).toFixed(1)
        channelsHtml += '<div class="channel">' +
          '<div class="channel-header">' +
            '<span class="channel-id">' + truncate(c.channelId, 20) + '</span>' +
            '<div class="channel-status">' +
              '<span class="tag ' + (c.isChannelReady ? 'ready' : 'not-ready') + '">' +
                (c.isChannelReady ? 'ready' : 'pending') + '</span>' +
              '<span class="tag private">private</span>' +
            '</div>' +
          '</div>' +
          '<div class="capacity-bar">' +
            '<div class="capacity-out" style="width:' + outPct + '%"></div>' +
            '<div class="capacity-in" style="width:' + inPct + '%"></div>' +
          '</div>' +
          '<div class="capacity-labels">' +
            '<span class="out">&#9650; ' + fmtMsat(c.outboundCapacityMsat) + ' sats out</span>' +
            '<span class="in">&#9660; ' + fmtMsat(c.inboundCapacityMsat) + ' sats in</span>' +
          '</div>' +
          '<div class="channel-peer">peer: ' + c.counterpartyNodeId + '</div>' +
        '</div>'
      }
    }

    document.getElementById('content').innerHTML =
      '<div class="grid">' +
        '<div class="card balance-card fade-in">' +
          '<div class="card-label">Balance</div>' +
          '<div class="balance-value">' + fmtSats(balance) + '<span class="balance-unit">sats</span></div>' +
          '<div class="balance-sub">' + channels.length + ' channel' + (channels.length !== 1 ? 's' : '') + '</div>' +
        '</div>' +

        '<div class="card fade-in">' +
          '<div class="card-label">Create Invoice</div>' +
          '<div class="invoice-form">' +
            '<input type="number" class="invoice-input" id="invoiceAmount" placeholder="Amount in sats" min="1" step="1">' +
            '<button class="invoice-btn" id="invoiceBtn" onclick="createInvoice()">Generate</button>' +
          '</div>' +
          '<div id="invoiceResult"></div>' +
        '</div>' +

        '<div class="card fade-in">' +
          '<div class="card-label">Chain Tip</div>' +
          '<div class="chain-height">#' + (chain.height?.toLocaleString() ?? '???') + '</div>' +
          '<div class="chain-hash">' + (chain.hash ?? '') + '</div>' +
        '</div>' +

        '<div class="card full-width fade-in">' +
          '<div class="card-label">Node Identity</div>' +
          '<div class="node-id-row">' +
            '<div class="node-id">' + (node.nodeId ?? '') + '</div>' +
            '<button class="copy-btn" id="copyNodeId" onclick="copyText(\\'' + (node.nodeId ?? '') + '\\', \\'copyNodeId\\')">copy</button>' +
          '</div>' +
          '<span class="network-tag">' + (node.network ?? '') + '</span>' +
        '</div>' +

        '<div class="card full-width fade-in">' +
          '<div class="card-label">Channels</div>' +
          channelsHtml +
        '</div>' +

        '<div class="card full-width fade-in">' +
          '<div class="card-label">Configuration</div>' +
          '<div class="config-row"><span class="config-key">LSP</span><span class="config-val">' + (config.lspAddress ?? '') + '</span></div>' +
          '<div class="config-row"><span class="config-key">Esplora</span><span class="config-val">' + (config.esploraUrl ?? '') + '</span></div>' +
          '<div class="config-row"><span class="config-key">Storage</span><span class="config-val">DO SQLite</span></div>' +
          '<div class="config-row"><span class="config-key">RGS</span><span class="config-val">' + (config.rgsUrl ?? '') + '</span></div>' +
          '<div class="config-row"><span class="config-key">LSP Node</span><span class="config-val" style="font-size:0.58rem">' + (config.lspNodeId ?? '') + '</span></div>' +
        '</div>' +
      '</div>'
  }

  async function createInvoice() {
    const input = document.getElementById('invoiceAmount')
    const btn = document.getElementById('invoiceBtn')
    const result = document.getElementById('invoiceResult')
    const amount = parseInt(input.value)

    if (!amount || amount < 1) {
      input.style.borderColor = 'var(--red)'
      setTimeout(() => input.style.borderColor = '', 1000)
      return
    }

    btn.disabled = true
    btn.textContent = 'Creating...'
    result.innerHTML = '<div class="invoice-status generating">Generating invoice...</div>'

    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: amount, currency: 'SAT' }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'HTTP ' + res.status }))
        throw new Error(err.error || 'Failed')
      }
      const checkout = await res.json()
      showInvoice(checkout, amount)
    } catch (err) {
      result.innerHTML = '<div class="error-banner" style="margin-top:0.75rem">' + err.message + '</div>'
    } finally {
      btn.disabled = false
      btn.textContent = 'Generate'
    }
  }

  function showInvoice(checkout, amount) {
    const result = document.getElementById('invoiceResult')
    const bolt11 = checkout.invoice

    result.innerHTML =
      '<div class="invoice-result">' +
        '<div class="qr-container">' +
          '<div class="invoice-amount-label">' + fmtSats(amount) + ' <span>sats</span></div>' +
          '<div class="qr-wrap"><canvas id="qrCanvas"></canvas></div>' +
        '</div>' +
        '<div class="invoice-string" id="invoiceCopy" onclick="copyInvoice()">' + bolt11 + '</div>' +
        '<div class="invoice-meta">' +
          '<span>checkout: ' + checkout.id + '</span>' +
          '<span>hash: ' + (checkout.paymentHash || '').slice(0, 12) + '...</span>' +
        '</div>' +
      '</div>'

    // Render QR
    const canvas = document.getElementById('qrCanvas')
    if (canvas) {
      const qrSize = window.innerWidth < 640 ? 200 : 240
      renderQR(canvas, bolt11.toUpperCase(), qrSize)
    }

    // Start polling for payment
    if (checkout.id) pollCheckout(checkout.id)
  }

  function copyInvoice() {
    const el = document.getElementById('invoiceCopy')
    navigator.clipboard.writeText(el.textContent)
    el.classList.add('copied-flash')
    setTimeout(() => el.classList.remove('copied-flash'), 1500)
  }

  async function pollCheckout(checkoutId) {
    const maxPolls = 120
    for (let i = 0; i < maxPolls; i++) {
      await new Promise(r => setTimeout(r, 2000))
      try {
        const res = await fetch('/api/checkout/' + checkoutId)
        if (!res.ok) continue
        const checkout = await res.json()
        if (checkout.status === 'PAYMENT_RECEIVED' || checkout.status === 'COMPLETED') {
          // Payment received — refresh dashboard
          const result = document.getElementById('invoiceResult')
          if (result) {
            result.innerHTML =
              '<div class="invoice-status" style="color:var(--green);margin-top:1rem">' +
                '&#10003; Payment received!' +
              '</div>'
          }
          setTimeout(() => loadData(), 1500)
          return
        }
      } catch {}
    }
  }

  function renderQR(canvas, text, size) {
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, size, size)
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => ctx.drawImage(img, 0, 0, size, size)
    img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=' + size + 'x' + size +
      '&data=' + encodeURIComponent(text) + '&margin=0'
  }

  loadData()
</script>
</body>
</html>`
}
