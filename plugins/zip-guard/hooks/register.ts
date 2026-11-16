import type { EngineInterface, Register } from 'claude-code'

// combo-checker keeps its Android code in combo-android.zip (CI unzips it).
// Before any `git commit` or `git push` in a repo that has combo-android.zip,
// this checks that:
//   1. no file in the unzipped combo-android/ folder is newer than the zip
//      (an edit that was never zipped back would be lost),
//   2. the unzipped folder itself is not staged (it would break CI's unzip),
//   3. a re-zipped combo-android.zip is staged before a plain `git commit`.
// It blocks the command and says how to fix it. Put ZIPGUARD=off in the
// command to let one through anyway.

const CHECK = String.raw`
cd "$1" 2>/dev/null || exit 0
root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$root" || exit 0
[ -f combo-android.zip ] || exit 0
echo "ROOT:$root"
git diff --cached --name-only -- combo-android/ | head -3 | sed 's/^/STAGED:/'
git diff --name-only -- combo-android.zip | sed 's/^/UNSTAGED:/'
if [ -d combo-android ]; then
  find combo-android -type f -newer combo-android.zip \
    -not -path '*/build/*' -not -path '*/.gradle/*' -not -path '*/.idea/*' \
    -not -name local.properties -not -name '*.keystore' | head -5 | sed 's/^/NEWER:/'
fi
`

const REZIP = (root: string) =>
  `cd "${root}" && rm -f combo-android.zip && zip -qr combo-android.zip combo-android ` +
  `-x 'combo-android/*/build/*' 'combo-android/build/*' 'combo-android/.gradle/*' ` +
  `'combo-android/local.properties' 'combo-android/*.keystore' 'combo-android/*/*.keystore' && git add combo-android.zip`

// Where the git command runs: `git -C <dir>`, a leading `cd <dir> &&`, or the session's folder.
function targetDir(command: string): string {
  const flag = /\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/.exec(command)
  const cd = /^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*(&&|;)/.exec(command)
  const raw = flag?.[1] ?? cd?.[1] ?? '.'

  return raw.replace(/^["']|["']$/g, '')
}

async function problems($: EngineInterface, command: string): Promise<string | undefined> {
  const run = await $.process.run(['bash', '-c', CHECK, 'zip-guard', targetDir(command)])
  const lines = run.stdout.split('\n').filter(Boolean)
  const root = lines.find(one => one.startsWith('ROOT:'))?.slice(5)

  if (root === undefined) {
    return undefined
  }
  const pick = (tag: string) => lines.filter(one => one.startsWith(tag)).map(one => one.slice(tag.length))
  const newer = pick('NEWER:')
  const staged = pick('STAGED:')
  const isCommit = /\bgit\b[^|;&]*\bcommit\b/.test(command)
  const commitsAll = /\bcommit\b[^|;&]*\s-(a|[a-z]*a[a-z]*)\b/.test(command)
  const zipUnstaged = pick('UNSTAGED:').length > 0 && isCommit && !commitsAll
  const found: string[] = []

  if (newer.length > 0) {
    found.push(
      `These files in combo-android/ were changed after combo-android.zip was made, so the change is not in the zip ` +
        `and would not reach GitHub: ${newer.join(', ')}. Re-zip first: ${REZIP(root)}`,
    )
  }

  if (staged.length > 0) {
    found.push(
      `The unzipped combo-android/ folder is staged (${staged.join(', ')}...). Only the zip belongs in the repo, ` +
        `and CI's unzip breaks if the folder is there too. Unstage it: git -C "${root}" rm -r -q --cached combo-android ` +
        `(and add combo-android/ to .gitignore).`,
    )
  }

  if (zipUnstaged && newer.length === 0) {
    found.push(`combo-android.zip changed but is not staged, so this commit would leave it out. Run: git -C "${root}" add combo-android.zip`)
  }

  return found.length > 0 ? found.join('\n\n') : undefined
}

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const isGitWrite = /\bgit\b[^|;&]*\b(commit|push)\b/.test(e.command)

    if (!isGitWrite || /\bZIPGUARD=off\b/.test(e.command)) {
      return next(e)
    }
    const found = await problems($, e.command)

    if (found === undefined) {
      return next(e)
    }
    $.ui.toast('zip-guard stopped a commit: combo-android.zip is out of date')

    return { deny: `zip-guard: ${found}` }
  }).catch(($, e, next) => {
    // A broken guard must never block work: let the command run.
    $.ui.toast('zip-guard could not check this commit; it ran unchecked')

    return next(e)
  })
}
