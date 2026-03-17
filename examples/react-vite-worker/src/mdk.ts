import type { Checkout } from 'mdk-cloudflare/types'

export const DEFAULT_API_PATH = '/api/mdk'

function getCookie(name: string): string | null {
  const cookies = document.cookie.split(';')
  for (const cookie of cookies) {
    const [key, ...rest] = cookie.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return null
}

function ensureCsrfToken(): string {
  let token = getCookie('mdk_csrf')
  if (!token) {
    token = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}`
  }

  const cookieAttributes = ['path=/']
  if (window.isSecureContext) {
    cookieAttributes.push('SameSite=None', 'Secure')
  } else {
    cookieAttributes.push('SameSite=Lax')
  }

  document.cookie = `mdk_csrf=${token}; ${cookieAttributes.join('; ')}`
  return token
}

async function postToMdk<T>(
  apiPath: string,
  handler: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(apiPath, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-moneydevkit-csrf-token': ensureCsrfToken(),
    },
    body: JSON.stringify({ handler, ...payload }),
  })

  const body = await response.json() as {
    data?: T
    error?: string
    details?: Array<{ message?: string }>
  }

  if (!response.ok || !('data' in body)) {
    throw new Error(body.details?.[0]?.message || body.error || `Request failed with status ${response.status}`)
  }

  return body.data as T
}

export function getCheckout(apiPath: string, checkoutId: string) {
  return postToMdk<Checkout>(apiPath, 'get_checkout', { checkoutId })
}
