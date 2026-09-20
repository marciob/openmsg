// A small WebSocket, for the relay. It speaks the part of RFC 6455 that
// openmsg needs: the handshake, a text message, a ping, and a close.
//
// Both sides are here, and openmsg keeps no dependency. Node holds a
// WebSocket client, and that client refused a handshake that follows the
// standard, from this server and from a raw server that writes the same
// bytes. The cause stays unknown, so openmsg carries its own client.
//
// The frames follow RFC 6455. A client masks every frame that it sends, and a
// server masks none. A server that uses another library therefore works with
// this client.
import crypto from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import { EventEmitter } from "node:events";

const GUID = "258EAFA5-E914-47DA-95CA-5AB0DC85B11F";
export const MAX_MESSAGE = 1024 * 1024;

const OP = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa };

export function accepts(request) {
  return (
    (request.headers.upgrade ?? "").toLowerCase() === "websocket" &&
    typeof request.headers["sec-websocket-key"] === "string"
  );
}

// The answer of the handshake. The key of the client and one fixed text give
// the value that the client compares.
export function handshake(socket, request) {
  const accept = crypto
    .createHash("sha1")
    .update(request.headers["sec-websocket-key"] + GUID)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  return new Connection(socket);
}

export class Connection extends EventEmitter {
  // A server reads masked frames and writes plain ones. A client does the
  // opposite. RFC 6455 gives no choice on either side.
  constructor(socket, role = "server") {
    super();
    this.role = role;
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.parts = [];
    this.partsOpcode = null;
    this.closed = false;
    socket.on("data", (chunk) => this.read(chunk));
    // "end" arrives when the other side sends FIN. A process that stops gives
    // FIN, and without this line the connection looks alive until the next
    // write fails.
    socket.on("end", () => this.end());
    socket.on("close", () => this.end());
    socket.on("error", () => this.end());
  }

  read(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    // A short buffer holds no whole frame yet. The next chunk continues it.
    while (!this.closed) {
      const frame = parse(this.buffer, this.role === "server");
      if (!frame) return;
      this.buffer = this.buffer.subarray(frame.size);
      try {
        this.handle(frame);
      } catch (e) {
        this.fail(1002, e.message);
        return;
      }
    }
  }

  handle(frame) {
    if (frame.opcode === OP.close) {
      this.write(OP.close, Buffer.alloc(0));
      this.socket.end();
      this.end();
      return;
    }
    if (frame.opcode === OP.ping) {
      this.write(OP.pong, frame.payload);
      return;
    }
    if (frame.opcode === OP.pong) return;

    if (frame.opcode === OP.continuation) {
      if (this.partsOpcode === null) throw new Error("a continuation frame with no first frame");
    } else {
      if (this.partsOpcode !== null) throw new Error("a new message inside a message");
      this.partsOpcode = frame.opcode;
    }
    this.parts.push(frame.payload);
    const size = this.parts.reduce((n, p) => n + p.length, 0);
    if (size > MAX_MESSAGE) throw new Error("the message is too big");
    if (!frame.fin) return;

    const body = Buffer.concat(this.parts);
    const opcode = this.partsOpcode;
    this.parts = [];
    this.partsOpcode = null;
    if (opcode === OP.text) this.emit("message", body.toString("utf8"));
    else this.emit("binary", body);
  }

  // It gives false when the connection is gone. A caller that must know
  // whether the other side got the text reads this answer.
  send(text) {
    if (this.closed || !this.socket.writable) return false;
    return this.write(OP.text, Buffer.from(text, "utf8"));
  }

  ping() {
    if (!this.closed) this.write(OP.ping, Buffer.alloc(0));
  }

