import type {
  Checkout,
  ConfirmCheckoutOptions,
  CreateCheckoutOptions,
  Customer,
  CustomerIdentifier,
  Product,
} from './types.js'

const WEBHOOK_SECRET_HEADER = 'x-moneydevkit-webhook-secret'
const CSRF_HEADER = 'x-moneydevkit-csrf-token'
const CSRF_COOKIE = 'mdk_csrf'

export type UnifiedRoute =
  | 'webhook'
  | 'webhooks'
  | 'payout'
  | 'balance'
  | 'ping'
  | 'list_channels'
  | 'create_checkout'
  | 'get_checkout'
  | 'confirm_checkout'
  | 'list_products'
  | 'get_customer'

export interface UnifiedCheckoutNode {
  fetch(request: Request): Promise<Response>
  createCheckout(options: CreateCheckoutOptions): Promise<Checkout>
  confirmCheckout(confirm: ConfirmCheckoutOptions): Promise<Checkout>
  getCheckout(id: string): Promise<Checkout>
  listProducts(): Promise<Product[]>
  getCustomer(identifier: CustomerIdentifier, includeSandbox?: boolean): Promise<Customer>
}

export interface UnifiedRouteOptions {
  node: UnifiedCheckoutNode
  accessToken: string
}

export interface CreateCheckoutUrlOptions {
  accessToken: string
  basePath?: string
}

function jsonResponse(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function parseCookies(request: Request): Record<string, string> {
  const cookieHeader = request.headers.get('cookie') ?? ''
  return Object.fromEntries(
    cookieHeader
      .split(';')
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c) => {
        const [key, ...rest] = c.split('=')
        return [key, rest.join('=')]
      }),
  )
}

function validateCsrf(request: Request): Response | null {
  const origin = request.headers.get('origin')
  const host = request.headers.get('host')
  if (origin && host) {
    try {
      const originHost = new URL(origin).host
      if (originHost !== host) {
        return jsonResponse(403, { error: 'Invalid origin' })
      }
    } catch {
      // Ignore malformed origins and fall through to token checks.
    }
  }

  const cookies = parseCookies(request)
  const cookieToken = cookies[CSRF_COOKIE]
  const headerToken = request.headers.get(CSRF_HEADER)

  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return jsonResponse(401, { error: 'Unauthorized' })
  }

  return null
}

function parseRoute(body: Record<string, unknown>): UnifiedRoute | null {
  const candidates = [body.handler, body.route, body.target]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    switch (candidate.toLowerCase()) {
      case 'webhook':
      case 'webhooks':
      case 'payout':
      case 'balance':
      case 'ping':
      case 'list_channels':
      case 'create_checkout':
      case 'get_checkout':
      case 'confirm_checkout':
      case 'list_products':
      case 'get_customer':
        return candidate.toLowerCase() as UnifiedRoute
    }
  }

  return null
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) {
    mismatch |= a[i] ^ b[i]
  }
  return mismatch === 0
}

function validateWebhookSecret(
  request: Request,
  options: UnifiedRouteOptions,
  { silent = false } = {},
): Response | null {
  const expectedSecret = options.accessToken
  const providedSecret = request.headers.get(WEBHOOK_SECRET_HEADER)
  if (!providedSecret) {
    return silent ? jsonResponse(401, { error: 'Unauthorized' }) : jsonResponse(401, { error: 'Unauthorized' })
  }

  const encoder = new TextEncoder()
  if (!timingSafeEqual(encoder.encode(providedSecret), encoder.encode(expectedSecret))) {
    return silent ? jsonResponse(401, { error: 'Unauthorized' }) : jsonResponse(401, { error: 'Unauthorized' })
  }

  return null
}

function routeRequiresSecret(route: UnifiedRoute): boolean {
  return route === 'webhook' || route === 'webhooks' || route === 'payout' || route === 'balance' || route === 'ping' || route === 'list_channels'
}

function joinPath(base: string, segment: string): string {
  if (base === '/') return `/${segment}`
  return `${base}/${segment}`
}

