import type { EngineInterface, Register } from 'claude-code'

// quick: cheap, fast answers on Haiku without changing your usual model.
//   - A message that starts with "quick:" runs on Haiku (the prefix is removed
//     before Claude sees it). Every other message keeps your usual model.
//   - Explore subagents always run on Haiku.
//   - The status line under the prompt shows how many Haiku runs today.
//
//   /quick   show today's count

const HAIKU = 'haiku'
const PREFIX = /^\s*quick:\s*/i
// "Today" in your time zone (Israel), falling back to UTC where the
// environment has no time zone data.
const TIME_ZONE = 'Asia/Jerusalem'

function today(now: number): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date(now))
  } catch {
    return new Date(now).toISOString().slice(0, 10)
  }
}

async function todayCount($: EngineInterface): Promise<number> {
  const saved = await $.store.get(`count:${today(await $.clock.now())}`)

  return typeof saved === 'number' ? saved : 0
}

async function showCount($: EngineInterface): Promise<void> {
  $.ui.status(`Haiku today: ${await todayCount($)}`)
}

async function countOne($: EngineInterface): Promise<void> {
  const key = `count:${today(await $.clock.now())}`
  const saved = await $.store.get(key)
  await $.store.set(key, (typeof saved === 'number' ? saved : 0) + 1)
  await showCount($)
}

// Module state: which of your turns run on Haiku. A reload mid-turn forgets
// it, and that turn finishes on your usual model.
const quick = { isNext: false, turns: new Set<string>() }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'quick', description: "Show today's Haiku count" })
    await showCount($)

    return next(e)
  })

  on('command.run', { command: 'quick' }, async $ => {
    await showCount($)

    return {
      text: `Haiku today: ${await todayCount($)}. Start a message with "quick:" to run it on Haiku; Explore subagents always do.`,
    }
  })

  // "quick: what does X do?" → Claude reads "what does X do?", on Haiku.
  on('prompt.submit', ($, e, next) => {
    if (e.command !== undefined || !PREFIX.test(e.text)) {
      return next(e)
    }
    quick.isNext = true

    return next({ ...e, text: e.text.replace(PREFIX, '') })
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && quick.isNext) {
      quick.isNext = false
      quick.turns.add(e.turnId)
      await countOne($)
    }

    return next(e)
  })

  // Every model request of a quick turn (its tool steps too) goes to Haiku.
  on('turn.step', async function* ($, e, next) {
    const isQuick = e.agentId === undefined && quick.turns.has(e.turnId)

    return yield* next(isQuick ? { ...e, model: HAIKU } : e)
  })

  on('turn.complete', ($, e, next) => {
    quick.turns.delete(e.turnId)

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    if (e.subagentType !== 'Explore') {
      return next(e)
    }
    await countOne($)

    return next({ ...e, model: HAIKU })
  })
}
