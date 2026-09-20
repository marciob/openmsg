// Sealing, one message at a time. The relay carries bytes that it cannot read.
//
// The sender makes a new X25519 key pair for each message, and it agrees a key
// with the encryption key of the receiver. HKDF makes the AES key, and
// AES-256-GCM seals the text. The sender key is new each time, so a key that
// leaks later does not open a message that the relay stored before.
//
// The additional data is the clear header that the relay reads. A change of
// one byte in that header therefore stops the message from opening.
import crypto from "node:crypto";
import { publicKeyOf } from "./identity.mjs";

export const ALG = "X25519-HKDF-SHA256-AES-256-GCM";
const INFO = Buffer.from("openmsg-seal-v2");

function keyFor(shared, ephemeral, recipient) {
  const salt = Buffer.concat([ephemeral, recipient]);
  return Buffer.from(crypto.hkdfSync("sha256", shared, salt, INFO, 32));
}

function rawOf(jwkKey) {
  return Buffer.from(jwkKey.x, "base64url");
}

export function seal(plaintext, recipientKey, aad) {
  if (recipientKey.alg !== "X25519") throw new Error(`cannot seal for a ${recipientKey.alg} key`);
  const ephemeral = crypto.generateKeyPairSync("x25519");
  const shared = crypto.diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: publicKeyOf(recipientKey),
  });
  const epk = Buffer.from(ephemeral.publicKey.export({ format: "jwk" }).x, "base64url");
  const key = keyFor(shared, epk, rawOf(recipientKey));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final(), cipher.getAuthTag()]);
  return {
    alg: ALG,
    epk: epk.toString("base64url"),
    iv: iv.toString("base64url"),
    ct: body.toString("base64url"),
  };
}

export function open(box, privateKey, aad) {
  if (box?.alg !== ALG) throw new Error(`unknown seal algorithm: ${box?.alg}`);
  const epk = Buffer.from(box.epk, "base64url");
  const shared = crypto.diffieHellman({
    privateKey,
    publicKey: crypto.createPublicKey({
      key: { kty: "OKP", crv: "X25519", x: box.epk },
      format: "jwk",
    }),
  });
  const mine = Buffer.from(privateKey.export({ format: "jwk" }).x, "base64url");
  const key = keyFor(shared, epk, mine);
  const body = Buffer.from(box.ct, "base64url");
  if (body.length < 17) throw new Error("the sealed message is too short");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64url"));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(body.subarray(body.length - 16));
  try {
    return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
  } catch {
    // The tag covers the text and the header. One changed byte in either one
    // gives this fault, and a key that is not the key of the receiver too.
    throw new Error("the sealed message did not open: a byte changed, or it is not for this key");
  }
}
