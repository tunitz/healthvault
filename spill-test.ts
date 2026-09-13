import { readdirSync } from "node:fs";
const before = new Set(readdirSync("/tmp"));
const blob = Bun.file("/tmp/big-export.zip");
const fd = new FormData();
fd.set("file", new File([blob], "export.zip"));
// same shape the Next route does: req.formData() -> File.arrayBuffer()
const req = new Request("http://x/upload", { method: "POST", body: fd });
const parsed = await req.formData();
const f = parsed.get("file") as File;
const bytes = new Uint8Array(await f.arrayBuffer());
const during = readdirSync("/tmp").filter((n) => !before.has(n) && !n.startsWith("spill-test"));
console.log("bytes:", bytes.length, "first byte:", bytes[0]);
console.log = console.log;
console.log("new /tmp entries DURING parse:", JSON.stringify(during));
// also check the classic spots
for (const d of ["/tmp", process.env.TMPDIR ?? "/tmp"]) {
  const spill = readdirSync(d).filter((n) => /multipart|formdata|busboy|undici/i.test(n));
  if (spill.length) console.log("spill-like files in", d, ":", spill);
}
