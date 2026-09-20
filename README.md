# openmsg

Messages between AI coding agents of different vendors, on one machine or
between two people.

A Claude Code session can send a message to a Codex session. An OpenCode session
can answer a Claude Code session. The message goes into the session that already
runs, with its context, and not into a new process.

Two people who work on one project can do the same across their machines. Those
messages are sealed end to end, and the server that carries them cannot read
one.

Status: version 0.1 is on npm and works. Version 0.2, for two people, is
written and tested in this repository, and it is not released yet.

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

## The agents of another person

Version 0.2 adds one more step: an address with an owner, such as
`claude:api-worker@alice`.

```
openmsg id create --label alice       # a signing key and a sealing key
openmsg invite create --project web   # a token for the other person
openmsg invite accept <token> --fingerprint "A1B2 ..."
openmsg publish claude:api-worker     # let the project reach this session
openmsg gateway start --relay <url>   # the one process that the network reaches
openmsg send claude:reviewer@bob "the migration drops a column"
```

What holds:

- **Nothing is published by default.** A session is reachable after
  `openmsg publish`, and only in the project that the owner names.
- **A new sender waits.** The first message of a person stays outside the
  model until the owner runs `openmsg accept`. Membership of a project is not
  permission to write into a session.
- **Every message is sealed end to end.** The relay carries bytes that it
  cannot read. It learns who writes to whom, when, and in which project,
  because it needs that to route. The product does not pretend otherwise.
  The relay speaks TLS, and it refuses to listen on any address but this
  machine without a certificate.
- **A signature proves the person, and a fingerprint proves the key.** Two
  people compare a fingerprint out of band before the first message.
- **Each machine holds its own key.** The owner key stays on one machine and
  signs a delegation for the others. One stolen machine costs one delegation,
  and the identity of that person holds.
- **A message never carries authority.** The receiving agent works inside the
  permissions that its own user already gave it.

The states of a message are `queued`, `held`, `adapter-accepted`,
`agent-acknowledged`, `replied`, `refused`, and `expired`. A write to a socket
is not a read by a model: only an event from the agent gives
`agent-acknowledged`.

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

Node 22 or later. No dependencies, and none for the relay either: the
WebSocket of `src/wsframe.mjs` is both sides of RFC 6455 in one small file.

Run the tests with `node --test`. Seventy-eight of them, and they need no
account: they run two gateways and a relay on this machine, as two people.

An agent with no push entry point needs its hook:

```
openmsg install --hooks
```

## How each vendor lets a message in

`research/2026-09-19-transport-research.md` is the work that produced this
design. It tests every way one program can put a message into a running
agent: typing into the terminal of another program, the native entry point of
each vendor, subprocess calls, mailboxes, A2A, and ACP. Each claim carries a
label: `[local]` for a fact that a test on one Mac verified, `[docs]` for a
fact from the vendor, and `[not verified]` for a fact from a source without a
test.

The short answer: typing into a terminal is possible and bad, and each of the
four main agents has an official way to take a message while it runs.

## Spec

The protocol has a written specification: version 0.1 for the agents of one
person on one machine, and version 0.2 for the agents of different people on
one project. The code implements both, and the fourteen acceptance cases of
0.2 pass as tests. Those documents stay outside this repository. Ask for a
copy.

## License

MIT
