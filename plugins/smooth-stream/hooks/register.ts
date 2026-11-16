import type { EngineInterface, Register, TurnStepChunk } from 'claude-code'

// The app re-measures a streaming message every time a few words arrive, and
// while you are scrolled up it corrects your scroll position each time, so the
// text jumps several times a second. This mod holds the reply's text back and
// lets it through in larger pieces, so there are far fewer jumps. What you end
// up with (and what the transcript keeps) is exactly the same text.
//
//   /smooth             show the current mode
//   /smooth paragraph   one finished paragraph at a time (default)
//   /smooth steady      a sentence or so at a time, at an even pace
//   /smooth 2s          a burst every 2 seconds
//   /smooth whole       nothing while Claude writes, then the whole reply
//   /smooth off         normal live typing

type Mode = 'paragraph' | 'steady' | '2s' | 'whole' | 'off'

const MODES: readonly Mode[] = ['paragraph', 'steady', '2s', 'whole', 'off']
const KEY = 'mode'
// A paragraph with no blank line (a long table or list) is let through by line
// once it is this long, so text never waits on one huge block.
const MAX_HELD = 1200
// Steady mode lets text through at most this often, ending on a whole sentence.
const STEADY_MS = 700

// Where the last finished sentence (or line) in the text ends, or -1.
export function lastSentenceEnd(text: string): number {
  let end = -1

  for (const match of text.matchAll(/[.!?:;]["'”’)\]*_`]*\s+|\n/g)) {
    end = match.index + match[0].length
  }

  return end
}

async function currentMode($: EngineInterface): Promise<Mode> {
  const saved = await $.store.get(KEY)

  return MODES.includes(saved as Mode) ? (saved as Mode) : 'paragraph'
}

// How much of the held text to let through now: [ready, keep].
export function release(held: string, mode: Mode, sinceLastMs: number): [string, string] {
  if (mode === 'off') {
    return [held, '']
  }

  if (mode === 'whole') {
    return ['', held]
  }

  if (mode === 'steady') {
    if (sinceLastMs < STEADY_MS) {
      return ['', held]
    }
    const end = lastSentenceEnd(held)

    if (end !== -1) {
      return [held.slice(0, end), held.slice(end)]
    }

    return held.length > MAX_HELD ? [held, ''] : ['', held]
  }

  if (mode === '2s') {
    return sinceLastMs >= 2000 ? [held, ''] : ['', held]
  }
  const paragraph = held.lastIndexOf('\n\n')

  if (paragraph !== -1) {
    return [held.slice(0, paragraph + 2), held.slice(paragraph + 2)]
  }
  const line = held.lastIndexOf('\n')

  if (held.length > MAX_HELD && line !== -1) {
    return [held.slice(0, line + 1), held.slice(line + 1)]
  }

  return ['', held]
}

function describe(mode: Mode): string {
  switch (mode) {
    case 'paragraph':
      return 'Smooth mode: paragraph. Replies appear one finished paragraph at a time.'
    case 'steady':
      return 'Smooth mode: steady. Replies appear a sentence or so at a time, at an even pace.'
    case '2s':
      return 'Smooth mode: 2s. Replies appear in a burst every 2 seconds.'
    case 'whole':
      return 'Smooth mode: whole. Nothing shows while Claude writes; then the whole reply at once.'
    case 'off':
      return 'Smooth mode: off. Replies type out live, as normal.'
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'smooth',
      description: 'Stop the jumping while a reply streams: paragraph, steady, 2s, whole, off',
      argumentHint: '[paragraph | steady | 2s | whole | off]',
      immediate: true,
    })

    return next(e)
  })

  on('command.run', { command: 'smooth' }, async ($, e) => {
    const word = e.args.trim().toLowerCase()

    if (word === '') {
      return { text: describe(await currentMode($)) }
    }

    if (!MODES.includes(word as Mode)) {
      return { text: 'Usage: /smooth [paragraph | steady | 2s | whole | off]' }
    }
    await $.store.set(KEY, word)

    return { text: describe(word as Mode) }
  })

  on('turn.step', async function* ($, e, next) {
    const stream = next(e)
    // Only the main conversation streams to the screen; subagents pass as they are.
    const mode: Mode = e.agentId === undefined ? await currentMode($) : 'off'
    let held = ''
    let heldIndex = -1
    let lastOut = Date.now()

    const out = (text: string): TurnStepChunk => {
      lastOut = Date.now()

      return { kind: 'text', index: heldIndex, text }
    }

    for await (const chunk of stream) {
      if (mode === 'off') {
        yield chunk
        continue
      }

      if (chunk.kind === 'text') {
        if (heldIndex !== -1 && chunk.index !== heldIndex && held !== '') {
          yield out(held)
          held = ''
        }
        heldIndex = chunk.index
        held += chunk.text
        const [ready, keep] = release(held, mode, Date.now() - lastOut)

        if (ready !== '') {
          held = keep
          yield out(ready)
        }
        continue
      }

      // Anything else (a tool call, thinking, the end): first let the text through, in order.
      if (held !== '') {
        yield out(held)
        held = ''
      }
      yield chunk
    }

    if (held !== '') {
      yield out(held)
    }

    return await stream.result
  })
}
