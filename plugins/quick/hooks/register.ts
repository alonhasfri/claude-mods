import type { EngineInterface, Register } from 'claude-code'

// quick: easy messages run on Haiku, hard ones on your usual model.
//
//   - Auto (on by default): every message is sorted into easy or hard by a
//     tiny Haiku call. Easy (greetings, short questions, explanations) runs on
//     Haiku; hard (code changes, debugging, building, planning) keeps your model.
//   - "quick: ..." always runs on Haiku; "full: ..." always on your usual model.
//     The prefix is removed before Claude sees the message.
//   - Explore subagents always run on Haiku.
//   - Haiku is read-only: if a Haiku turn tries to edit a file or run a command
//     that changes something, the rest of that turn is handed to your usual model.
//   - In a long chat (over 100k tokens) Haiku is skipped: re-reading the whole
//     chat without the cache would cost more than your usual model.
//   - Under each Haiku answer: "⚡ Haiku · N today". The status line shows the
//     day's runs and tokens for this chat.
//
//   /quick            today's count and the auto setting
//   /quick auto on|off

const HAIKU = 'haiku'
const QUICK = /^\s*quick:\s*/i
const FULL = /^\s*full:\s*/i
const TIME_ZONE = 'Asia/Jerusalem'
// Above this many tokens in the chat, Haiku costs more than it saves. A new
// chat already holds 30-50k tokens of built-in instructions and tools, so the
// limit sits well above that.
const MAX_CONTEXT_TOKENS = 100_000
// Messages longer than this are treated as hard without asking.
const LONG_MESSAGE = 600
// Commands a Haiku turn may run; anything else hands the turn over.
const READ_ONLY = /^\s*(ls|cat|head|tail|grep|rg|find|wc|pwd|echo|file|stat|tree|du|which|git\s+(status|log|diff|show|branch|remote)|node\s+-v|npm\s+(ls|view))\b[^;&|<>]*$/

type Choice = { isHaiku: boolean; why: string; isForced: boolean }
type Turn = { isForced: boolean; handedOver: boolean }

const state = {
  next: undefined as Choice | undefined,
  turns: new Map<string, Turn>(),
  notes: new Map<string, string>(),
  mainTurn: '',
}

function today(now: number): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date(now))
  } catch {
    return new Date(now).toISOString().slice(0, 10)
  }
}

type Day = { runs: number; tokens: number }

async function readDay($: EngineInterface): Promise<Day> {
  const saved = await $.store.get(`day:${today(await $.clock.now())}`)
  const day = saved as Partial<Day> | undefined

  return { runs: day?.runs ?? 0, tokens: day?.tokens ?? 0 }
}

async function addToDay($: EngineInterface, runs: number, tokens: number): Promise<Day> {
  const day = await readDay($)
  const next = { runs: day.runs + runs, tokens: day.tokens + tokens }
  await $.store.set(`day:${today(await $.clock.now())}`, next)
  $.ui.status(statusLine(next))

  return next
}

