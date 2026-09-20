# openmsg

Messages between AI coding agents of different vendors, on one machine.

A Claude Code session can send a message to a Codex session. An OpenCode session
can answer a Claude Code session. The message goes into the session that already
runs, with its context, and not into a new process.

Status: early work. The Claude Code path works. See "State" below.

## How it works

Each vendor has its own way to accept a message while it runs. openmsg uses that
native way, and gives all of them one command:

```
openmsg list                  # the agents that run now, all vendors
openmsg send <agent> "<text>" # deliver a message now
openmsg inbox                 # the messages for this agent
openmsg whoami                # how other agents address this one
```

An address is `<vendor>:<name>`, for example `claude:api-worker`.

| Vendor | How openmsg delivers the message | State |
|---|---|---|
| Claude Code | The inbox socket of the session | Works, tested live |
| Codex | `codex queue` on the shared app-server daemon | Works, tested live |
| OpenCode | `POST /session/{id}/prompt_async` on its local server | Delivery tested live. A reply needs a model account |
| Cursor CLI | A hook reads the mailbox at the end of each turn | Written, tested with fixtures. A live test needs `CURSOR_API_KEY` |
| Gemini CLI | The same hook, as an AfterAgent deny | Written, tested with fixtures. Gemini CLI is not installed here |
| Other agents | `tmux send-keys` | Not started |

A reply is a new message. The receiving agent answers with `openmsg send`. No
program reads the screen of another program.

## Message format

The envelope uses the field names of the A2A standard (`messageId`, `contextId`,
`parts`, `role`). The same message can travel over A2A on HTTP later, between
two machines.

Each delivered message carries a header that names the sender. The text tells
the receiving model that the message is from another agent, and that it approves
nothing. Each message keeps a list of the agents that it passed through, so a
loop between two agents stops.

## Install

```
npx openmsg list
```

Or from the source:

```
git clone https://github.com/marciob/openmsg.git && cd openmsg
node src/cli.mjs list
```

Node 22 or later. No dependencies.

Run the tests with `node --test`.

An agent with no push entry point needs its hook:

```
openmsg install --hooks
```

## Spec

- `docs/spec/openmsg-0.1.md`: the protocol for the agents of one person on one
  machine. This is what the code implements.
- `docs/spec/openmsg-0.2-draft.md`: a draft for the agents of different people
  on one project. Not implemented.

## Research

`docs/research/2026-09-19-transport-research.md` gives the full comparison of the
options, with sources: terminal typing, native entry points, subprocess calls,
mailboxes, A2A, and ACP.

## License

MIT
