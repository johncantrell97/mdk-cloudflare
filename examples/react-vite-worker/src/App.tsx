import { Checkout, useCheckout, useProducts } from '@moneydevkit/core/client'
import { useEffect, useMemo, useState } from 'react'
import type { Checkout as CheckoutState, ProductPrice } from 'mdk-cloudflare/types'
import { DEFAULT_API_PATH, getCheckout } from './mdk'

type Currency = 'SAT' | 'USD'

function useBrowserLocation() {
  const [location, setLocation] = useState(() => ({
    pathname: window.location.pathname,
    search: window.location.search,
  }))

  useEffect(() => {
    const onPopState = () => {
      setLocation({
        pathname: window.location.pathname,
        search: window.location.search,
      })
    }

    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const navigate = (href: string) => {
    const target = new URL(href, window.location.origin)
    if (target.origin !== window.location.origin) {
      window.location.assign(target.toString())
      return
    }

    window.history.pushState({}, '', `${target.pathname}${target.search}${target.hash}`)
    setLocation({
      pathname: target.pathname,
      search: target.search,
    })
  }

  return { ...location, navigate }
}

function formatPrice(price?: ProductPrice): string {
  if (!price) return 'Configured in MoneyDevKit'
  if (price.amountType === 'FREE') return 'Free'
  if (price.amountType === 'CUSTOM') return price.currency === 'USD' ? 'Custom USD amount' : 'Custom sats amount'
  if (price.priceAmount == null) return 'Configured in MoneyDevKit'
  if (price.currency === 'SAT') return `${new Intl.NumberFormat('en-US').format(price.priceAmount)} sats`
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: price.currency ?? 'USD',
  }).format(price.priceAmount / 100)
}

