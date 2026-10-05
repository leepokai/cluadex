# skyhook

Codex computer use inside Claude Code, on macOS.

Sky is the computer-use engine inside the ChatGPT desktop app. skyhook hooks Claude Code onto it.

The ChatGPT desktop app ships a computer-use MCP server. This plugin starts that server, unchanged, and gives Claude Code its two tools (`js`, `js_reset`). It adds only what a host other than Codex lacks:

- **Approval panel.** The first time the agent touches an app, a Liquid Glass panel asks "Allow computer use to control …?". Only the person at the Mac can answer; the model cannot see or press it.
- **Turn cleanup.** Hooks tell the runtime when a turn ends.
- **Host guard.** The app hosting the agent (Claude, your terminal) is never approved, so the agent cannot click its own permission prompts.

It contains no computer-use logic and no OpenAI files. This is an unofficial project, not affiliated with OpenAI or Anthropic.

## Requirements

- Apple Silicon Mac with the [ChatGPT desktop app](https://chatgpt.com/download/) at `/Applications/ChatGPT.app`, with Computer Use already working in Codex (Accessibility and Screen Recording granted).
- Claude Code.
- macOS 26 or newer for the Liquid Glass panel. Older systems get a plain list dialog instead.

There is nothing else to install. The relay runs on the Node bundled inside the ChatGPT app.

## Install

```sh
claude plugin marketplace add leepokai/claude-plugin-skyhook
claude plugin install skyhook@claude-plugin-skyhook
```

Then ask for something in a desktop app, for example "use computer use to read the Calculator window".

An installed plugin loads in every session, and each session holds 3 processes (about 120 MB) while idle and 7 (about 320 MB) once computer use has run. To load it only when you want it, clone the repo and pass it per session instead:

```sh
git clone https://github.com/leepokai/claude-plugin-skyhook
claude --plugin-dir ./claude-plugin-skyhook
```

## Approvals

The choices and their meaning are OpenAI's. Every one of them covers only the app being asked about.

| Choice | Effect |
| --- | --- |
| Allow this conversation | That app, until this Claude Code session ends. |
| Always allow | That app, permanently. Remembered by OpenAI's runtime, so the Codex app stops asking too. |
| Deny | Also what happens when nobody answers within 120 seconds. |

A different app always gets its own question. When the runtime offers no conversation scope, the first choice becomes "Allow once". Apps the runtime marks high risk, such as browsers, show its warning.

The panel does not take the keyboard, so nothing you are typing can answer it. Only a click approves.

"Always allow" is stored in `~/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/Library/Application Support/Software/ComputerUseAppApprovals.json`. Remove a line there to take an approval back.

| Environment variable | Effect |
| --- | --- |
| `SKYHOOK_APPROVAL=deny` | Decline every request without a prompt, for unattended runs. There is no setting that approves automatically. |
| `SKYHOOK_PLAIN_PROMPT=1` | Use the plain list dialog instead of the panel. |
| `SKYHOOK_APP=/path/to/ChatGPT.app` | Use an app outside `/Applications` (also change the Node path in `.mcp.json`). |

## The approval panel binary

`bin/approve-ui` is built from `ui/ApprovalPanel.swift` and committed so the plugin works without Xcode. It only draws the panel and prints the choice; `relay.mjs` decides what that means. To build it yourself:

```sh
./build.sh
```

## Checks

```sh
NODE=/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node
$NODE relay.mjs --selftest   # approval and guard logic, no desktop needed
$NODE relay.mjs --check      # starts the real runtime and lists apps
```

Run `--check` after the ChatGPT app updates. This plugin depends on the app's internal layout, which OpenAI can change in any release.

## How it works

```
Claude Code ── MCP ── relay.mjs ── MCP ── cua-repl (OpenAI) ── Sky helper (OpenAI) ── your apps
                         ▲
        hooks/turn-end.sh (Stop, UserPromptSubmit) via a local socket
```

`relay.mjs` verifies that the app's Node, `node_repl` and helper are signed by OpenAI, starts the app's own launcher, and forwards MCP messages. It hides the two host-only tools, answers the runtime's approval requests by showing the panel, and stamps each call with a turn id. The hooks reach the relay through `~/Library/Caches/skyhook/<claude pid>.sock`, which accepts one message: the turn is over.

## Limits

- Tested on one machine: ChatGPT app 26.924.22138, Claude Code 2.1.289, macOS 27 on Apple Silicon.
- Native apps only. The Chrome surface is not enabled.
- A turn interrupted with Esc is cleaned up at the next prompt, not at once.
- Subagent calls share the parent turn.
- The host guard matches bundle ids, names and paths by spelling.
- The runtime waited 45 seconds for an approval answer in testing; the full 120 seconds is untested.
- The plain list dialog has been shown and timed out in testing, but never answered. Esc-to-deny on the panel is written but untested.

## Remove

```sh
claude plugin uninstall skyhook@claude-plugin-skyhook
claude plugin marketplace remove claude-plugin-skyhook
rm -rf ~/Library/Caches/skyhook
```

To also forget approvals, edit the "Always allow" file above.

## Credit

The approach of reusing the installed runtime, and the host-guard idea, come from [LCU](https://github.com/amontlabs/lcu). The runtime itself belongs to OpenAI and stays under its terms.
