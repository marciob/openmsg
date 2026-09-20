# How agents from different vendors can send messages to each other

Research date: 2026-09-19. Scope: coding agents that run in a terminal on one computer, with a path to more than one computer later.

Method:

1. Three research passes on the web. Each claim has a source in the "Sources" section.
2. Local tests on this Mac (macOS, Darwin 25). The installed versions are Claude Code 2.1.277, Codex CLI 0.154.0, OpenCode 1.1.11, and Cursor CLI 2026.04.17. Gemini CLI is not installed.

Labels in this document:

- **[local]**: we verified the fact on this Mac.
- **[docs]**: the official documentation of the vendor gives the fact.
- **[not verified]**: a source states the fact, but we did not do a test.

## 1. Answer

1. Typing into another terminal is possible, but it is not a good base for the protocol. It is slow, it breaks often, and it cannot reliably read the reply. Use it only as a fallback for agents that have no other entry point.
2. Each of the four main agents has an official way to receive a message while it runs. Claude Code, Codex, and OpenCode can receive a message at any time. Gemini CLI and Cursor CLI can receive a message only at the end of a turn, through a hook.
3. The best design is a small local tool with one adapter for each agent. The sender uses one command. The adapter delivers the message through the native entry point of the target agent.
4. Do not read replies from the screen. The receiving agent sends its reply as a new message, with the same tool.
5. Use the message format of the A2A standard. Then the same messages can go to other computers later over A2A on HTTP.
6. Two open-source projects already do a part of this work: agmsg (1,505 stars) and MCP Agent Mail (2,149 stars). Section 7 describes the gap that remains.

## 2. The four parts of the problem

Communication between agents has four parts:

| Part | Question | Difficulty |
|---|---|---|
| Discover | Which agents run now, and how do I reach each one? | Medium. Each vendor keeps its own list. |
| Send | How does agent A give a message to the system? | Low. Every agent can run a shell command or an MCP tool. |
| Deliver | How does the message get into the running session of agent B? | **High.** This is the real problem. |
| Reply | How does agent A know that agent B answered, and what the answer is? | High, if you read the screen. Low, if B sends the reply as a message. |

Most existing projects solve "Send" well and "Deliver" badly. The research below is mostly about "Deliver".

## 3. Option A: type into the terminal of the other agent

This is the first idea for the project. A program finds the open terminals and types the message into the terminal of the target agent.

### 3.1 Mechanisms

| Mechanism | Can type text | Can read the screen | Limit |
|---|---|---|---|
| tmux (`send-keys`, `capture-pane`) | Yes | Yes | The agent must start inside tmux. tmux is not installed on this Mac [local]. |
| Zellij, kitty, WezTerm | Yes | Yes | The agent must start inside that program. kitty turns off remote control by default. |
| iTerm2 (Python API, AppleScript) | Yes | Yes | You must turn on the API. macOS asks the user for Automation permission. |
| Terminal.app (AppleScript `do script`) | Yes | Yes | macOS asks the user for Automation permission. |
| Ghostty 1.3 (AppleScript) | Yes | **No** | The API is a preview. Version 1.4 can change it. |
| `TIOCSTI` system call | No | No | Linux and macOS block it for other terminals, except for root. |
| Write to `/dev/ttysNNN` | No | No | The text goes to the screen, not to the input of the program. |

### 3.2 Problems with agent user interfaces

- **The Enter key is lost.** Claude Code ignores an Enter key that arrives too soon after a paste. In one test, Enter worked 1 time in 4 without a delay, and 4 times in 4 after a 0.4 s delay.
- **Codex paste detection.** Codex treats fast keys (8 ms apart or less) as a paste. For the next 120 ms, the Enter key adds a new line and does not send the message.
- **The agent is busy.** Typed text can interrupt a running turn, select an option in an open dialog, or remove text that the user was typing.
- **The end of a turn is a guess.** Tools wait until the screen does not change for 1.5 s to 2 s. Claude Code can look idle while it still works.
- **The reply is hard to read.** The fullscreen mode of Claude Code keeps the conversation off the scrollback. Screen captures then show only the visible rows.
- **Security.** The target agent cannot tell typed text from the user. A wrong Enter key can approve a dangerous action.

### 3.3 Projects that use this method

