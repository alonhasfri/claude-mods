import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Build } from '../types'

// A pane with the latest GitHub Actions build of each app, and a phone
// notification when a build on main finishes (APK ready, or failed).
//
//   /builds                 open the pane
//   /builds refresh         check now
//   /builds add owner/repo  watch another repo
//   /builds remove repo     stop watching one

const PANE = 'builds'
const DEFAULT_REPOS = ['alonhasfri/combo-checker', 'alonhasfri/voice-bubble']
const REPOS_KEY = 'repos'

const builds = atom({ plugin: 'build-pane', key: 'builds' } as const, [])
const checkedAt = atom({ plugin: 'build-pane', key: 'checkedAt' } as const, 0)

type Run = {
  run_number?: number
  name?: string
  status?: string
  conclusion?: string | null
  head_branch?: string
  display_title?: string
  html_url?: string
  run_started_at?: string
  created_at?: string
}

async function watchedRepos($: EngineInterface): Promise<string[]> {
  const saved = await $.store.get(REPOS_KEY)

  return Array.isArray(saved) ? (saved as string[]) : DEFAULT_REPOS
}

// The GitHub connector when the session has one (signed in, no rate limit
// worries), else GitHub's public API (fine for public repos).
async function latestRun($: EngineInterface, repo: string): Promise<Build> {
  const [owner = '', name = ''] = repo.split('/')
  let runs: Run[] | undefined
  let error = ''

  try {
    const result = await $.mcp.call('github', 'actions_list', {
      method: 'list_workflow_runs',
      owner,
      repo: name,
      perPage: 1,
    })
    const block = result.content.find(one => one.type === 'text') as { text?: string } | undefined

    if (!result.isError && block?.text !== undefined) {
      runs = (JSON.parse(block.text) as { workflow_runs?: Run[] }).workflow_runs
    }
  } catch {
    // No connector here: fall through to the public API.
  }

  if (runs === undefined) {
    try {
      const response = await $.http.fetch(
        `https://api.github.com/repos/${owner}/${name}/actions/runs?per_page=1`,
        { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'build-pane-mod' } },
      )

      if (response.ok) {
        runs = (JSON.parse(response.text) as { workflow_runs?: Run[] }).workflow_runs
      } else {
        error = response.status === 403 ? 'GitHub rate limit, will retry' : `GitHub said ${response.status}`
      }
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure)
    }
  }
  const run = runs?.[0]

  if (run === undefined) {
    return {
      repo, runNumber: null, workflow: '', status: 'unknown', conclusion: null, branch: '',
      title: '', url: `https://github.com/${repo}/actions`, startedAt: '',
      error: error || 'No builds yet',
    }
  }

  return {
    repo,
    runNumber: run.run_number ?? null,
    workflow: run.name ?? '',
    status: run.status ?? 'unknown',
    conclusion: run.conclusion ?? null,
    branch: run.head_branch ?? '',
    title: (run.display_title ?? '').split('\n')[0] ?? '',
    url: run.html_url ?? `https://github.com/${repo}/actions`,
    startedAt: run.run_started_at ?? run.created_at ?? '',
  }
}

async function notify($: EngineInterface, title: string, body: string): Promise<void> {
  try {
    const sent = await $.ui.notify(body, { title })

    if (sent.isSent) {
      return
    }
  } catch {
    // Fall back to the push below.
  }

  try {
    const line = `${title}: ${body}`.replace(/\s+/g, ' ')
    await $.tool.call({ tool: 'PushNotification', message: line.slice(0, 195), status: 'proactive' })
  } catch {
    $.ui.toast(`${title}: ${body}`)
  }
}

function label(build: Build): string {
  if (build.status !== 'completed') {
    return build.status === 'unknown' ? '?' : 'building'
  }

  return build.conclusion === 'success' ? 'ready' : build.conclusion ?? 'done'
}

function age(iso: string, now: number): string {
  const ms = now - Date.parse(iso)

  if (!Number.isFinite(ms)) {
    return ''
  }
  const minutes = Math.round(ms / 60000)

  if (minutes < 1) {
    return 'just now'
  }

  if (minutes < 60) {
    return `${minutes}m ago`
  }
  const hours = Math.round(minutes / 60)

  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}

const short = (repo: string) => repo.split('/').pop() ?? repo

// Module state: starts over on reload, which is fine (it re-learns from GitHub).
const watch = { lastSeen: new Map<string, string>(), hotUntil: 0, lastPoll: 0, isPolling: false }