function redirectToCheckoutError(baseUrl: URL, checkoutPath: string, code: string, message: string): Response {
  const errorUrl = new URL(joinPath(checkoutPath, 'error'), baseUrl.origin)
  errorUrl.searchParams.set('error', code)
  errorUrl.searchParams.set('message', message)
  return Response.redirect(errorUrl.toString(), 302)
}

/**
 * Validates and sanitizes checkoutPath to prevent open redirects.
 */
export function sanitizeCheckoutPath(checkoutPath: string | null): string {
  const defaultPath = '/checkout'
  if (!checkoutPath) return defaultPath
  if (!checkoutPath.startsWith('/')) return defaultPath
  if (checkoutPath.includes('://') || checkoutPath.includes('//')) return defaultPath

  const queryIndex = checkoutPath.indexOf('?')
  const hashIndex = checkoutPath.indexOf('#')
  let endIndex = checkoutPath.length
  if (queryIndex !== -1) endIndex = Math.min(endIndex, queryIndex)
  if (hashIndex !== -1) endIndex = Math.min(endIndex, hashIndex)
  return checkoutPath.slice(0, endIndex)
}

function assertObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isCustomerIdentifier(value: unknown): value is CustomerIdentifier {
  if (!assertObject(value)) return false
  const hasExternalId = typeof value.externalId === 'string'
  const hasEmail = typeof value.email === 'string'
  const hasCustomerId = typeof value.customerId === 'string'
  return Number(hasExternalId) + Number(hasEmail) + Number(hasCustomerId) === 1
}

function isConfirmCheckoutOptions(value: unknown): value is ConfirmCheckoutOptions {
  if (!assertObject(value) || typeof value.checkoutId !== 'string') return false
  if (value.products != null && !Array.isArray(value.products)) return false
  return true
}

function parseBoolean(value: string): boolean | undefined {
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

/**
 * Parse URL query params into checkout params.
 */
export function parseCheckoutQueryParams(params: URLSearchParams): Record<string, unknown> {
  const raw: Record<string, unknown> = {}

  for (const [key, value] of params) {
    if (key === 'action' || key === 'signature') continue

    if (key === 'metadata' || key === 'customer' || key === 'requireCustomerData') {
      try {
        raw[key] = JSON.parse(value)
      } catch {
        raw[key] = value
      }
      continue
    }

    if (key === 'amount') {
      raw[key] = Number(value)
      continue
    }

    if (key === 'allowDiscountCodes') {
      raw[key] = parseBoolean(value)
      continue
    }

    raw[key] = value
  }

  return raw
}

function createCanonicalParams(params: URLSearchParams): string {
  const clone = new URLSearchParams(params)
  clone.sort()
  return clone.toString()
}

async function signCheckoutParams(params: URLSearchParams, accessToken: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(accessToken),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(createCanonicalParams(params)))
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Generate a signed checkout URL for URL-based checkout creation.
 */
export async function createCheckoutUrl(
  params: CreateCheckoutOptions & { checkoutPath?: string },
  options: CreateCheckoutUrlOptions,
): Promise<string> {
  const basePath = options.basePath ?? '/api/mdk'
  const urlParams = new URLSearchParams()
  urlParams.set('action', 'createCheckout')

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    if (typeof value === 'object' && value !== null) {
      urlParams.set(key, JSON.stringify(value))
    } else {
      urlParams.set(key, String(value))
    }
  }

  urlParams.sort()
  urlParams.set('signature', await signCheckoutParams(urlParams, options.accessToken))
  return `${basePath}?${urlParams.toString()}`
}

/**
 * Verify the HMAC signature of checkout URL params.
 */
export async function verifyCheckoutSignature(
  params: URLSearchParams,
  signature: string,
  accessToken: string,
): Promise<boolean> {
  const paramsToVerify = new URLSearchParams(params)
  paramsToVerify.delete('signature')
  const expected = await signCheckoutParams(paramsToVerify, accessToken)
  const encoder = new TextEncoder()
  return timingSafeEqual(encoder.encode(signature.toLowerCase()), encoder.encode(expected))
}

