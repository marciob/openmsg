# openmsg protocol, version 0.2, draft: agents of different people

Status: draft, and implemented, with the delegation of section 3.2. The
fourteen cases of section 11 pass as tests in `test/acceptance.test.mjs`.
Date: 2026-09-20.

Version 0.1 moves a message between agents of one person on one machine. This
draft adds agents of different people, on different machines, that work on one
project.

Example: two people work on one repository at the same time. One of them sees a
fault in the work of the other. The agent of the first person sends a message to
the agent of the second person, while that agent works.

This document extends `openmsg-0.1.md`. Every rule of 0.1 still applies.

A review of this design by a Codex session produced many of the rules below.

## 1. Model

| Term | Meaning |
|---|---|
| Owner | The person who runs the agents. An owner has one identity in a team. |
| Gateway | One process for each owner. It publishes the sessions that the owner selects, and it receives messages for them. |
| Project | The shared work. A project has an opaque id that the team agrees on. |
| Directory | The list of owners in a project, with their public keys and their endpoints. |
| Relay | A server that carries messages between gateways. |

The gateway is the only part that the network reaches. A vendor socket, a vendor
port, and a vendor token stay on the machine of the owner. The gateway hands a
message to the local adapter of 0.1 for the last step.

## 2. Addresses

A person reads an alias. The protocol delivers to an identifier.

```
alias:    claude:api-worker@alice
target:   { owner: <owner id>, project: <project id>, session: <session id>, epoch: <number> }
```

Rules:

1. A sender resolves an alias to a target before it sends.
2. Delivery uses the target only. An alias that moved to another session must
   never receive the message.
3. The epoch changes when a session restarts. A message for an old epoch is
   refused, not delivered.
4. A gateway publishes presence to a person, and signed routing data to an
   authorized gateway. See section 9. It must not publish the working
   directory, the socket path, the token, or the local registry object.

## 3. Identity

1. Each owner has a signing key and a separate encryption key. Both use an
   established algorithm.
2. Each device or session that sends holds a delegation from the owner key. A
   receiver verifies the delegation as well as the owner. A machine holds its
   own signing key and its own encryption key. The machine id comes from those
   two keys, as the owner id comes from the two owner keys. The owner key
   signs a record that names the machine, its keys, the projects that it may
   sign for, and a date. That record is the delegation, and it travels inside
   the signature of each message.
   The owner key stays on the machine that made the identity. A second machine
   sends a request with its public keys, the first machine answers with a
   delegation, and no private key moves. The second machine holds the public
   record of its owner, and it cannot make a delegation, an invitation, or a
   new identity.
   A message for one machine is sealed for the key of that machine, which the
   routing data of section 9 carries. A message sealed for the owner key opens
   only on a machine that holds that key.
3. A person joins a project through an invitation. The two sides verify a
   fingerprint out of band.
4. A git author email is a label for a person. It is never proof of identity.
5. The directory holds a rotation record and a revocation list, for an owner
   and for one machine of an owner. A revoked machine stops, and the identity
   of that person holds: the other machines of that person keep working, and
   no member invites that person again. An owner tells the team about a
   machine of that owner with a signed record, and every member applies it.
   See section 12.1. A receiver must
   refuse a message from a revoked key, and must recheck at the moment of
   delivery.
6. The signing key is Ed25519, and the encryption key is X25519.
7. The owner id and the fingerprint come from one digest of the two public
   keys: `SHA-256` over the text `openmsg-identity-v2`, a newline, and the
   canonical form of the two keys. The owner id is `o_` and the first 8
   characters of the digest. The fingerprint is the first 32 characters, in
   eight groups of four. The label of the owner stays outside the digest, so a
   new label does not make a new identity.
8. The keys give the owner id. A record that claims an owner id which its keys
   do not give is false, and a receiver refuses it. A new key is therefore a
   new owner, and the old owner id goes to the revocation list.

## 4. Transport

1. The first transport is one relay for each team, and every gateway keeps an
   outbound connection to it. No laptop needs an open port. A direct mesh, for
   example over a private network, comes later.
2. The connection uses TLS, and the gateway authenticates with its key.
3. If the team needs a relay that cannot read the work, the message body is
   sealed for the receiving owner, with the encryption key. Then the relay
   carries bytes that it cannot read.
4. If the team accepts a relay that reads the body, the product must say so in
   plain words. A promise of privacy without sealing is false.
