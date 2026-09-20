// One text form for one object. A signature covers these bytes, so the sender
// and the receiver must build the same text from the same data.
//
// The rules: an object writes its keys in order of the code units of the name,
// an array keeps its order, and a key with the value `undefined` disappears.

export function canonical(value) {
  return write(value);
}

export function canonicalBytes(value) {
  return Buffer.from(canonical(value), "utf8");
}

function write(v) {
  if (v === null) return "null";
  const type = typeof v;
  if (type === "boolean") return v ? "true" : "false";
  if (type === "number") {
    if (!Number.isFinite(v)) throw new Error("canonical form: a number must be finite");
    return JSON.stringify(v);
  }
  if (type === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(write).join(",")}]`;
  if (type === "object") {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${write(v[k])}`).join(",")}}`;
  }
  throw new Error(`canonical form: a value of type ${type} has no text form`);
}
