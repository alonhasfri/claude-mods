import type { EngineInterface, Register } from 'claude-code'

// combo-checker builds two editions from one codebase:
//   app/src/full/  the pranks (fake login, crashes, ads, voices, PrankActivity)
//   app/src/safe/  empty stand-ins with the same names: the public download
//   app/src/main/  shared code, in both editions
// This guard:
//   1. blocks an edit to main/ or safe/ that brings prank code in (prank.html,
//      or several lines copied from a full/ file),
//   2. blocks a commit or push while a public member of a full/ object has no
//      stand-in in safe/ (the safe edition would stop building),
//   3. shows in the status line which edition the last edit touched.
// Put EDITIONGUARD=off in a command to let one commit through anyway.

const SRC = /^(.*\/combo-android\/app\/src)\/(main|safe|full)\//

type Decl = { name: string; members: Set<string> }

// Top-level objects/classes and their public funs and vals (4-space indent).
export function declarations(source: string): Map<string, Decl> {
  const found = new Map<string, Decl>()
  let current: Decl | undefined

  for (const line of source.split('\n')) {
    const top = /^(?:internal\s+|data\s+)?(?:object|class)\s+(\w+)/.exec(line)

    if (top?.[1] !== undefined) {
      current = found.get(top[1]) ?? { name: top[1], members: new Set() }
      found.set(top[1], current)

      // A one-line object: `object Crash { fun maybeShow(a: Activity) {} }`.
      for (const inline of line.matchAll(/\b(?:fun|val|var)\s+(?:<[^>]*>\s*)?(\w+)/g)) {
        if (inline[1] !== undefined && !/private\s+(?:fun|val|var)\s+\S*$/.test(line.slice(0, inline.index + inline[0].length))) {
          current.members.add(inline[1])
        }
      }
      continue
    }
    const member = /^ {4}(?!private|internal|protected)(?:override\s+|inline\s+)?(?:fun|val|var)\s+(?:<[^>]*>\s*)?(?:\w+\.)?(\w+)/.exec(line)

    if (current !== undefined && member?.[1] !== undefined) {
      current.members.add(member[1])
    }
  }

  return found
}

async function readTree($: EngineInterface, dir: string): Promise<string> {
  const run = await $.process.run([
    'bash', '-c', 'find "$1" -type f -name "*.kt" -exec cat {} + 2>/dev/null', 'edition-guard', dir,
  ])

  return run.stdout
}

// Members of full/ objects that main/ uses but safe/ lacks.
export function missingStandIns(full: string, safe: string, main: string): string[] {
  const fullDecls = declarations(full)
  const safeDecls = declarations(safe)
  const missing: string[] = []

  for (const [name, decl] of fullDecls) {
    if (!new RegExp(`\\b${name}\\b`).test(main)) {
      continue
    }
    const stand = safeDecls.get(name)

    if (stand === undefined) {
      missing.push(`${name} (the whole object)`)
      continue
    }

    for (const member of decl.members) {
      if (!stand.members.has(member) && new RegExp(`\\b${name}\\.${member}\\b`).test(main)) {
        missing.push(`${name}.${member}`)
      }
    }
  }

  return missing
}

// Lines of new text that also appear in full/ (long, non-trivial ones only).
export function copiedLines(text: string, full: string): string[] {
  const fullLines = new Set(
    full.split('\n').map(one => one.trim()).filter(one => one.length >= 40 && !one.startsWith('import ')),
  )

  return text
    .split('\n')
    .map(one => one.trim())
    .filter(one => fullLines.has(one))
}

function editionOf(path: string): string | undefined {
  const where = SRC.exec(path)?.[2]

  return where === 'full'
    ? 'FULL edition (pranks)'
    : where === 'safe'
      ? 'SAFE edition (public)'
      : where === 'main'
        ? 'shared code (both editions)'
        : undefined
}

async function checkEdit($: EngineInterface, path: string, text: string): Promise<string | undefined> {
  const match = SRC.exec(path)

  if (match?.[1] === undefined || match[2] === 'full') {
    return undefined
  }

  if (/prank\.html/.test(text)) {
    return `edition-guard: prank.html belongs to the full edition only (app/src/full/assets). Keep it out of app/src/${match[2]}.`
  }
  const copied = copiedLines(text, await readTree($, `${match[1]}/full`))

  if (copied.length >= 3) {
    return (
      `edition-guard: this edit to app/src/${match[2]} repeats ${copied.length} lines from the full edition's prank code ` +
      `(e.g. "${copied[0]?.slice(0, 80)}"), which would put it in the public safe build. ` +
      `Prank code goes in app/src/full; safe/ keeps empty stand-ins with the same names.`
    )
  }

  return undefined
}

async function checkCommit($: EngineInterface, command: string): Promise<string | undefined> {
  const flag = /\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/.exec(command)
  const cd = /^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*(&&|;)/.exec(command)
  const dir = (flag?.[1] ?? cd?.[1] ?? '.').replace(/^["']|["']$/g, '')
  const found = await $.process.run([
    'bash', '-c', 'cd "$1" 2>/dev/null && r=$(git rev-parse --show-toplevel 2>/dev/null) && [ -d "$r/combo-android/app/src/safe" ] && echo "$r/combo-android/app/src"',
    'edition-guard', dir,
  ])
  const src = found.stdout.trim()

  if (src === '') {
    return undefined
  }
  const [full, safe, main] = await Promise.all(['full', 'safe', 'main'].map(one => readTree($, `${src}/${one}`)))
  const missing = missingStandIns(full ?? '', safe ?? '', main ?? '')

  if (missing.length === 0) {
    return undefined
  }

  return (
    `edition-guard: the safe edition would not build. Shared code uses these full-edition parts, ` +
    `but app/src/safe has no stand-in for them: ${missing.slice(0, 10).join(', ')}. ` +
    `Add a do-nothing version with the same name and signature to app/src/safe (see SafeEdition.kt), then zip and commit.`
  )
}

export const register: Register = on => {
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const problem = await checkEdit($, e.file_path, e.new_string)

    if (problem !== undefined) {
      return { deny: problem }
    }
    const where = editionOf(e.file_path)

    if (where !== undefined) {
      $.ui.status(`Editing: ${where}`)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const problem = await checkEdit($, e.file_path, e.content)

    if (problem !== undefined) {
      return { deny: problem }
    }
    const where = editionOf(e.file_path)

    if (where !== undefined) {
      $.ui.status(`Editing: ${where}`)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const isGitWrite = /\bgit\b[^|;&]*\b(commit|push)\b/.test(e.command)

    if (!isGitWrite || /\bEDITIONGUARD=off\b/.test(e.command)) {
      return next(e)
    }
    const problem = await checkCommit($, e.command)

    if (problem !== undefined) {
      $.ui.toast('edition-guard stopped a commit: the safe edition would not build')

      return { deny: problem }
    }

    return next(e)
  }).catch(($, e, next) => next(e))
}