5. Two gateways can also use a direct address, and the directory holds that
   address for each member. This transport works on one machine and on one
   private network. A member with a direct address takes a message that way,
   and a member without one takes it through the relay.
6. The relay speaks WebSocket. The first frame of a gateway is a `hello` that
   carries the two public keys of the owner and a signature. The owner id
   comes from the keys, so a key that gives that owner id is the key of that
   owner, and the relay needs no directory to know who connects. A machine
   that holds a delegation signs the hello with its own key and sends the
   delegation with it, and the relay verifies that chain against the owner
   keys in the same frame.
7. The frames are `hello`, `welcome`, `send`, `stored`, `refused`, `deliver`,
   `ack`, `receipt`, `routing-request`, and `routing-answer`. A request for
   routing data and its answer both carry a signature of an owner, so the
   relay forwards them and cannot make one.
8. The relay stores a message for a receiver that is offline. It answers
   `stored` only after the message is on its disk. It forgets the message when
   the receiver acknowledges it, and it keeps the receipt for a sender that is
   offline.
9. The bounds of the store are 256 kilobytes for one message, 200 messages for
   one owner, and seven days of age. A message that passed its deadline never
   enters the store.
10. `openmsg relay start` takes `--cert` and `--key`, and then it speaks
    `wss://`. A relay on any address that is not the loopback refuses to
    start without them. An operator whose proxy ends TLS adds `--insecure`,
    and types that word.
11. A gateway refuses a `ws://` relay that is not on its own machine. The
    owner accepts that with `openmsg relay use <url> --insecure`. A team with
    its own certificate gives it with `--ca <file>`, and the gateway then
    trusts that certificate and no other one.
12. The body of a message is sealed, and the addresses on the outside are
    not. TLS covers the hello of a gateway, the two owner ids, the project
    id, and the times.
13. An owner holds one connection for each machine, up to a bound. The relay
    cannot read a message, so it does not know which machine holds the
    session that a message names. It gives the message to every machine of
    that owner.
14. A machine sends no acknowledgement for a message that it cannot place:
    the session is not published here, the session does not run here, or the
    seal does not open with the keys of this machine. The message then stays
    at the relay for a machine that can take it. A machine that takes a
    message acknowledges it, and the relay forgets it.
15. A question about routing goes to every machine of that owner, and each
    one answers for the sessions that it publishes. The sender verifies each
    answer on its own and joins the lists. Each row carries the encryption
    key of the machine that answered, and a message for a session is sealed
    for that machine.
16. A receipt goes to every machine of the owner that sent, because the relay
    does not know which machine sent. A receipt for an owner that is offline
    waits until it is old, and every machine that connects reads it. A
    machine that reads one twice writes the same state twice.

## 5. Authentication of a message

1. The sender signs a canonical form of the envelope. The signature covers
   every field that carries meaning: the version, `from`, the project, the
   target, `messageId`, `contextId`, `replyTo`, `createdAt`, the expiry,
   `hops`, `workspace`, and the parts. It excludes the signature itself and the
   receipt data that a receiver adds locally.
2. The receiver binds the authenticated sender to the `from` field. If the two
   do not match, the receiver refuses the message.
3. A gateway must not rewrite a signed field. It can attach verified data beside
   the envelope, in its own object.
4. The receiver validates the signature, the delegation, the membership, and the
   expiry, before the message reaches the model.
5. A delegation names its scope: the owner, the project, the devices that can
   sign, and the sessions that can receive. A receiver refuses a message that
   falls outside the scope of the delegation.
6. Where a rule of this document and a rule of 0.1 disagree, this document
   applies.
7. The signature covers a view of the envelope that holds the named fields and
   nothing else. The receiver rebuilds that view, and it gives that view to the
   agent. A field that no signature covers therefore never reaches the model.
8. The signature travels inside the sealed body. A person who holds the sealed
   bytes cannot test a guess about the text against the signature.

## 6. Authorization

1. A message never expands authority. This rule of 0.1 holds across people.
2. The owner of the receiving agent sets a standing permission for each identity
   and project: `accept`, `hold`, or `refuse`. The value applies to one project,
   not to everything.
3. A message from an unknown identity is held outside the context of the model.
   The model does not read it until the owner accepts the sender.
