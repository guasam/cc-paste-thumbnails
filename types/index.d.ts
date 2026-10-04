export type Thumb = {
  n: number
  status: 'loading' | 'ready' | 'missing'
  path?: string
  width?: number
  height?: number
}

declare module 'claude-code' {
  interface PluginState {
    'cc-paste-thumbnails': { thumbs: Thumb[]; shown: number[] }
  }
}
