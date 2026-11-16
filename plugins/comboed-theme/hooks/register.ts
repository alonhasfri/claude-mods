import type { EngineInterface, Register, ThemeSetArgs } from 'claude-code'

import { makeColors } from './make-colors.js'

// Comboed's own palette, taken from the app (Ui.kt, themes.xml):
// the deep navy night mode and the soft blue-white day mode, with the
// signature #3A5BD9 blue and the #5A2FC7 purple of its hero gradient.
//
//   /comboed-theme        switch it on or off
//   /comboed-theme on|off set it explicitly
const { theme, problems } = makeColors({
  label: 'Comboed',
  roles: { accent: '#3A5BD9', danger: '#A8262C', success: '#17663A', warning: '#E8B500', pro: '#5A2FC7' },
  light: {
    gray: {
      anchors: {
        'surface-0': '#F4F6FB',
        'surface-1': '#FAFBFE',
        'surface-2': '#FFFFFF',
        'text-primary': '#141A2E',
        'text-secondary': '#3A4157',
        'text-muted': '#5B6378',
      },
    },
  },
  dark: {
    roles: { accent: '#A9BBFF', danger: '#FF9DA2', success: '#7FD9A6', warning: '#FFD23F', pro: '#B06BFF' },
    gray: {
      anchors: {
        'surface-0': '#0F1220',
        'surface-1': '#151A2B',
        'surface-2': '#1A1F33',
        'surface-3': '#1F2539',
        'text-primary': '#EEF1FA',
        'text-secondary': '#C3C9DA',
        'text-muted': '#A3ABC2',
      },
    },
  },
})

const LOOK: ThemeSetArgs = { colors: theme }
const KEY = 'isOn'

async function apply($: EngineInterface, isOn: boolean): Promise<string> {
  if (!isOn) {
    await $.theme.clear()

    return 'Comboed theme off: back to the normal look.'
  }
  const unpainted = problems.find(line => line.startsWith("Desktop won't paint"))

  if (unpainted !== undefined) {
    return unpainted
  }
  const set = await $.theme.set(LOOK)

  return set.isDrawn
    ? 'Comboed theme on.'
    : `Comboed theme on, but nothing here draws themes (${set.reason}). It shows in the desktop and mobile apps.`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'comboed-theme',
      description: "Switch Comboed's colors on or off",
      argumentHint: '[on|off]',
    })

    if ((await $.store.get(KEY)) !== false) {
      await apply($, true)
    }

    return next(e)
  })

  on('command.run', { command: 'comboed-theme' }, async ($, e) => {
    const word = e.args.trim().toLowerCase()
    const wasOn = (await $.store.get(KEY)) !== false

    if (word !== '' && word !== 'on' && word !== 'off') {
      return { text: 'Usage: /comboed-theme [on|off]' }
    }
    const isOn = word === '' ? !wasOn : word === 'on'
    await $.store.set(KEY, isOn)

    return { text: await apply($, isOn) }
  })
}
