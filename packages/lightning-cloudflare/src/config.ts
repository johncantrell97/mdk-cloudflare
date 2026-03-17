/** Mainnet MDK node options — matches @moneydevkit/core MAINNET_MDK_NODE_OPTIONS */
export const MAINNET_MDK_NODE_OPTIONS = {
  network: 'mainnet',
  esploraUrl: 'https://esplora.moneydevkit.com/api',
  rgsUrl: 'https://rapidsync.lightningdevkit.org/snapshot/v2',
  lspNodeId: '02a63339cc6b913b6330bd61b2f469af8785a6011a6305bb102298a8e76697473b',
  lspAddress: 'lsp.moneydevkit.com:9735',
  lspCltvExpiryDelta: 72,
} as const

/** Signet MDK node options — matches @moneydevkit/core SIGNET_MDK_NODE_OPTIONS */
export const SIGNET_MDK_NODE_OPTIONS = {
  network: 'signet',
  esploraUrl: 'https://mutinynet.com/api',
  rgsUrl: 'https://rgs.mutinynet.com/snapshot',
  lspNodeId: '03fd9a377576df94cc7e458471c43c400630655083dee89df66c6ad38d1b7acffd',
  lspAddress: 'lsp.staging.moneydevkit.com:9735',
  lspCltvExpiryDelta: 72,
} as const

export interface LightningNodeOptions {
  network: string
  esploraUrl: string
  rgsUrl?: string
  lspNodeId: string
  lspAddress: string
  lspCltvExpiryDelta: number
}