  write(opcode, payload) {
    const mask = this.role === "client";
    const length = payload.length;
    const flag = mask ? 0x80 : 0x00;
    let header;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, flag | length]);
    } else if (length <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = flag | 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = flag | 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    let body = payload;
    if (mask) {
      const key = crypto.randomBytes(4);
      body = Buffer.allocUnsafe(length);
      for (let i = 0; i < length; i += 1) body[i] = payload[i] ^ key[i & 3];
      header = Buffer.concat([header, key]);
    }
    try {
      this.socket.write(Buffer.concat([header, body]));
      return true;
    } catch {
      this.end();
      return false;
    }
  }

  fail(code, reason) {
    if (this.closed) return;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    this.write(OP.close, payload);
    this.socket.end();
    this.end();
  }

  close() {
    if (this.closed) return;
    this.write(OP.close, Buffer.alloc(0));
    this.socket.end();
    this.end();
  }

  end() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
}

// One frame, or null when the buffer holds less than one frame.
function parse(buffer, expectMask) {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  const fin = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const big = buffer.readBigUInt64BE(offset);
    if (big > BigInt(MAX_MESSAGE)) throw new Error("the frame is too big");
    length = Number(big);
    offset += 8;
  }
  if (length > MAX_MESSAGE) throw new Error("the frame is too big");
  if (expectMask && !masked) throw new Error("a frame from a client must carry a mask");
  if (!expectMask && masked) throw new Error("a frame from a server must carry no mask");
  if (buffer.length < offset + (masked ? 4 : 0) + length) return null;
  let payload;
  if (masked) {
    const mask = buffer.subarray(offset, offset + 4);
    offset += 4;
    payload = Buffer.allocUnsafe(length);
    for (let i = 0; i < length; i += 1) payload[i] = buffer[offset + i] ^ mask[i & 3];
  } else {
    payload = Buffer.from(buffer.subarray(offset, offset + length));
  }
  return { fin, opcode, payload, size: offset + length };
}

// --- the client ------------------------------------------------------------

// It opens a connection and it gives back a Connection. The answer of the
// server must hold the value that the key of this client gives, or the
// handshake fails.
export function connect(url, { timeoutMs = 10_000 } = {}) {
  const address = new URL(url);
  const secure = address.protocol === "wss:";
  const port = Number(address.port || (secure ? 443 : 80));
  const key = crypto.randomBytes(16).toString("base64");
  const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");

  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host: address.hostname, port, servername: address.hostname })
      : net.createConnection({ host: address.hostname, port });
    const fail = (e) => {
      socket.destroy();
      reject(new Error(`the relay at ${url} did not answer: ${e.message}`));
    };
    const timer = setTimeout(() => fail(new Error("timeout")), timeoutMs);
    socket.once("error", fail);
    socket.on(secure ? "secureConnect" : "connect", () => {
      socket.write(
        `GET ${address.pathname || "/"} HTTP/1.1\r\n` +
          `Host: ${address.host}\r\n` +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Key: ${key}\r\n` +
          "Sec-WebSocket-Version: 13\r\n\r\n",
      );
    });
    let head = Buffer.alloc(0);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) {
        if (head.length > 8192) fail(new Error("the answer of the handshake is too long"));
        return;
      }
      const headers = head.subarray(0, end).toString("utf8");
      socket.off("data", onData);
      clearTimeout(timer);
      socket.off("error", fail);
      if (!/^HTTP\/1\.1 101/.test(headers)) {
        socket.destroy();
        reject(new Error(`the relay at ${url} answered "${headers.split("\r\n")[0]}"`));
        return;
      }
      const given = headers.match(/sec-websocket-accept: (.+)/i)?.[1]?.trim();
      if (given !== accept) {
        socket.destroy();
        reject(new Error(`the relay at ${url} answered with a wrong handshake value`));
        return;
      }
      const connection = new Connection(socket, "client");
      // The first frames can arrive in the same packet as the handshake.
      const rest = head.subarray(end + 4);
      if (rest.length > 0) connection.read(rest);
      resolve(connection);
    };
    socket.on("data", onData);
  });
}
