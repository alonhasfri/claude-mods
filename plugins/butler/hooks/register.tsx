import type { EngineInterface, Register, ThemeSetArgs } from 'claude-code'

import { makeColors } from './make-colors.js'

// butler: Claude as a calm, witty AI butler, with a suit-HUD look.
//   - The personality works everywhere, the phone app included: it is how
//     Claude writes.
//   - The look (dark HUD colors, slowly turning rings behind the chat) shows
//     only in apps that draw mod themes, such as the Claude desktop app.
//
//   /butler                 status
//   /butler on | off        the personality (off by default in every chat)
//   /butler look on | off   the HUD look (turn /comboed-theme off first)
//   /butler name Jarvis     what he calls himself
//   /butler call me boss    what he calls you (default "sir")

const { theme } = makeColors({
  label: 'Suit HUD',
  roles: { accent: '#1aa9d6', danger: '#c8322b', success: '#2f9e6a', warning: '#c98a12', pro: '#6b5bd6' },
  light: {
    gray: {
      anchors: {
        'surface-0': '#e9eef3',
        'surface-1': '#f2f6f9',
        'surface-2': '#fafcfd',
        'text-primary': '#0e1a24',
        'text-secondary': '#2c3e4d',
        'text-muted': '#4b5d6b',
      },
    },
  },
  dark: {
    roles: { accent: '#4fd8ff', danger: '#ff6b5e', success: '#5fe0a0', warning: '#ffc94d', pro: '#a99bff' },
    gray: {
      anchors: {
        'surface-0': '#05090f',
        'surface-1': '#0a121b',
        'surface-2': '#0f1823',
        'surface-3': '#131e2a',
        'text-primary': '#e8f6ff',
        'text-secondary': '#b7d3e3',
        'text-muted': '#8fb0c2',
      },
    },
  },
})

const LOOK: ThemeSetArgs = { colors: theme, backdrop: { scene: 'hud', glass: { blur: 0, tint: '#05090f', opacity: 0.55 } } }

// Original art: thin cyan rings and ticks turning slowly in the top-right
// corner, a faint grid, a gold arc. Kept away from the middle and the foot.
const SCENE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid slice">
<style>
.spin{transform-origin:0 0;animation:s 60s linear infinite}
.back{transform-origin:0 0;animation:s 90s linear infinite reverse}
.pulse{animation:p 4s ease-in-out infinite}
@keyframes s{to{transform:rotate(360deg)}}
@keyframes p{0%,100%{opacity:.35}50%{opacity:.8}}
@media (prefers-reduced-motion:reduce){.spin,.back,.pulse{animation:none}}
</style>
<rect width="1000" height="1000" fill="#05090f"/>
<g stroke="#4fd8ff" stroke-opacity=".05">
<path d="M0 100H1000M0 200H1000M0 300H1000M0 400H1000M0 500H1000M0 600H1000M0 700H1000M0 800H1000M0 900H1000"/>
<path d="M100 0V1000M200 0V1000M300 0V1000M400 0V1000M500 0V1000M600 0V1000M700 0V1000M800 0V1000M900 0V1000"/>
</g>
<svg x="0" y="0" width="1000" height="1000" viewBox="0 0 400 400" preserveAspectRatio="xMaxYMin meet">
<g transform="translate(330 70)" fill="none" stroke="#4fd8ff">
<circle r="58" stroke-opacity=".18"/>
<circle class="pulse" r="10" fill="#4fd8ff" fill-opacity=".25" stroke-opacity=".6"/>
<g class="spin"><circle r="44" stroke-opacity=".35" stroke-dasharray="6 10"/><path d="M0 -70V-62M70 0H62M0 70V62M-70 0H-62" stroke-opacity=".5"/></g>
<g class="back"><circle r="30" stroke-opacity=".4" stroke-dasharray="40 14"/></g>
<path d="M-80 0A80 80 0 0 1 0 -80" stroke="#ffc94d" stroke-opacity=".35" stroke-width="2"/>
</g>
</svg>
</svg>`

type Settings = { isOn: boolean; hasLook: boolean; name: string; title: string }

// Off in every chat until you type /butler on (in that chat).
const DEFAULTS: Settings = { isOn: false, hasLook: false, name: 'Atlas', title: 'sir' }

async function load($: EngineInterface): Promise<Settings> {
  const saved = (await $.store.get('settings')) as Partial<Settings> | undefined

  return { ...DEFAULTS, ...(saved ?? {}) }
}

async function save($: EngineInterface, settings: Settings): Promise<void> {
  await $.store.set('settings', settings)
}

function persona(settings: Settings): string {
  return [
    `# Personality: ${settings.name}`,
    `You are ${settings.name}, the person's AI butler: calm, precise, loyal and quietly witty, with a dry, polite British manner.`,
    `- Address the person as "${settings.title}" now and then (not in every sentence).`,
    '- Report on work like a suit\'s onboard system: short status lines before and after actions (e.g. "Running the build now." / "Build complete. Two warnings, nothing serious.").',
    '- Keep answers sharp and short; one dry joke at most, never at the expense of clarity.',
    '- When something is risky, say so plainly and calmly, then recommend the safer path.',
    '- The personality is a style only: never invent results, never pretend a task worked, never skip safety rules or the person\'s instructions for the sake of the act.',
    '- It is an original character: do not quote films or claim to be a character from a film, comic or company.',
  ].join('\n')
}