4. A message can ask for work. The receiving agent does the work only inside the
   permissions that its owner already gave it. A wording rule such as
   "information only" cannot hold a boundary, because a warning also starts an
   investigation. Where the runtime can limit the tools, it must.
5. The receiver checks the authorization again at the moment of delivery,
   because a queue can delay a message after the check.
6. The receiver holds its own limits: a rate limit for each sender, a limit on
   the turns that remote messages start, and a limit on the size of the queue.
   The `hops` list of the sender is not enough. The values today are 30
   messages from one sender in 5 minutes, 10 turns from remote messages in one
   session in 10 minutes, and 100 messages that wait for the owner. The owner
   changes a value in `$OPENMSG_HOME/limits.json`.
7. A rate limit and a full queue refuse a message. A turn limit holds it,
   because the work of the sender is not lost then, and the owner decides.
8. The default permission is `hold`, also for a person in the directory.
   Membership says who somebody is. It does not say that the agent of that
   person can write into a session of this machine. The owner gives that with
   one command, for one project.
9. A message from a key that the directory does not hold is refused, and not
   held. The receiver cannot verify such a message, and a held message that
   nobody can attribute is of no use to the owner.
10. A person reads a held message as plain text, and only on demand. No model
   reads it, and no model writes a summary of it.

## 7. The envelope, added fields

```json
{
  "openmsg": {
    "version": 2,
    "project": { "id": "opaque-id", "label": "web-app" },
    "target": { "owner": "o_8f13c0e4", "project": "p_47a91b", "session": "01a0...", "epoch": 3 },
    "expiresAt": "2026-09-19T23:59:00.000Z",
    "workspace": { "branch": "main", "commit": "9f2c...", "dirty": false }
  }
}
```

1. `project.id` is opaque. A raw git remote URL must not travel, because it can
   hold a credential or the name of a private host. The label is a short name
   that the team chooses.
2. `workspace` is a claim of the sender. It describes the checkout of the
   sender, and it is never evidence about the checkout of the receiver. The
   receiving agent must read it as "the other person saw this".
3. `expiresAt` is a deadline. After it passes, the receiver refuses the message,
   whatever the state of the target.

A message travels in two parts:

```json
{
  "kind": "sealed", "version": 2,
  "messageId": "...", "createdAt": "...", "expiresAt": "...",
  "from": { "owner": "o_8f13c0e4" },
  "project": { "id": "p_47a91b" },
  "target": { "owner": "o_c548bcfd", "project": "p_47a91b" },
  "seal": { "alg": "...", "epk": "...", "iv": "...", "ct": "..." }
}
```

4. The clear header is the object above. It holds what the relay needs to move
   the message: the two owners, the project, the message id, and the times. It
   holds no text, no session id, no name of a person, and no branch.
5. The sealed body holds the full envelope of section 7, with the parts and the
   signature.
6. The clear header is the additional data of the seal. A change of one byte in
   the header stops the message from opening.
7. The receiver builds the clear header again from the envelope that it opened,
   and it compares the two. A header that does not match is a header that
   somebody rewrote, and the receiver refuses the message.
8. The session id and the epoch of the target stay inside the seal. The gateway
   of the receiver reads them after it opens the message.

## 8. States

A message holds one state. The states of 0.1 are not enough, because a write to
a socket is not a read by a model.

| State | Meaning |
|---|---|
| `queued` | The message waits. The sender holds it because the target is not reachable, or the receiver holds it before the adapter takes it. |
| `held` | The receiver has it, and the owner must accept the sender first. |
| `adapter-accepted` | The local adapter took the message. Whether the model read it is unknown. |
| `agent-acknowledged` | The agent read the message. |
| `replied` | The agent answered. |
| `refused` | A rule stopped the message. The reason is recorded. |
| `expired` | The deadline passed. |

Rules:

1. A message reaches `agent-acknowledged` only through an acknowledgement event
   from the agent, for example a hook at the end of a turn, or a read of the
   mailbox. A receipt from a transport never proves that a model read a message.
   Two events give a state today. The agent runs `openmsg ack <id>`, and that
   id is inside the text of the message. Or the agent answers with
   `--reply-to <id>`, and the message takes the state `replied`. The receiver
   tells the sender each new state with a signed receipt, over the relay or
   over the direct address.
2. The receiver writes the message to a durable store before it acknowledges.
3. A retry carries the same `messageId`. The receiver removes a duplicate by the
   authenticated sender and the `messageId`.
