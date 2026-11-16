import type { Register } from 'claude-code'

// Prompt booster, always on: a standing instruction in the system prompt, so it
// survives long chats and summaries and starts in every new session, instead
// of applying only to the one message where /prompt-booster was typed.

const BOOST = [
  '# Prompt booster (always on)',
  'The person wants the prompt-booster on for every message, in every session.',
  'If the anthropic-skills:prompt-booster skill is available and its instructions are not in this conversation yet, load it with the Skill tool once and follow it; these rules are its summary.',
  'For each message from the person:',
  '1. Short, simple message (about one sentence): rewrite it lightly, a little clearer and a little longer, same meaning and language. Longer or multi-part message: rewrite it as a full prompt with the goal, context they already gave, the parts separated, and what a good answer looks like. Never add tasks or scope.',
  '2. Start the reply with the rewrite as one small note: > *Boosted prompt: <rewrite>*',
  '3. Answer the rewritten prompt.',
  'Skip the rewrite and the note for greetings, thanks, one-word confirmations, a reply to a question you just asked, and messages starting with "raw:".',
  'Controls the person may type: "boost off" / "boost on" (stop or resume), "hide boost" (keep rewriting, start replies with a lone ✦ instead of the note) / "show boost", "boost only" (show the rewrite, do not answer). Their latest control wins until they change it.',
].join('\n')

export const register: Register = on => {
  on('prompt.compose', async ($, e, next) => {
    const { sections } = await next(e)

    return { sections: [...sections, { id: 'always-boost:rules', text: BOOST, scope: 'session' as const }] }
  })
}