function HomePage({ navigate }: { navigate: (href: string) => void }) {
  const [amount, setAmount] = useState('2500')
  const [currency, setCurrency] = useState<Currency>('SAT')
  const [submitError, setSubmitError] = useState<string | null>(null)
  const { createCheckout, isLoading, error } = useCheckout()
  const { products, isLoading: isLoadingProducts } = useProducts()

  const startCheckout = async (
    params:
      | { type: 'AMOUNT'; amount: number; currency: Currency; title: string; description: string }
      | { type: 'PRODUCTS'; product: string },
  ) => {
    setSubmitError(null)
    const result = await createCheckout({
      ...params,
      successUrl: '/success',
      checkoutPath: '/checkout',
    })

    if (result.error) {
      setSubmitError(result.error.message)
      return
    }

    navigate(result.data.checkoutUrl)
  }

  return (
    <div className="shell">
      <section className="hero">
        <p className="eyebrow">React + Vite Worker Example</p>
        <h1>Cloudflare Worker backend, official MoneyDevKit checkout UI.</h1>
        <p className="lede">
          This example keeps the app shell intentionally small. Your Worker owns <code>/api/mdk</code>,
          the home page creates checkouts, and the official MoneyDevKit React component owns the payment screen.
        </p>
      </section>

      <div className="layout">
        <section className="panel">
          <div className="panel-header">
            <p className="panel-label">Amount Checkout</p>
            <p className="panel-copy">Create a fixed-amount checkout, then route the buyer into <code>/checkout/:id</code>.</p>
          </div>

          <label className="field">
            <span>Amount</span>
            <input
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              inputMode="decimal"
              placeholder="2500"
            />
          </label>

          <label className="field">
            <span>Currency</span>
            <select value={currency} onChange={(event) => setCurrency(event.target.value as Currency)}>
              <option value="SAT">SAT</option>
              <option value="USD">USD</option>
            </select>
          </label>

          <button
            className="primary-button"
            disabled={isLoading}
            onClick={() =>
              startCheckout({
                type: 'AMOUNT',
                amount: Number(amount),
                currency,
                title: 'Lightning checkout',
                description: 'Hosted by a Cloudflare Worker, rendered with the official MoneyDevKit checkout UI.',
              })}
          >
            {isLoading ? 'Creating checkout...' : 'Create amount checkout'}
          </button>
        </section>

        <section className="panel">
          <div className="panel-header">
            <p className="panel-label">Product Checkout</p>
            <p className="panel-copy">If your MDK app has products, you can start a product checkout directly from the Worker-hosted app shell.</p>
          </div>

          {isLoadingProducts ? (
            <p className="muted">Loading products...</p>
          ) : products.length === 0 ? (
            <p className="muted">No products were returned by the API. This is normal if your app is amount-only right now.</p>
          ) : (
            <div className="product-list">
              {products.map((product) => (
                <button
                  key={product.id}
                  className="product-card"
                  disabled={isLoading}
                  onClick={() => startCheckout({ type: 'PRODUCTS', product: product.id })}
                >
                  <span className="product-name">{product.name}</span>
                  <span className="product-copy">{product.description || 'Configured in the MoneyDevKit dashboard.'}</span>
                  <span className="product-price">{formatPrice(product.prices[0])}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>

      {(submitError || error?.message) && <p className="error-banner">{submitError || error?.message}</p>}
    </div>
  )
}

function isPaymentReceived(checkout: CheckoutState | null): boolean {
  return Boolean(
    checkout?.status === 'PAYMENT_RECEIVED'
    || checkout?.status === 'completed'
    || (checkout?.invoice?.amountSatsReceived ?? 0) > 0,
  )
}

function isExpired(checkout: CheckoutState | null): boolean {
  return checkout?.status === 'EXPIRED' || checkout?.status === 'expired'
}

function getSuccessUrl(checkoutId: string): string {
  const successUrl = new URL('/success', window.location.origin)
  successUrl.searchParams.set('checkoutId', checkoutId)
  return `${successUrl.pathname}${successUrl.search}`
}

function SuccessPage({
  checkoutId,
  navigate,
}: {
  checkoutId: string | null
  navigate: (href: string) => void
}) {
  const [checkout, setCheckout] = useState<CheckoutState | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!checkoutId) {
      return
    }

    let cancelled = false
    let timer: number | undefined

    const load = async () => {
      try {
        const result = await getCheckout(DEFAULT_API_PATH, checkoutId)
        if (cancelled) return
        setCheckout(result)
        setError(null)

        if (!isPaymentReceived(result) && !isExpired(result)) {
          timer = window.setTimeout(load, 1000)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
        }
      }
    }

    void load()

    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [checkoutId])

  const title = useMemo(() => {
    const value = checkout?.userMetadata?.title
    return typeof value === 'string' ? value : 'Payment verification'
  }, [checkout])

  const description = useMemo(() => {
    const value = checkout?.userMetadata?.description
    return typeof value === 'string'
      ? value
      : 'This page polls /api/mdk until the Worker sees the paid checkout.'
  }, [checkout])

  return (
    <div className="shell centered">
      <div className="status-card">
        <p className="eyebrow">Success</p>
        <h1>{title}</h1>
        <p className="lede compact">{description}</p>

        <div className="stack">
          <div className="fact-row">
            <span>Checkout ID</span>
            <strong>{checkoutId ?? 'Missing'}</strong>
          </div>
          <div className="fact-row">
            <span>Status</span>
            <strong>{checkout?.status ?? 'Loading'}</strong>
          </div>
          <div className="fact-row">
            <span>Paid</span>
            <strong>{checkout && isPaymentReceived(checkout) ? 'Yes' : 'Not yet'}</strong>
          </div>
        </div>

        {!isPaymentReceived(checkout) && !isExpired(checkout) && !error && (
          <p className="muted">Waiting for payment confirmation...</p>
        )}

        {isExpired(checkout) && (
          <p className="error-banner">This checkout expired before payment completed.</p>
        )}

        {error && <p className="error-banner">{error}</p>}

        <button className="secondary-button" onClick={() => navigate('/')}>
          Create another checkout
        </button>
      </div>
    </div>
  )
}

function CheckoutPage({
  checkoutId,
  navigate,
}: {
  checkoutId: string
  navigate: (href: string) => void
}) {
  useEffect(() => {
    let cancelled = false
    let timer: number | undefined

    const load = async () => {
      try {
        const result = await getCheckout(DEFAULT_API_PATH, checkoutId)
        if (cancelled) return

        if (isPaymentReceived(result)) {
          navigate(getSuccessUrl(checkoutId))
          return
        }

        if (!isExpired(result)) {
          timer = window.setTimeout(load, 1000)
        }
      } catch {
        timer = window.setTimeout(load, 1500)
      }
    }

    void load()

    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [checkoutId, navigate])

  return <Checkout id={checkoutId} />
}

export function App() {
  const location = useBrowserLocation()
  const checkoutMatch = /^\/checkout\/([^/]+)$/.exec(location.pathname)

  if (location.pathname === '/success') {
    const searchParams = new URLSearchParams(location.search)
    return <SuccessPage checkoutId={searchParams.get('checkoutId')} navigate={location.navigate} />
  }

  if (checkoutMatch) {
    return <CheckoutPage checkoutId={checkoutMatch[1]} navigate={location.navigate} />
  }

  return <HomePage navigate={location.navigate} />
}