| Project | Method | Status |
|---|---|---|
| Coder AgentAPI | A terminal emulator in memory, with an HTTP API. It supported 11 agents. | **Archived on 2026-09-13** [local, GitHub API]. |
| claude-squad | tmux and git worktrees. | Active, 8.5k stars. It manages agents. It does not send messages between them. |
| agent-deck | tmux, with hooks for status. | Active. Its issue tracker has 88 issues about "session send". |
| open-maestri | macOS app with its own terminals. It types the prompt, then waits for 2 s of silence. | Small (6 stars). It returns the full screen as the reply. |

### 3.4 Result

| Criterion | Rating |
|---|---|
| Latency | Low. A delay of 0.3 s to 0.8 s before each Enter key, and 1.5 s to 2 s to detect the end of a turn. |
| Reliability | Low. Each update of an agent user interface can break it. |
| Portability | Medium. tmux works on macOS, Linux, and over SSH. Each terminal app has a different API. |
| Effort | Low for a demonstration. High for a product that must work every time. |

Use this option only as a fallback adapter.

## 4. Option B: the native entry point of each agent

### 4.1 Summary table

| Agent | Discover running sessions | Deliver into a running session | Detect the end of a turn | Status |
|---|---|---|---|---|
| **Claude Code** | Registry files `~/.claude/sessions/<pid>.json` [local] | (1) Inbox socket for each session [local, docs]. (2) "Channels": an MCP server pushes messages [local, docs]. | Stop hook. Inbox "notify when idle". The registry field `status` (busy or idle) [local]. | Socket: stable, on by default. Channels: research preview. |
| **Codex CLI** | `thread/loaded/list` on the app-server | App-server JSON-RPC: `turn/start` (idle), `turn/steer` (busy), `thread/inject_items` [local]. Command `codex queue` [local]. | Event `turn/completed` [local]. The `notify` program. | App-server is marked "experimental". |
| **OpenCode** | `GET /session` on its HTTP server [local] | `POST /session/{id}/prompt_async` [local] | Event stream `GET /event`, event `session.idle` [local, docs] | Stable. |
| **Gemini CLI** | None | An AfterAgent hook returns `deny` with a reason. The reason becomes a new prompt. | AfterAgent hook [docs] | Stable. Delivery only at the end of a turn. |
| **Cursor CLI** | None | A stop hook returns `followup_message` [docs] | Stop hook, `afterAgentResponse` hook [docs] | Stable. Delivery only at the end of a turn. |
| **Any other agent** | Our own registry | tmux fallback (section 3) | Screen guess | Fallback. |

### 4.2 Claude Code

**Inbox socket.** This is the best path for Claude Code.

- Each session writes a registry file `~/.claude/sessions/<pid>.json`. The file has the fields `messagingSocketPath`, `status`, `name`, `cwd`, and `peerProtocol: 1` [local].
- Each session opens a Unix socket, for example `/tmp/cc-socks/<pid>.sock` [local].
- Hooks and shell commands get the variables `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` [local, docs].
- The documentation names "a script or hook to post into a session" as a use case [docs].
- An idle session starts a new turn with the message. A busy session reads the message between two tool calls. Thus, no running tool stops [docs].
- Claude Code tells the model that the message is from another agent, not from the user. The message cannot approve a permission prompt [docs].
- Limits: 50 messages in the queue, about 1 million characters for each message, and a rate limit for each sender [docs].
- **Open question:** the documentation gives the format of the first line (`{"type":"auth","token":"..."}`). It does not give the format of the message line [not verified].

**Channels.** This is the documented push path for MCP servers.

- The MCP server declares `capabilities.experimental['claude/channel']` and sends the notification `notifications/claude/channel` [docs].
- The model sees the message with a label that shows its source [docs].
- The flags `--channels` and `--dangerously-load-development-channels` are in the binary, but `--help` does not show them [local].
- Limits: research preview. A custom server needs the "development" flag. It needs a claude.ai or Console login. Bedrock, Vertex, and Foundry do not support it [docs].

### 4.3 Codex CLI

