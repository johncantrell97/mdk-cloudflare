import type {
  Checkout,
  ConfirmCheckoutOptions,
  CreateCheckoutOptions,
  Customer,
  CustomerIdentifier,
  PaymentReceived,
  Product,
  RegisterInvoice,
} from './types.js'

const DEFAULT_BASE_URL = 'https://moneydevkit.com/rpc'

export interface MoneyDevKitClientOptions {
  accessToken: string
  baseUrl?: string
}

/**
 * oRPC API client for MDK backend.
 * Reimplements @moneydevkit/core MoneyDevKitClient for CF Workers.
 */
export class MoneyDevKitClient {
  private readonly accessToken: string
  private readonly baseUrl: string

  constructor(options: MoneyDevKitClientOptions) {
    this.accessToken = options.accessToken
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
  }

  get checkouts() {
    return {
      get: (params: { id: string }) =>
        this.rpc<Checkout>('checkout/get', { id: params.id }),

      create: (fields: CreateCheckoutOptions, nodeId: string) => {
        const { product, ...rest } = fields
        return this.rpc<Checkout>('checkout/create', {
          nodeId,
          ...rest,
          products: product ? [product] : undefined,
        })
      },

      confirm: (params: ConfirmCheckoutOptions) =>
        this.rpc<Checkout>('checkout/confirm', params),

      registerInvoice: (params: RegisterInvoice) =>
        this.rpc<Checkout>(
          'checkout/registerInvoice',
          {
            checkoutId: params.checkoutId,
            nodeId: params.nodeId,
            invoice: params.invoice,
            paymentHash: params.paymentHash,
            scid: params.scid,
            invoiceExpiresAt: params.invoiceExpiresAt.toISOString(),
          },
          [[1, 'invoiceExpiresAt']],
        ),

      paymentReceived: (params: PaymentReceived) =>
        this.rpc<{ ok: boolean }>('checkout/paymentReceived', params),
    }
  }

  get products() {
    return {
      list: () => this.rpc<{ products: Product[] }>('products/list', {}),
    }
  }

  get customers() {
    return {
      get: (params: CustomerIdentifier & { includeSandbox?: boolean }) =>
        this.rpc<Customer>('customer/getSdk', params),
    }
  }

  /**
   * Call an MDK oRPC procedure.
   * Wire format: POST /{procedure}, body { json: data, meta?: [...] }
   * Response: { json: T, meta?: unknown }
   */
  private async rpc<T>(procedure: string, input: unknown, meta?: unknown[]): Promise<T> {
    const body: Record<string, unknown> = { json: input }
    if (meta) body.meta = meta

    const resp = await fetch(`${this.baseUrl}/${procedure}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.accessToken,
      },
      body: JSON.stringify(body),
    })

    const raw = await resp.text()
    let data: { json?: T & { code?: string; message?: string }; meta?: unknown } | undefined
    if (raw) {
      try {
        data = JSON.parse(raw) as { json?: T & { code?: string; message?: string }; meta?: unknown }
      } catch {
        if (!resp.ok) {
          throw new Error(raw || `MDK API error: ${resp.status}`)
        }
        throw new Error(`MDK API returned invalid JSON for ${procedure}`)
      }
    }

    if (!resp.ok) {
      const msg = data?.json?.message || raw || `MDK API error: ${resp.status}`
      throw new Error(msg)
    }

    if (!data?.json) {
      throw new Error(`MDK API returned invalid response for ${procedure}`)
    }
    if (data.json.code) {
      throw new Error(data.json.message || `MDK API error for ${procedure}`)
    }

    return data.json
  }
}
