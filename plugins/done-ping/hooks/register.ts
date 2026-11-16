import type { EngineInterface, Register } from 'claude-code'

// Sends a phone/desktop notification when Claude finishes a long turn, stops on
// an error, or asks you a question, titled with the app (repo) it is working on.
//
//   /notify            show the current settings
//   /notify on | off   turn notifications on or off
//   /notify after 30   only notify for turns longer than 30 seconds (0 = every reply, the default)
//   /notify test       send a test notification now
//   /notify log        what happened on the last 10 notifications
//   /notify email you@example.com   also email you (via your Gmail connector) for
//                      replies over 2 minutes, errors and questions
//   /notify email off  stop the emails
//   /notify via phone | email | both   which kind to send (both by default)

type Via = 'phone' | 'email' | 'both'
type Settings = { isOn: boolean; afterSeconds: number; email?: string; via?: Via }

// An empty email means you turned email off (it then beats DONE_PING_EMAIL).
const hasEmail = (settings: Settings): settings is Settings & { email: string } =>
  settings.email !== undefined && settings.email !== ''

// Every reply by default, like the regular Claude app.
const DEFAULTS: Settings = { isOn: true, afterSeconds: 0 }
const KEY = 'settings'
const LOG_KEY = 'log'
const THREAD_KEY = 'emailThread'
// When the push is skipped because you were looking at the session, try again
// after these delays: it lands if you have left the app by then.
const RETRY_MS = [15_000, 60_000]
// Replies shorter than this are sent after a short wait (see turn.complete).
const QUICK_MS = 30_000
const QUICK_DELAY_MS = 10_000
// Emails go out only for replies at least this long (and for errors and questions).
const EMAIL_AFTER_MS = 120_000
// While you have the session open in the app no email is sent; it looks again
// after these delays, so leaving the app soon after still gets you the email.
const AWAY_RECHECK_MS = [30_000, 120_000]

type LogEntry = { at: string; title: string; outcome: string }

async function record($: EngineInterface, title: string, outcome: string): Promise<void> {
  const saved = await $.store.get(LOG_KEY)
  const log = Array.isArray(saved) ? (saved as LogEntry[]) : []
  const at = new Date(await $.clock.now()).toISOString().slice(11, 19)
  await $.store.set(LOG_KEY, [...log, { at, title, outcome }].slice(-10))
}

function isSkipped(outcome: string): boolean {
  return /present|skip|redundant|not sent|duplicate/i.test(outcome) && !/push requested/i.test(outcome)
}

// Defaults can come from the environment, so every new session starts set up:
// DONE_PING_EMAIL (an address) and DONE_PING_VIA (phone, email or both).
// What you set with /notify in a session wins over them.
async function loadSettings($: EngineInterface): Promise<Settings> {
  const saved = (await $.store.get(KEY)) as Partial<Settings> | undefined
  const email = await $.env.get('DONE_PING_EMAIL')
  const via = await $.env.get('DONE_PING_VIA')
  const fromEnv: Partial<Settings> = {
    ...(email !== undefined && email.includes('@') ? { email } : {}),
    ...(via === 'phone' || via === 'email' || via === 'both' ? { via } : {}),
  }

  return { ...DEFAULTS, ...fromEnv, ...(saved ?? {}) }
}

async function appName($: EngineInterface): Promise<string> {
  const repo = await $.session.repo()
  const path = repo?.root ?? (await $.session.cwd())
  const name = path.split('/').filter(Boolean).pop()

  return name ?? 'Claude'
}