- The Codex user interface runs on a JSON-RPC "app-server". The app-server can listen on a Unix socket or a WebSocket [local, docs].
- The installed version has `turn/start`, `turn/steer`, `thread/inject_items`, `thread/loaded/list`, `turn/completed`, and `item/agentMessage/delta` in its schema [local].
- If the shared daemon runs when the user opens Codex, the user interface connects to it. Then other programs can reach the same session [not verified: source code, not a test]. The daemon socket is `~/.codex/app-server-control/app-server-control.sock`. It did not run during our test [local].
- The command `codex queue --thread <id> --message <text>` exists [local]. The request that it sends is not in the public schema of version 0.154.0 [local]. The documentation does not describe it.
- The command `codex mcp-server` is removed [docs].

### 4.4 OpenCode

- The OpenCode user interface is a client of a local HTTP server. Start it with `--port` to get a fixed port [docs].
- We started `opencode serve` and read its API description [local]. Important endpoints:
  - `POST /session/{id}/prompt_async`: send a message, no wait.
  - `POST /session/{id}/message`: send a message, wait for the reply.
  - `GET /event`: live stream of events.
  - `POST /tui/append-prompt` and `POST /tui/submit-prompt`: type into the visible user interface through the API.
- A password is optional (`OPENCODE_SERVER_PASSWORD`) [docs].

### 4.5 Gemini CLI and Cursor CLI

- Neither agent has a documented way to push a message into an idle session.
- Both have a hook at the end of a turn. The hook can wait for a message and then return it as the next prompt.
- Limits of this method: the hook timeout (Gemini 60 s, Claude and Codex 600 s) and loop limits (Cursor 5 by default, Claude 8). After a timeout, the agent stays idle until the user types.
- Both agents support the Agent Client Protocol (ACP) natively (`gemini --acp`, `agent acp`). ACP can start and drive a new agent process. It cannot connect to a session that the user already runs.

## 5. Other patterns

| Pattern | Speed | Target keeps its live context | Reliability | Works across vendors | Works across computers |
|---|---|---|---|---|---|
| Start the other agent as a subprocess (`codex exec`, `claude -p`) | Slow (cold start) | **No.** It is a new process. | High | Yes | Only over SSH |
| Shared mailbox, and agents read it with an MCP tool | Wait until the next read | Yes | High | Yes | Needs a shared server |
| Native push (section 4) | 1 s to 5 s | Yes | Medium (preview features) | One adapter for each vendor | Not yet |
| Type into the terminal (section 3) | Low | Yes | Low | Any terminal program | No |
| A2A over HTTP | Low | Only if a server connects to the live session. No vendor does this now. | High | It is a standard | Yes |

## 6. Standards