4. A conflicting duplicate holds the same `messageId` and the same authenticated
   sender, with different content. The receiver refuses the new arrival, keeps
   the record of the first message, and reports the event. A receiver must never
   rewrite the history of a delivery that already happened.
5. Retries are bounded.
6. An expiry stops an injection that did not happen yet. It does not undo work
   that an agent already started.
7. openmsg does not promise that a message runs exactly one time. A crash
   between delivery and acknowledgement leaves a doubt that no protocol removes.
   The receiving agent must therefore treat a repeated message as possible.
   The receiver writes `queued` before it gives the message to the adapter,
   and it says in words that nobody knows whether the adapter took it. A
   message in that state goes to the agent again on the next try, because a
   message that arrives twice is better than a message that nobody sees.
8. A message that arrives a second time, with a state that the first copy
   already reached, does not reach the agent again. The store records the
   second arrival with the reason `duplicate`. A message that a rule stopped
   can arrive again, because the reason can pass: a session that runs again,
   for one.
9. A refusal records a reason. These reasons exist today:

| Reason | Meaning |
|---|---|
| `bad-shape` | The object is not a sealed message of version 2. |
| `not-for-me` | The target names another owner. |
| `unseal-failed` | A byte changed, or the message is for another key. |
| `header-rewritten` | The clear header and the signed envelope disagree. |
| `bad-signature` | The signature does not match the key in the directory. |
| `sender-mismatch` | The signature and the `from` field name different owners. |
| `unknown-sender` | The directory holds no key for that owner. |
| `revoked-sender` | The team revoked that key. |
| `permission-refuse` | The owner refuses that sender in that project. |
| `not-published` | That session is not published in that project. |
| `old-epoch` | The session restarted after the sender read the routing data. |
| `session-gone` | That session does not run now. |
| `adapter-failed` | The local adapter did not take the message. |
| `bad-delegation` | The owner did not allow that machine, or not for that project, or not any more. |
| `revoked-device` | The owner revoked that machine. |
| `hop-limit` | The chain of replies passed the limit. |
| `expired` | The deadline passed. |
| `duplicate` | The same message arrived again. The first record holds. |
| `conflict` | One message id, one sender, and another content. |
| `rate-limit` | That sender passed its rate. |
| `turn-limit` | Remote messages started too many turns in that session. |
| `queue-full` | Too many messages wait for the owner. |

## 9. Delivery

1. The gateway of the receiver gives the message to the local adapter of 0.1.
2. The adapters do not change. The last step is the same as for one person.
3. Only the sessions that the owner selects are published. The default is that
   nothing is published.
4. A published session has two descriptions, and they are not the same thing:
   - **Presence**, which a person reads: the alias and the status.
   - **Routing data**, which a gateway reads: the owner id, the project id, the
     session id, the epoch, and the endpoint. It is signed, and an authorized
     peer alone receives it.
5. Neither description carries the working directory, a socket path, a token, or
   a raw repository URL.
6. A gateway asks for routing data with a signed request. The request names the
   owner, the project, the time, and a number that it uses one time. The
   receiver verifies the signature against its directory, and it refuses a
   request that is more than two minutes old.
7. A gateway answers routing data for one project, and only to a member of that
   project. It signs the answer.
8. The epoch of a published session counts the moves of one alias. A new
   session under one name takes the next epoch, and a message for the old epoch
   is refused.

## 10. Relation to A2A

1. openmsg 0.1 uses the field names of A2A. Equal names are not conformance.
2. This draft pins A2A version 1.0, and a later document gives the mapping field
   by field, with tests.
3. A2A has an option to sign an agent card with JWS. That option is separate
   from authentication and from authorization. The keys, the delegations, and
   the signed envelope of this document are choices of openmsg, and A2A does not
   supply them.

## 11. Acceptance demonstration

A version 0.2 is done when this demonstration passes. A Codex review proposed
this list.

1. Two owners, one project, one session published by each side.
2. An invitation, verified by fingerprint, before the first message.
3. A message that arrives while the receiving agent is busy.
4. A receiver that is offline, and that gets the message after it reconnects.
5. A retry with the same `messageId` that does not deliver a second copy.
6. A sender whose key was revoked, and whose message is refused.
7. A message for a session that restarted, refused by the epoch.
8. A limit on replies that stops a loop between two people.
9. A sender that the owner has not accepted, whose message stays held and
   outside the context of the model.
