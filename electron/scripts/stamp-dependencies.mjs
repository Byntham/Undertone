import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const packageValue = await readFile(new URL("../package.json", import.meta.url));
const lockValue = await readFile(new URL("../package-lock.json", import.meta.url));
const fingerprint = createHash("sha256")
  .update(packageValue)
  .update("\0")
  .update(lockValue)
  .digest("hex");

await writeFile(
  new URL("../node_modules/.undertone-dependency-hash", import.meta.url),
  fingerprint,
  "utf8",
);