| Standard | What it does | Fit for this project |
|---|---|---|
| **A2A** (Linux Foundation, v1.0, 2026-04-09) | Messages and tasks between agent servers. JSON-RPC, gRPC, and HTTP. Streaming, push to webhooks, signed "Agent Cards". | **Use its message format.** It has no Unix-socket or stdio binding (open issue #1074). |
| **MCP** (spec 2026-07-28) | Tools and data for one agent. The new spec has no sessions in the core. | Good for "Send" (a `send` tool). No standard way to put a server event into the context of the model. |
| **ACP** (Agent Client Protocol, Zed and JetBrains) | An editor drives an agent over stdio. | Good to start and drive new agents. It cannot connect to a running session. Its v2 draft has a useful state model: running, idle, requires_action. |
| IBM ACP (Agent Communication Protocol) | Merged into A2A in August 2025. | None. |
| ANP, AGNTCY/SLIM | Internet-scale identity and encrypted messages. | Too large for a local version 1. SLIM is an option for the network layer later. |

## 7. Existing projects and the gap

| Project | Method | Agents | Stars | Main limit |
|---|---|---|---|---|
| **agmsg** | Bash scripts and one SQLite file. No daemon, no MCP. | Claude, Codex, Gemini, Copilot, OpenCode, and more | 1,505 | Push only for Claude (Monitor tool, about 5 s) and Codex. Other agents get messages only at the end of a turn. Local only. |
| **MCP Agent Mail** | MCP HTTP server, SQLite, and Git. Threads and file leases. | Claude, Codex, Gemini, Cursor, and more | 2,149 | The agent must read its inbox. No push. |
| **claude-peers-mcp** | Broker, SQLite, and Claude channels | Claude only | 2,204 | Needs the development flag for channels. |
| PAL MCP `clink` | Subprocess calls with flags that skip approvals | Claude, Codex, Gemini | 11,755 | A new context for each call. |
| codex-claude-bridge | Shared Markdown file, Claude channel, Codex stop hook | Claude, Codex | 59 | "An idle Codex cannot be pushed." |

Star counts are from the GitHub API on 2026-09-19 [local].

**The gap that remains:**

1. **One interface to deliver into live sessions, for all vendors.** No project uses the Claude inbox socket, the Codex app-server, and the OpenCode HTTP API together.
2. **Discovery across vendors.** `ListAgents` shows only Claude sessions. `codex agents` shows only Codex sessions. No tool shows all running agents in one list.
3. **One message format.** Each project uses a different format: Markdown files, SQLite rows, JSONL, or plain text. None of them is compatible with A2A.
4. **A standard set of states.** For example: idle, busy, needs approval, offline. Safe delivery depends on this state.
5. **Trust rules for all vendors.** Each message needs a label for its source and a hop limit to stop loops. A message must never approve an action.
6. **A local binding for A2A.** Then the same messages can go to other computers without a vendor cloud.

## 8. Recommended design

```
  agent A (any vendor)
      |  runs: opencross send <agent> "<text>"   (or the MCP tool "send")
      v
  opencross CLI  ---- writes a copy ---->  mailbox (SQLite, one file)
      |
      |  finds the target in: our registry + ~/.claude/sessions + Codex app-server + OpenCode /session
      v
  adapter for the target vendor
      |-- Claude Code : inbox socket (fallback: channel MCP server)
      |-- Codex       : app-server turn/start or turn/steer
      |-- OpenCode    : POST /session/{id}/prompt_async
      |-- Gemini      : AfterAgent hook reads the mailbox
      |-- Cursor      : stop hook reads the mailbox
      '-- other       : tmux send-keys (fallback)
      v
  agent B (running session)  -->  replies with: opencross send A "<reply>"
```

Design rules:

1. **No daemon in version 1.** The CLI delivers the message directly. The mailbox keeps each message for agents that are offline, busy, or hook-based.
2. **A reply is a message.** Agent B uses the same command to answer. Thus, no program reads the screen.
3. **A2A message fields.** Each message has `messageId`, `contextId` (the conversation), `referenceTaskIds` or a reply-to field, `role`, and `parts`. Add `from`, `to`, and `hops`.
4. **Trust rules in the envelope.** Each delivered message starts with a label that names the sender and the vendor. The receiver never treats a message as approval from the user. Stop a message after a fixed number of hops.
5. **The CLI is the core.** The MCP server is a thin layer on top of the CLI. Every agent can run a shell command, but not every agent loads MCP servers the same way.

## 9. Fastest path to a working demonstration

| Step | Work | Estimate |
|---|---|---|
| 1 | Spike: deliver one message by hand on each native path. Find the format of the Claude inbox message line. Send `turn/start` to a Codex session on the daemon. Send `prompt_async` to OpenCode. | 2 to 3 hours |
| 2 | CLI with `list`, `send`, and `inbox`. Registry and SQLite mailbox. A2A-compatible envelope. | 4 hours |
| 3 | Adapters for Claude Code and Codex. Demonstration: Claude asks Codex a question and gets the answer. | 1 day |
| 4 | OpenCode adapter and tmux fallback adapter. | 4 hours |
| 5 | Hook adapters for Gemini CLI and Cursor CLI. | 1 day |
| Later | A2A binding over HTTP for other computers. | 1 to 2 weeks |

The estimates are for one developer with an AI agent. If step 1 shows that the Claude message format is not usable, use channels for Claude. That adds about 4 hours.

## 9a. Test results, 2026-09-19

We tested the two main paths on this Mac. Both work.

**Claude Code.** The inbox socket accepts two lines: the auth line, then
`{"type":"user","message":{"role":"user","content":"..."}}`. The debug output of
Claude Code gives this recipe, and the test delivered a message into a live
session [local]. A second Claude Code session received a message and answered
through openmsg [local].

**Codex.** The command `codex queue --thread <id> --message <text>` delivers a
message into a live session. The test showed the message in the session that the
user started in a terminal [local]. Conditions:

- The shared daemon must run before the user starts Codex. Start it with
  `codex app-server daemon start` [local].
- The session must have at least one turn. Before the first turn, the thread has
  no rollout file, and the queue command fails [local].
- The process that runs the session holds the rollout file open. openmsg lists
  those open files to find the live threads and their ids [local].

The control socket of the daemon closes a plain connection and a WebSocket
handshake. We did not find the handshake that it needs. The `codex queue`
command is enough, so openmsg does not need it now [local].

**Behavior of the receiving model.** Codex read the message and waited. It said
that it needs an instruction from its user before it answers another agent. Each
project needs one line in its instructions file that allows the answer.

## 10. Risks and open questions

1. **Claude inbox socket.** The format of the message line is not documented. A future version can change it. Channels are the documented alternative, but they are a research preview and need a flag.
2. **Claude channels and MCP 2026-07-28.** If Claude Code negotiates the new MCP revision with a server, it does not register that server as a channel.
3. **Codex app-server.** It is marked "experimental". The user interface connects to the shared daemon only if the daemon runs first [not verified].
4. **Gemini CLI and Cursor CLI.** They cannot receive a message while idle. The hook method has timeouts and loop limits.
5. **Positioning.** agmsg and MCP Agent Mail already have users. The project must decide: build a new tool, or build the missing parts (section 7) on top of one of them.

## Sources

Official documentation:

- Claude Code cross-session messaging: https://code.claude.com/docs/en/cross-session-messaging
- Claude Code channels: https://code.claude.com/docs/en/channels and https://code.claude.com/docs/en/channels-reference
- Claude Code hooks: https://code.claude.com/docs/en/hooks
- Claude Code fullscreen mode: https://code.claude.com/docs/en/fullscreen
- Codex app-server: https://learn.chatgpt.com/docs/app-server (also https://developers.openai.com/codex/app-server)
- Codex hooks: https://learn.chatgpt.com/docs/hooks
- Codex source, queue command: https://github.com/openai/codex/blob/main/codex-rs/tui/src/session_queue_commands.rs
- Codex source, paste detection: https://github.com/openai/codex/blob/main/codex-rs/tui/src/bottom_pane/paste_burst.rs
- OpenCode server: https://opencode.ai/docs/server/ and plugins: https://opencode.ai/docs/plugins/
- Gemini CLI hooks: https://geminicli.com/docs/hooks/reference/ and ACP mode: https://geminicli.com/docs/cli/acp-mode/
- Cursor hooks: https://cursor.com/docs/hooks and ACP: https://cursor.com/docs/cli/acp

Standards:

- A2A specification: https://a2a-protocol.org/latest/specification/
- A2A v1.0 changes: https://github.com/a2aproject/A2A/blob/main/docs/whats-new-v1.md
- A2A issue for a local binding: https://github.com/a2aproject/A2A/issues/1074
- MCP 2026-07-28 release: https://blog.modelcontextprotocol.io/posts/2026-07-28/
- Agent Client Protocol: https://agentclientprotocol.com/protocol/v1/prompt-turn and v2 draft: https://agentclientprotocol.com/announcements/acp-v2-draft
- IBM ACP merge into A2A: https://github.com/orgs/i-am-bee/discussions/5

Terminal mechanisms:

- tmux manual: https://man.openbsd.org/tmux.1
- kitty remote control: https://sw.kovidgoyal.net/kitty/remote-control/
- WezTerm: https://wezterm.org/cli/cli/send-text.html
- iTerm2 Python API: https://iterm2.com/python-api/session.html
- Ghostty AppleScript: https://ghostty.org/docs/features/applescript
- Linux TIOCSTI: https://man7.org/linux/man-pages/man2/TIOCSTI.2const.html
- Enter key test on Claude Code: https://github.com/xerktech/Turma/pull/817

Projects:

- agmsg: https://github.com/fujibee/agmsg
- MCP Agent Mail: https://github.com/Dicklesworthstone/mcp_agent_mail
- claude-peers-mcp: https://github.com/louislva/claude-peers-mcp
- Coder AgentAPI: https://github.com/coder/agentapi
- agent-deck: https://github.com/asheshgoplani/agent-deck
- claude-squad: https://github.com/smtg-ai/claude-squad
- PAL MCP clink: https://github.com/BeehiveInnovations/pal-mcp-server/blob/main/docs/tools/clink.md
- codex-claude-bridge: https://github.com/abhishekgahlot2/codex-claude-bridge
- open-maestri: https://github.com/pedrotecinf/open-maestri