const kilo = (n: number) => (n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`)

function statusLine(day: Day): string {
  return `Haiku today: ${day.runs} runs · ${kilo(day.tokens)} tokens (this chat)`
}

async function isAuto($: EngineInterface): Promise<boolean> {
  return (await $.store.get('auto')) !== false
}

async function choose($: EngineInterface, text: string): Promise<Choice> {
  if (text.length > LONG_MESSAGE) {
    return { isHaiku: false, why: 'long message', isForced: false }
  }

  try {
    const label = await $.model.classify(
      'Sort a message sent to a coding assistant. "easy": a greeting, small talk, a thank-you, ' +
        'or a short question or explanation that needs no code changes and no multi-step work. ' +
        '"hard": anything that changes code or files, debugs, builds, deploys, plans, reviews, ' +
        'researches, or needs several steps or careful reasoning. When unsure, "hard".\n\n' +
        `Message:\n${text}`,
      ['easy', 'hard'],
      { model: HAIKU },
    )

    return label === 'easy'
      ? { isHaiku: true, why: 'looked easy', isForced: false }
      : { isHaiku: false, why: 'looked hard', isForced: false }
  } catch {
    return { isHaiku: false, why: 'could not sort it', isForced: false }
  }
}

async function contextTokens($: EngineInterface): Promise<number> {
  try {
    return (await $.session.usage()).context.tokens ?? 0
  } catch {
    return 0
  }
}

function handOver(turn: Turn): string {
  turn.handedOver = true

  return 'quick: this needs changes, so the rest of this reply moves from Haiku to your usual model. Do this step again.'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'quick',
      description: "Haiku for easy messages: today's count, auto on/off",
      argumentHint: '[auto on | auto off]',
    })
    $.ui.status(statusLine(await readDay($)))

    return next(e)
  })

  on('command.run', { command: 'quick' }, async ($, e) => {
    const [word = '', value = ''] = e.args.trim().toLowerCase().split(/\s+/)

    if (word === 'auto' && (value === 'on' || value === 'off')) {
      await $.store.set('auto', value === 'on')
    } else if (word !== '') {
      return { text: 'Usage: /quick, /quick auto on, /quick auto off' }
    }
    const day = await readDay($)
    const auto = (await isAuto($))
      ? 'Auto is on: easy messages go to Haiku, hard ones to your usual model.'
      : 'Auto is off: only messages starting with "quick:" go to Haiku.'

    return { text: `${statusLine(day)}.\n${auto}\n"quick: ..." forces Haiku, "full: ..." forces your usual model.` }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command !== undefined || e.isMeta === true) {
      return next(e)
    }

    if (QUICK.test(e.text)) {
      state.next = { isHaiku: true, why: 'quick:', isForced: true }

      return next({ ...e, text: e.text.replace(QUICK, '') })
    }

    if (FULL.test(e.text)) {
      state.next = { isHaiku: false, why: 'full:', isForced: true }

      return next({ ...e, text: e.text.replace(FULL, '') })
    }
    state.next = (await isAuto($)) ? await choose($, e.text) : undefined

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) {
      return next(e)
    }
    state.mainTurn = e.turnId
    const choice = state.next
    state.next = undefined

    if (choice?.isHaiku === true) {
      const tokens = await contextTokens($)

      if (tokens > MAX_CONTEXT_TOKENS) {
        state.notes.set(e.turnId, `⚡ Haiku skipped: this chat is long (${kilo(tokens)} tokens), so your usual model was cheaper. Start a new chat for quick questions.`)
      } else {
        state.turns.set(e.turnId, { isForced: choice.isForced, handedOver: false })
      }
    }

    return next(e)
  })

  // Every model request of a Haiku turn goes to Haiku, until it is handed over.
  on('turn.step', async function* ($, e, next) {
    const turn = e.agentId === undefined ? state.turns.get(e.turnId) : undefined
    const isHaiku = turn !== undefined && !turn.handedOver

    return yield* next(isHaiku ? { ...e, model: HAIKU } : e)
  })

  // Haiku is read-only: an edit or a changing command hands the turn over.
  on('tool.call', async ($, e, next) => {
    const turn = e.agentId === undefined ? state.turns.get(state.mainTurn) : undefined

    if (turn === undefined || turn.handedOver) {
      return next(e)
    }

    if (e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit') {
      return { deny: handOver(turn) }
    }

    if (e.tool === 'Bash' && !READ_ONLY.test(e.command)) {
      return { deny: handOver(turn) }
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const turn = state.turns.get(e.turnId)
    const skipped = state.notes.get(e.turnId)
    state.turns.delete(e.turnId)
    state.notes.delete(e.turnId)

    if (skipped !== undefined) {
      return { ...result, text: skipped }
    }

    if (turn === undefined) {
      return result
    }
    const usage = e.usage
    const tokens = usage === undefined ? 0 : usage.input_tokens + usage.output_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
    const day = await addToDay($, 1, tokens)
    const note = turn.handedOver
      ? `⚡ Started on Haiku, finished on your usual model (it needed changes) · ${day.runs} today`
      : `⚡ Haiku · ${day.runs} today`

    return { ...result, text: note }
  })

  on('agent.spawn', async ($, e, next) => {
    if (e.subagentType !== 'Explore') {
      return next(e)
    }
    await addToDay($, 1, 0)

    return next({ ...e, model: HAIKU })
  })
}
