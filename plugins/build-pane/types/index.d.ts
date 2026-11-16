export type Build = {
  repo: string
  runNumber: number | null
  workflow: string
  status: string
  conclusion: string | null
  branch: string
  title: string
  url: string
  startedAt: string
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'build-pane': { builds: Build[]; checkedAt: number }
  }
}