async function applyLook($: EngineInterface, settings: Settings): Promise<string> {
  if (!settings.hasLook) {
    return ''
  }
  const set = await $.theme.set(LOOK)

  return set.isDrawn ? 'HUD look on.' : "HUD look saved, but the app you're using doesn't draw mod themes (the Claude desktop app does)."
}

function status(settings: Settings): string {
  return [
    `${settings.name} is ${settings.isOn ? 'on' : 'off'} and calls you "${settings.title}". HUD look: ${settings.hasLook ? 'on' : 'off'}.`,
    'Change it: /butler on|off, /butler look on|off, /butler name <name>, /butler call me <title>.',
  ].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'butler',
      description: 'Your AI butler: on/off, look on/off, name <name>, call me <title>',
      argumentHint: '[on | off | look on | look off | name <name> | call me <title>]',
    })
    await applyLook($, await load($))

    return next(e)
  })

  on('command.run', { command: 'butler' }, async ($, e) => {
    const settings = await load($)
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    const [first = '', second = ''] = words.map(one => one.toLowerCase())

    if (first === 'on' || first === 'off') {
      const next = { ...settings, isOn: first === 'on' }
      await save($, next)

      return { text: `${status(next)}\nTakes effect from your next message.` }
    }

    if (first === 'look' && (second === 'on' || second === 'off')) {
      const next = { ...settings, hasLook: second === 'on' }
      await save($, next)

      if (!next.hasLook) {
        await $.theme.clear()

        return { text: 'HUD look off.' }
      }

      return { text: await applyLook($, next) }
    }

    if (first === 'name' && words.length > 1) {
      const next = { ...settings, name: words.slice(1).join(' ').slice(0, 30) }
      await save($, next)

      return { text: `From your next message he is ${next.name}.` }
    }

    if (first === 'call' && second === 'me' && words.length > 2) {
      const next = { ...settings, title: words.slice(2).join(' ').slice(0, 30) }
      await save($, next)

      return { text: `From your next message he calls you "${next.title}".` }
    }

    return { text: status(settings) }
  })

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    const settings = await load($)

    if (!settings.isOn) {
      return result
    }

    return { sections: [...result.sections, { id: 'butler:persona', text: persona(settings), scope: 'session' as const }] }
  })

  on('ui.render', { component: 'Backdrop' }, ($, e, next) => {
    if ((e.surface !== 'desktop' && e.surface !== 'mobile') || e.props.scene !== 'hud') {
      return next(e)
    }
    const { Svg } = $.ui.resolve(e)

    return <Svg source={SCENE} alt="Thin cyan HUD rings turning slowly in the corner" isInteractive />
  })
}
