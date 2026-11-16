import type { EngineInterface, Register, SessionMessage } from 'claude-code'

// review: a second opinion from another Claude session.
//
//   /whoami        this session's ID, to paste into another session
//   /second-opinion ID   sends Claude's last answer (and the question it answered) to
//                  session ID, asking for the 3 biggest risks. That session
//                  sends its review back, and it arrives here as a message.
//
// Cloud sessions talk through the claude-code-remote connector's send_message
// tool; sessions on one computer fall back to the engine's own messaging.

const REMOTE = 'claude-code-remote'
const ID = /^[A-Za-z0-9_-]{6,80}$/
const MAX_ANSWER = 20_000

function firstText(result: { content: readonly unknown[] }): string {
  const block = result.content.find(one => (one as { type?: string }).type === 'text') as { text?: string } | undefined

  return block?.text ?? ''
}

// The cloud session ID (session_...) where there is one, else the local one.
async function myId($: EngineInterface): Promise<string> {
  try {
    const result = await $.mcp.call(REMOTE, 'get_session', {})
    const id = /"id"\s*:\s*"(session_[^"]+)"/.exec(firstText(result))?.[1]

    if (!result.isError && id !== undefined) {
      return id
    }
  } catch {
    // No cloud connector: a session on a computer.
  }

  return $.session.id()
}

// The last question you typed and every answer text Claude wrote after it.
export function lastExchange(messages: readonly SessionMessage[]): { question: string; answer: string } {
  let start = -1

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const one = messages[i]

    if (one !== undefined && one.role === 'user' && one.text.trim() !== '' && (one.toolResults ?? []).length === 0) {
      start = i
      break
    }
  }
  const answer = messages
    .slice(start + 1)
    .filter(one => one.role === 'assistant' && one.text.trim() !== '')
    .map(one => one.text.trim())
    .join('\n\n')

  return { question: start === -1 ? '' : messages[start]?.text.trim() ?? '', answer }
}

function request(from: string, question: string, answer: string): string {
  const cut = answer.length > MAX_ANSWER ? `${answer.slice(0, MAX_ANSWER)}\n[... cut ...]` : answer

  return [
    `[Sent automatically by the second-opinion mod from session ${from}, after the person typed /second-opinion there. Not typed in this chat.]`,
    '',
    `Another Claude session of mine (${from}) asks you for a review.`,
    'Read the question and the answer below and name the 3 biggest risks in the answer: what could be wrong,',
    'break, be unsafe or be missing. Most serious first, each in 2-3 sentences, with what to do about it.',
    'Only review: do not change files, run commands or push anything for this.',
    `When you are done, send the review back with your send_message tool to session ${from},`,
    'starting the message with "REVIEW:".',
    '',
    '--- Question ---',
    question || '(not available)',
    '',
    '--- Answer to review ---',
    cut,
  ].join('\n')
}

async function deliver($: EngineInterface, to: string, text: string): Promise<string> {
  try {
    const result = await $.mcp.call(REMOTE, 'send_message', { session_id: to, message: text })

    if (!result.isError) {
      return ''
    }
    const why = firstText(result).slice(0, 200)

    if (!/not (found|available)|unknown tool/i.test(why)) {
      return why || 'the cloud refused the message'
    }
  } catch {
    // No cloud connector: try the engine's own messaging.
  }
  const sent = await $.session.send({ to: { sessionId: to }, text })

  return sent.isDelivered ? '' : sent.reason
}

const REVIEWER_KEY = 'reviewer'

// '' when the reviewer chat is there to answer, else why not ("was archived").
// Where there is no cloud connector to ask, it is assumed to be there.
async function reviewerGone($: EngineInterface, to: string): Promise<string> {
  if (!to.startsWith('session_')) {
    return ''
  }

  try {
    const result = await $.mcp.call(REMOTE, 'get_session', { session_id: to })
    const text = firstText(result)

    if (result.isError) {
      return /not.?found|no such|unknown|404/i.test(text) ? 'no longer exists' : ''
    }

    return /ARCHIVED|DELETED|EXPIRED/i.test(/"session_status"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? '')
      ? 'was closed (archived)'
      : ''
  } catch {
    return ''
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'whoami', description: "Show this session's ID for /second-opinion" })
    await $.command.register({
      name: 'second-opinion',
      description: "Ask another session for the 3 biggest risks in Claude's last answer",
      argumentHint: '[session ID]',
    })

    return next(e)
  })

  on('command.run', { command: 'whoami' }, async $ => ({
    text: `This session's ID: ${await myId($)}\nIn another session, type /second-opinion followed by this ID to have this session review that one's answers.`,
  }))

  on('command.run', { command: 'second-opinion' }, async ($, e) => {
    const arg = e.args.trim()

    if (arg.toLowerCase() === 'reset') {
      await $.store.delete(REVIEWER_KEY)

      return { text: 'Forgot the remembered reviewer chat. Next time, give an ID: /second-opinion <session ID>.' }
    }
    // With no ID, the reviewer you used last time.
    const saved = await $.store.get(REVIEWER_KEY)
    const to = arg || (typeof saved === 'string' ? saved : '')

    if (!ID.test(to)) {
      return { text: 'Usage: /second-opinion <session ID>. Get the ID with /whoami in the session that should do the review. After the first time, /second-opinion alone reuses it.' }
    }
    const me = await myId($)

    if (to === me) {
      return { text: 'That is this session. Use the ID of another session (run /whoami there).' }
    }
    const { question, answer } = lastExchange(await $.session.messages())

    if (answer === '') {
      return { text: 'There is no answer from Claude to review yet.' }
    }
    const gone = await reviewerGone($, to)

    if (gone !== '') {
      if (arg === '') {
        await $.store.delete(REVIEWER_KEY)
      }

      return { text: `The reviewer chat ${to} ${gone}. Open a new chat, type /whoami there, then here type /second-opinion with the new ID.` }
    }
    const problem = await deliver($, to, request(me, question, answer))

    if (problem !== '') {
      return { text: `Could not send it to ${to}: ${problem}` }
    }
    await $.store.set(REVIEWER_KEY, to)

    return {
      text: `Sent Claude's last answer to ${to} for review. The 3 biggest risks will arrive here as a message when that session is done.\n` +
        `That chat is remembered, so next time /second-opinion alone is enough (/second-opinion reset forgets it).`,
    }
  })
}