10. A message with a changed byte, refused by the signature.
11. A message that expires while it waits, and never reaches the model.
12. Two messages with one `messageId` and different content.
13. A key revoked after the message entered the queue.
14. A crash between injection and acknowledgement, where the state stays
    ambiguous and the receiver says so.

This list is a smoke test. A release needs more than a pass here.

A fifteenth case, for the delegation: a second machine of one owner, with no
private key of that owner, sends a message that the receiver verifies and
names; the owner revokes that one machine; the next message of that machine
is refused, and the owner keeps sending from another machine.

The fourteen cases pass as tests in `test/acceptance.test.mjs`, on
2026-09-20. Case 3 also passed with a live Claude session that was busy. A
stub adapter cannot show a model at work, so the test shows what the code
promises: delivery does not wait for a session to become idle.

## 12. Answers to the open questions

A Codex review gave these answers. They are the plan of record.

1. **The directory.** The relay holds it, and a reader authenticates. Each
   record of membership and each rotation is signed, and every gateway keeps a
   local copy. A change in a repository must never give access, because a
   person who can commit is not therefore a member.

   This is implemented with three records, and an owner signs each one about
   itself:

   | Record | It says | Who applies it |
   |---|---|---|
   | `self` | "this is my public record, and my gateway answers here" | Every member, for an owner that it already holds. |
   | `roster` | "these are the members that I accepted in this project, and what I let each one do" | The other machines of that same owner. |
   | `revoke-device` | "this machine of mine is gone" | Every member, because only an owner names the machines of that owner. |

   A record carries the public keys of its owner, and the owner id comes from
   those keys. A record therefore proves itself, and the relay verifies one
   without a directory of its own. The relay takes a record from the owner
   that signs it, and from nobody else. It gives the records of a project to
   an owner that already has a record there.

   **A record never adds a member.** An owner that this machine does not hold
   waits in a list, with its fingerprint, until the person accepts it. Rule
   3.3 holds: a person joins through an invitation, and the two sides compare
   a fingerprint.

   A standing permission of section 6 travels in the `roster`. The owner
   decides `accept`, `hold`, or `refuse` one time, on one machine, and every
   machine of that owner holds the same answer. A permission belongs to the
   person, and not to a machine.

   A `roster` is the answer to one machine of an owner that knows nothing. It
   carries the members that the person already accepted, with the fingerprints
   that the person already compared. A second machine of one owner therefore
   needs the public record of its owner and nothing else.
2. **Storage for an offline receiver.** Both sides hold the message. The relay
   keeps it in a durable store of bounded size, and the sender keeps it in an
   outbox until the receiver gives a durable receipt.
3. **A held message.** The person sees the verified sender and project, and the
   full text on demand, as plain text that cannot act. No model writes a
   summary of a message that no model is allowed to read.
4. **The relay.** One transport. A team hosts its own relay first. A public
   relay comes later, and only with sealed messages.

## 13. Encryption: the decision

**openmsg seals every message end to end. The relay cannot read a message.**
The owner of the project made this decision on 2026-09-19.

What follows from it:

1. Each owner holds a signing key and a separate encryption key. The sender
   seals the parts of the message for the encryption key of the receiver.
2. The relay stores the sealed bytes and the data that it needs to route them:
   the sender, the receiver, the project, the time, and the size.
3. The relay learns who writes to whom, when, and in which project. This design
   does not hide that. A product must not claim that it does.
4. A person joins through an invitation, and the two sides verify a fingerprint
   before the first message. This step is necessary, and a product must not
   skip it for speed.
5. A lost key means a lost history. The relay cannot give the text back.
6. A user interface decrypts in the browser or on the machine of the owner. The
   relay cannot search the text, and it cannot show it.
7. A hosted relay stays honest under this rule, because the operator holds no
   readable code.
8. The seal is `X25519-HKDF-SHA256-AES-256-GCM`. The sender makes a new X25519
   key pair for each message, and it agrees a key with the encryption key of
   the receiver. HKDF-SHA256 makes the AES key, with the two public keys as the
   salt and `openmsg-seal-v2` as the info. AES-256-GCM seals the text.
9. The key of the sender is new for each message. A key that leaks later
   therefore does not open a message that the relay stored before.

## 14. Version

This draft is version 0.2. `openmsg.version` is the integer `2`.