async function handlePost(request: Request, options: UnifiedRouteOptions): Promise<Response> {
  let rawBody: string
  try {
    rawBody = await request.text()
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' })
  }

  let body: unknown
  try {
    body = JSON.parse(rawBody) as unknown
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' })
  }

  if (!assertObject(body)) {
    return jsonResponse(400, { error: 'Invalid JSON body' })
  }

  const route = parseRoute(body)
  if (!route) {
    return jsonResponse(400, {
      error: 'Missing or invalid handler. Include a JSON body with a "handler" property.',
    })
  }

  if (routeRequiresSecret(route)) {
    const authError = validateWebhookSecret(request, options)
    if (authError) return authError
    if (route === 'webhook') {
      const forwardedBody = { ...body, handler: 'webhooks' }
      return options.node.fetch(new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: JSON.stringify(forwardedBody),
      }))
    }
    return options.node.fetch(new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: rawBody,
    }))
  }

  const secretError = validateWebhookSecret(request, options, { silent: true })
  if (secretError) {
    const csrfError = validateCsrf(request)
    if (csrfError) return csrfError
  }

  try {
    switch (route) {
      case 'create_checkout': {
        const params = body.params
        if (!assertObject(params)) {
          return jsonResponse(400, { error: 'Invalid checkout params' })
        }
        const { checkoutPath: _checkoutPath, ...checkoutParams } = params
        const checkout = await options.node.createCheckout(checkoutParams as CreateCheckoutOptions)
        return jsonResponse(200, { data: checkout })
      }

      case 'get_checkout': {
        if (typeof body.checkoutId !== 'string' || body.checkoutId.length === 0) {
          return jsonResponse(400, { error: 'Missing checkoutId' })
        }
        const checkout = await options.node.getCheckout(body.checkoutId)
        return jsonResponse(200, { data: checkout })
      }

      case 'confirm_checkout': {
        if (!isConfirmCheckoutOptions(body.confirm)) {
          return jsonResponse(400, { error: 'Invalid confirm payload' })
        }
        const checkout = await options.node.confirmCheckout(body.confirm)
        return jsonResponse(200, { data: checkout })
      }

      case 'list_products': {
        const products = await options.node.listProducts()
        return jsonResponse(200, { data: { products } })
      }

      case 'get_customer': {
        const includeSandbox = body.includeSandbox === true
        if (!isCustomerIdentifier(body)) {
          return jsonResponse(400, {
            error: 'Exactly one of externalId, email, or customerId must be provided',
          })
        }
        const customer = await options.node.getCustomer(body, includeSandbox)
        return jsonResponse(200, { data: customer })
      }

      default:
        return jsonResponse(400, { error: `Unknown handler: ${route}` })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return jsonResponse(500, { error: message })
  }
}

async function handleGet(request: Request, options: UnifiedRouteOptions): Promise<Response> {
  const url = new URL(request.url)
  const params = url.searchParams
  const action = params.get('action')
  const checkoutPath = sanitizeCheckoutPath(params.get('checkoutPath'))
  const signature = params.get('signature')

  if (action !== 'createCheckout') {
    return new Response('Not found', { status: 404 })
  }

  if (!signature) {
    return redirectToCheckoutError(url, checkoutPath, 'missing_signature', 'Missing signature')
  }

  const isValid = await verifyCheckoutSignature(params, signature, options.accessToken)
  if (!isValid) {
    return redirectToCheckoutError(url, checkoutPath, 'invalid_signature', 'Invalid signature')
  }

  try {
    const rawParams = parseCheckoutQueryParams(params)
    delete rawParams.checkoutPath
    const result = await options.node.createCheckout(rawParams as CreateCheckoutOptions)
    const checkoutUrl = new URL(joinPath(checkoutPath, result.id), url.origin)
    return Response.redirect(checkoutUrl.toString(), 302)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return redirectToCheckoutError(url, checkoutPath, 'checkout_creation_failed', message)
  }
}

export async function handleUnifiedRequest(request: Request, options: UnifiedRouteOptions): Promise<Response> {
  if (request.method === 'GET') {
    return handleGet(request, options)
  }
  if (request.method === 'POST') {
    return handlePost(request, options)
  }
  return new Response('Method not allowed', { status: 405 })
}

export function createUnifiedHandler(options: UnifiedRouteOptions) {
  return (request: Request) => handleUnifiedRequest(request, options)
}