async function refresh($: EngineInterface): Promise<void> {
  if (watch.isPolling) {
    return
  }
  watch.isPolling = true

  try {
    const repos = await watchedRepos($)
    const fresh = await Promise.all(repos.map(repo => latestRun($, repo)))

    for (const build of fresh) {
      const key = `${build.runNumber}:${build.status}:${build.conclusion}`
      const before = watch.lastSeen.get(build.repo)
      watch.lastSeen.set(build.repo, key)

      // Only tell about a change seen while watching, not the state at start.
      const isNewlyDone =
        before !== undefined && before !== key && build.status === 'completed' && build.runNumber !== null

      if (isNewlyDone && build.branch === 'main') {
        if (build.conclusion === 'success') {
          await notify($, `${short(build.repo)}: build #${build.runNumber} ready`, `New APK: https://github.com/${build.repo}/releases/latest`)
        } else {
          await notify($, `${short(build.repo)}: build #${build.runNumber} ${build.conclusion ?? 'failed'}`, build.title || build.url)
        }
      }
    }
    await update($, builds, () => fresh)
    const now = await $.clock.now()
    watch.lastPoll = now
    await update($, checkedAt, () => now)
  } finally {
    watch.isPolling = false
  }
}

// Every minute decide whether to check: each minute while a build runs or
// right after a push, else every 5 minutes (GitHub's public API allows
// 60 requests an hour without signing in).
async function tick($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const list = await read($, builds)
  const isBusy = list.some(one => one.status !== 'completed' && one.status !== 'unknown')

  if (isBusy || now < watch.hotUntil || now - watch.lastPoll >= 5 * 60_000) {
    await refresh($)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'builds',
      description: 'GitHub builds pane: refresh, add owner/repo, remove repo',
      argumentHint: '[refresh | add owner/repo | remove repo]',
    })
    watch.lastSeen = new Map()
    void refresh($)
    $.clock.every(60_000, () => void tick($))

    return next(e)
  })

  // A push starts a build: watch closely for the next 20 minutes.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)

    if (/\bgit\s+push\b/.test(e.command)) {
      watch.hotUntil = (await $.clock.now()) + 20 * 60_000
      $.clock.after(20_000, () => void refresh($))
    }

    return result
  })

  on('command.run', { command: 'builds' }, async ($, e) => {
    const [word = '', value = ''] = e.args.trim().split(/\s+/)
    const repos = await watchedRepos($)

    if (word === 'add') {
      if (!/^[\w.-]+\/[\w.-]+$/.test(value)) {
        return { text: 'Usage: /builds add owner/repo' }
      }
      await $.store.set(REPOS_KEY, [...repos.filter(one => one !== value), value])
      await refresh($)

      return { text: `Watching ${value}.` }
    }

    if (word === 'remove') {
      const left = repos.filter(one => one !== value && short(one) !== value)
      await $.store.set(REPOS_KEY, left)
      await refresh($)

      return { text: left.length === repos.length ? `Not watching ${value}.` : `Stopped watching ${value}.` }
    }

    if (word === 'refresh') {
      await refresh($)
    }
    const opened = await $.ui.open({ id: PANE, title: 'Builds' })

    return { text: opened.isPlaced ? 'Builds pane open.' : `Watching: ${repos.join(', ')}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Link, Button } = $.ui.resolve(e)
    const list = await read($, builds)
    const at = await read($, checkedAt)
    const now = Date.now()

    return (
      <Box flexDirection="column" gap={1}>
        {list.length === 0 && <Text dimColor>Checking GitHub...</Text>}
        {list.map(build => (
          <Box key={build.repo} flexDirection="column">
            <Text bold>
              {short(build.repo)}{' '}
              <Text color={build.status !== 'completed' ? 'warning' : build.conclusion === 'success' ? 'success' : 'error'}>
                {label(build)}
              </Text>
            </Text>
            {build.error !== undefined ? (
              <Text dimColor>{build.error}</Text>
            ) : (
              <Text dimColor>
                #{build.runNumber} · {build.branch} · {age(build.startedAt, now)}
              </Text>
            )}
            {build.title !== '' && <Text>{build.title.slice(0, 80)}</Text>}
            <Box gap={2}>
              <Link href={build.url}>Run</Link>
              <Link href={`https://github.com/${build.repo}/releases/latest`}>Latest APK</Link>
            </Box>
          </Box>
        ))}
        <Box gap={2}>
          <Button key="refresh" label="Refresh" onPress={() => refresh($)} />
          {at > 0 && <Text dimColor>checked {age(new Date(at).toISOString(), now)}</Text>}
        </Box>
      </Box>
    )
  })
}
