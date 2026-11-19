import type { Register } from 'claude-code'

// Mods work around Claude, so a chat doesn't know they are installed unless
// told. This adds a short guide to the system prompt: what each mod does and
// its commands. Kept short so it costs little in every message.

const GUIDE = [
  '# The person\'s Claude Code mods (installed in this session)',
  'These plugins load automatically in every new cloud session (setup script, from github.com/alonhasfri/empty-repo-1). They run around you, so you do not see them working; `claude plugin list` shows them. Commands are typed by the person, lowercase.',
  '- prompt-booster: rewrites each typed message into a clearer prompt shown as a note (boost off/on, hide boost, raw:, boost only).',
  '- quick: easy messages run on Haiku, hard ones on the usual model; "quick:" forces Haiku, "full:" forces the usual model; /quick shows the count, /quick auto on|off. Skipped in chats over 100k tokens.',
  '- done-ping: notifications when a reply finishes; email via Gmail (/notify, /notify via phone|email|both, /notify email <address>|off, /notify test, /notify log).',
  '- review: /whoami shows this chat\'s ID; /second-opinion <ID> asks another chat for the 3 biggest risks in your last answer (/second-opinion reset).',
  '- butler: an AI-butler personality, off by default (/butler on|off, /butler name <name>, /butler call me <title>, /butler look on|off).',
  '- smooth-stream: shows replies a paragraph at a time to stop screen jumps (/smooth paragraph|steady|2s|whole|off).',
  '- comboed-theme (/comboed-theme): Comboed colors, only in apps that draw themes (not the Android app).',
  '- build-pane (/builds): GitHub build status pane and a notification when an APK is ready.',
  '- zip-guard and edition-guard: automatic checks before commits in combo-checker (combo-android.zip up to date; prank code stays in the full edition).',
  'The private repo alonhasfri/shared-project has the same mods and memory/from-chats/ with summaries of the person\'s projects.',
  '',
  '# About the person',
  '- Uses Claude Code only on an Android phone, in cloud sessions; no computer. Give phone steps (a browser with "Desktop site" on if a website needs it).',
  '- Often voice-types, so words can come out wrong (e.g. "doesn\'t work" meant as "does it work"). If a message seems odd, consider a mis-heard word first.',
  '- Not very technical: plain, simple words, short and clear, no code talk unless asked.',
  '- Weekly credits often run low: avoid long or costly work in long chats, suggest a new chat for new tasks, never use credits in the background.',
  '- Slash commands must be lowercase; the phone keyboard sometimes capitalizes them.',
  '- Wants to be told honestly when something won\'t work, and why.',
  '- Keep answers to what was asked; don\'t add extra tasks without asking.',
].join('\n')

export const register: Register = on => {
  on('prompt.compose', async ($, e, next) => {
    const { sections } = await next(e)

    return { sections: [...sections, { id: 'my-mods:guide', text: GUIDE, scope: 'session' as const }] }
  })
}