// The first real line of the answer, without markdown, short enough for a banner.
function summary(answer: string): string {
  const line =
    answer
      .split('\n')
      .map(one => one.replace(/[#>*_`|]/g, '').replace(/\[(.*?)\]\(.*?\)/g, '$1').trim())
      .find(one => one.length > 0 && !/^-+$/.test(one)) ?? ''

  return line.length > 180 ? `${line.slice(0, 177)}...` : line
}

// The phone push first (the Claude app's own notifications), then the
// terminal's or desktop's notification where there is no push tool.
async function deliver($: EngineInterface, title: string, body: string): Promise<string> {
  let why = ''

  try {
    const line = `${title}: ${body}`.replace(/\s+/g, ' ')
    const message = line.length > 195 ? `${line.slice(0, 192)}...` : line
    const pushed = await $.tool.call({ tool: 'PushNotification', message, status: 'proactive' })

    if (pushed.deny !== undefined) {
      why = `push refused: ${pushed.deny}`
    } else if (pushed.isError === true) {
      why = `push failed: ${(pushed.text ?? '').slice(0, 160)}`
    } else {
      return `push: ${(pushed.text ?? 'ok').slice(0, 160)}`
    }
  } catch (error) {
    why = `push unavailable: ${error instanceof Error ? error.message : String(error)}`
  }

  try {
    const sent = await $.ui.notify(body, { title })

    return sent.isSent ? `sent (${sent.channel})` : `not sent: ${why}; notify: ${sent.reason}`
  } catch (error) {
    return `not sent: ${why}; notify: ${error instanceof Error ? error.message : String(error)}`
  }
}

// Email through the session's Gmail connector, from you to you.
async function sendEmail($: EngineInterface, to: string, title: string, body: string): Promise<void> {
  let outcome: string

  // Every email goes into one conversation, so the inbox shows one thread
  // (opened once, all read) instead of a new email each time.
  const saved = await $.store.get(THREAD_KEY)
  const thread = typeof saved === 'string' ? saved : undefined

  try {
    const result = await $.mcp.call('Gmail', 'send_message', {
      to: [to],
      subject: 'Claude notifications',
      body: `${title}\n\n${body}\n\nOpen the Claude app to continue.\n\n(Sent by the done-ping mod. Stop with /notify email off.)`,
      ...(thread === undefined ? {} : { replyThreadId: thread }),
    })
    const first = result.content[0] as { text?: string } | undefined

    if (!result.isError && thread === undefined) {
      const id = /"threadId"\s*:\s*"([^"]+)"/.exec(first?.text ?? '')?.[1]

      if (id !== undefined) {
        await $.store.set(THREAD_KEY, id)
      }
    }
    outcome = result.isError ? `email failed: ${(first?.text ?? '').slice(0, 160)}` : 'email sent'
  } catch (error) {
    outcome = `email unavailable: ${error instanceof Error ? error.message : String(error)}`
  }
  await record($, `${title} (email)`, outcome)
}

// Whether the session is open in an app (phone, desktop, browser) right now.
async function isInApp($: EngineInterface): Promise<boolean> {
  const surfaces = await $.session.surfaces()

  return surfaces.some(one => one !== 'terminal')
}

// Email only when you are not looking at the session in the app.
async function emailIfAway($: EngineInterface, to: string, title: string, body: string, attempt: number): Promise<void> {
  if ((await loadSettings($)).via === 'phone') {
    return
  }
  if (!(await isInApp($))) {
    await sendEmail($, to, title, body)

    return
  }
  const delay = AWAY_RECHECK_MS[attempt]

  if (delay === undefined) {
    await record($, `${title} (email)`, 'email skipped: you had the app open the whole time')

    return
  }
  await record($, `${title} (email)`, `you're in the app: checking again in ${delay / 1000}s`)
  $.clock.after(delay, () => void emailIfAway($, to, title, body, attempt + 1))
}

async function send($: EngineInterface, title: string, body: string): Promise<string> {
  if ((await loadSettings($)).via === 'email') {
    await record($, title, 'phone notification off (/notify via email)')

    return 'phone notification off (/notify via email)'
  }
  const outcome = await deliver($, title, body)
  await record($, title, outcome)

  if (isSkipped(outcome)) {
    scheduleRetry($, title, body, 0)
  }

  return outcome
}

function scheduleRetry($: EngineInterface, title: string, body: string, attempt: number): void {
  const delay = RETRY_MS[attempt]

  if (delay === undefined) {
    return
  }
  $.clock.after(delay, () => void retry($, title, body, attempt))
}

async function retry($: EngineInterface, title: string, body: string, attempt: number): Promise<void> {
  const outcome = await deliver($, title, body)
  await record($, `${title} (retry ${attempt + 1})`, outcome)

  if (isSkipped(outcome)) {
    scheduleRetry($, title, body, attempt + 1)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'notify',
      description: 'Done notifications: on, off, after <seconds>, test, log, email, via'
    })

    return next(e)
  })

  on('command.run', { command: 'notify' }, async ($, e) => {
    const settings = await loadSettings($)
    const [word = '', value = ''] = e.args.trim().toLowerCase().split(/\s+/)

    if (word === 'on' || word === 'off') {
      const next = { ...settings, isOn: word === 'on' }
      await $.store.set(KEY, next)

      return { text: describe(next) }
    }

    if (word === 'after') {
      const seconds = Number(value)

      if (!Number.isFinite(seconds) || seconds < 0) {
        return { text: 'Usage: /notify after <seconds>, for example /notify after 30 (0 = after every reply).' }
      }
      const next = { ...settings, afterSeconds: Math.round(seconds) }
      await $.store.set(KEY, next)

      return { text: describe(next) }
    }

    if (word === 'via') {
      if (value !== 'phone' && value !== 'email' && value !== 'both') {
        return { text: `Usage: /notify via phone | email | both. Now: ${settings.via ?? 'both'}.` }
      }
      const next = { ...settings, via: value as Via }
      await $.store.set(KEY, next)
      const warn = value !== 'phone' && !hasEmail(settings) ? ' No email address set yet: /notify email you@example.com' : ''

      return { text: `${describe(next)}${warn}` }
    }

    if (word === 'email') {
      const raw = e.args.trim().split(/\s+/)[1] ?? ''

      if (raw.toLowerCase() === 'off') {
        const next = { ...settings, email: '' }
        await $.store.set(KEY, next)

        return { text: 'Email notifications off.' }
      }

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
        return { text: `Usage: /notify email you@example.com, or /notify email off.${hasEmail(settings) ? ` Now emailing ${settings.email}.` : ''}` }
      }
      const next = { ...settings, email: raw }
      await $.store.set(KEY, next)
      await $.store.delete(THREAD_KEY)

      return { text: `Emails go to ${raw} for replies over 2 minutes, errors, and question boxes that wait for your answer.` }
    }

    if (word === 'log') {
      const saved = await $.store.get(LOG_KEY)
      const log = Array.isArray(saved) ? (saved as LogEntry[]) : []

      return {
        text: log.length === 0
          ? 'No notifications tried yet.'
          : log.map(one => `${one.at} UTC  ${one.title}\n    -> ${one.outcome}`).join('\n'),
      }
    }

    if (word === 'test') {
      const title = `${await appName($)}: test`
      const outcome = await send($, title, 'Notifications from Claude are working.')

      if (hasEmail(settings) && settings.via !== 'phone') {
        await sendEmail($, settings.email, title, 'Email notifications from Claude are working.')
      }

      return { text: `Test notification ${outcome}.${hasEmail(settings) && settings.via !== 'phone' ? ` Test email sent to ${settings.email} (see /notify log).` : ''}` }
    }

    if (word !== '') {
      return { text: 'Usage: /notify [on | off | after <seconds> | test | log | email <address|off> | via phone|email|both]' }
    }

    const surfaces = await $.session.surfaces()
    const here = surfaces.filter(one => one !== 'terminal')

    return {
      text: `${describe(settings)}\nOpen in an app right now: ${here.length > 0 ? `yes (${here.join(', ')}), so emails wait until you leave` : 'no'}.`,
    }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    // Only the main conversation, not subagents; skip turns you stopped yourself.
    if (e.agentId !== undefined || e.isAborted) {
      return result
    }
    const settings = await loadSettings($)

    if (!settings.isOn) {
      await record($, 'reply finished', 'not sent: notifications are off')

      return result
    }
    const isProblem = e.reason === 'error' || e.reason === 'refusal'

    if (!isProblem && e.durationMs < settings.afterSeconds * 1000) {
      return result
    }
    const app = await appName($)
    const text = summary(e.answer)
    const asksYou = /\?\s*$/.test(e.answer.trim())
    const seconds = Math.round(e.durationMs / 1000)
    const took = seconds < 60 ? '' : ` (${Math.round(seconds / 60)} min)`

    const [title, body] = isProblem
      ? [`${app}: stopped`, text || 'Claude stopped on an error. Open the session to see why.']
      : asksYou
        ? [`${app}: needs your answer`, text || 'Claude asked you something.']
        : [`${app}: done${took}`, text || 'Claude finished.']

    // A reply that merely ends with a question is no reason to email: real
    // questions (the question box) email from the AskUserQuestion hook below.
    if (hasEmail(settings) && (isProblem || e.durationMs >= EMAIL_AFTER_MS)) {
      await emailIfAway($, settings.email, title, body, 0)
    }

    // A quick reply ends while you are probably still in the app, which hides
    // notifications for the chat on screen: wait a little so you can leave first.
    if (e.durationMs < QUICK_MS) {
      $.clock.after(QUICK_DELAY_MS, () => void send($, title, body))
      await record($, title, `waiting ${QUICK_DELAY_MS / 1000}s before sending (quick reply)`)
    } else {
      await send($, title, body)
    }

    return result
  })

  // Note when the app opens or leaves the session, so /notify log shows it.
  on('session.attach', async ($, e, next) => {
    await record($, `app opened (${e.surface})`, 'emails paused while you are here')

    return next(e)
  })

  on('session.detach', async ($, e, next) => {
    await record($, `app left (${e.surface})`, `emails resume (${e.reason})`)

    return next(e)
  })

  // A question dialog waits for you, so tell you right away.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const settings = await loadSettings($)

    if (settings.isOn && e.agentId === undefined) {
      const first = e.questions[0]?.question ?? 'Claude has a question for you.'
      const title = `${await appName($)}: needs your answer`
      await send($, title, first)

      if (hasEmail(settings)) {
        await emailIfAway($, settings.email, title, first, 0)
      }
    }

    return next(e)
  })
}

function describe(settings: Settings): string {
  const when =
    settings.afterSeconds === 0
      ? 'after every reply'
      : `when a task takes longer than ${settings.afterSeconds} seconds`

  const via = settings.via ?? 'both'
  const kinds = via === 'phone' ? ' Sending: phone notifications only.' : via === 'email' ? ' Sending: email only.' : ' Sending: phone notifications and email.'
  const mail = !hasEmail(settings) || via === 'phone' ? '' : ` Emails go to ${settings.email} for replies over 2 minutes, errors, and question boxes that wait for your answer.`

  return settings.isOn
    ? `Notifications are on: ${when}, on errors, and when Claude asks you something.${kinds}${mail}`
    : 'Notifications are off. Turn them back on with /notify on.'
}
