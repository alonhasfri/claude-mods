# Claude Code mods

Mods (Claude Code plugins) for working on my apps with Claude. Install any of them in a session and
they keep working in every session after.

| Mod | What it does | Commands |
| --- | --- | --- |
| **done-ping** | Sends a notification to your phone/desktop when Claude finishes a reply (every reply by default), stops on an error, or asks you a question. The title names the app (repo) the session works on, e.g. `voice-bubble: done (4 min)`. Quick replies are sent 10 s after they finish, so you have time to leave the app (it hides notifications for the chat on screen). | `/notify` (status), `/notify on`, `/notify off`, `/notify after 30` (only replies longer than 30 s; `0` = every reply, the default), `/notify test`, `/notify log` (last 10 attempts), `/notify email you@example.com` (also email via the Gmail connector for replies over 2 min, errors and question boxes, all in one "Claude notifications" thread; skipped while an app reports the session open), `/notify email off`, `/notify via phone\|email\|both` (which kind to send) |
| **comboed-theme** | Comboed's colors (navy night mode, blue-white day mode, the #3A5BD9 blue) for Claude apps that draw mod themes (the desktop app; the Android app does not yet). On by default once installed. | `/comboed-theme` (switch on/off), `/comboed-theme on`, `/comboed-theme off` |
| **build-pane** | A side pane with the latest GitHub Actions build of combo-checker and voice-bubble (building / ready / failed, run link, latest APK link). Sends a notification when a build on `main` finishes. Checks every minute while a build runs or after a `git push`, else every 5 minutes. | `/builds` (open the pane), `/builds refresh`, `/builds add owner/repo`, `/builds remove repo` |
| **zip-guard** | For combo-checker: blocks a `git commit` or `git push` when files in the unzipped `combo-android/` folder are newer than `combo-android.zip`, when the unzipped folder is staged, or when a re-zipped zip is not staged, and says how to fix it. `ZIPGUARD=off` in a command lets it through. | none |
| **edition-guard** | For combo-checker's two editions: blocks an edit that puts prank code (prank.html, or 3+ lines copied from `app/src/full`) into `app/src/main` or `app/src/safe`; blocks a commit or push while shared code uses a full-edition member that has no do-nothing stand-in in `app/src/safe` (the public build would break); shows which edition the last edit touched in the status line. `EDITIONGUARD=off` in a command lets it through. | none |
| **smooth-stream** | Stops the screen jumping while a reply streams in the app: holds Claude's text back and lets it through a paragraph at a time (default), a sentence or so at an even pace (steady), in 2-second bursts, or all at once. The final text is identical. | `/smooth` (status), `/smooth paragraph`, `/smooth steady`, `/smooth 2s`, `/smooth whole`, `/smooth off` |
| **quick** | Each message is sorted easy/hard by a tiny Haiku call: easy ones run on Haiku, hard ones on your usual model. `quick:` forces Haiku, `full:` forces your usual model. Haiku turns are read-only (an edit hands the turn to your usual model), and Haiku is skipped in chats over 40k tokens. Explore subagents run on Haiku. Each Haiku answer ends with `⚡ Haiku · N today`. | `/quick` (count), `/quick auto on`, `/quick auto off` |
| **review** | A second opinion from another of your Claude sessions. `/second-opinion ID` sends Claude's last answer (and your question) to that session, asking for the 3 biggest risks; the reviewer sends the review back and it arrives as a message. Uses the cloud connector's `send_message`, or the engine's messaging between sessions on one computer. | `/whoami` (this session's ID), `/second-opinion <ID>` (then `/second-opinion` alone reuses that reviewer; it checks the chat still exists first; `/second-opinion reset` forgets it) (`/review` is Claude Code's own code-review command) |
| **prompt-booster** | (Also shared on its own: [alonhasfri/prompt-booster](https://github.com/alonhasfri/prompt-booster).) Keeps the prompt booster on: every message is rewritten into a clearer prompt (shown as a small note) and the rewrite is answered, only for messages you type (never other sessions, scheduled tasks or commands), keeping your meaning, in every session. `boost off`, `hide boost`, `raw:` still work. | none |
| **butler** | Claude becomes a calm, witty AI butler (an original character) who calls you "sir" and reports on his work like a suit's onboard system. Optional suit-HUD look: dark colors with cyan and gold and slowly turning rings behind the chat (only in apps that draw mod themes). | `/butler`, `/butler on\|off`, `/butler look on\|off`, `/butler name <name>`, `/butler call me <title>` |

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install done-ping --marketplace alonhasfri/empty-repo-1
/plugin install comboed-theme --marketplace alonhasfri/empty-repo-1
```

Answer `y` to add the marketplace, then press Enter to pick the user scope.

From a shell:

```
claude plugin install done-ping --marketplace alonhasfri/empty-repo-1
claude plugin install comboed-theme --marketplace alonhasfri/empty-repo-1
```

In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with
`alonhasfri/empty-repo-1`, then **Add plugin**.

This repository is public, so installing needs no GitHub login.

## Cloud sessions

`/plugin` doesn't run in the Claude mobile app. The cloud environment's setup script clones this
repository and installs every mod, so each new cloud session starts with them. done-ping reads
`DONE_PING_EMAIL` and `DONE_PING_VIA` from the environment as its defaults.

## Layout

```
.claude-plugin/marketplace.json   lists the mods
plugins/<mod>/                    one folder per mod
  .claude-plugin/plugin.json
  hooks/hooks.json
  hooks/register.ts               the mod's code
```

Licensed MIT.
