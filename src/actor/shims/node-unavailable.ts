/**
 * Stand-in for Node-only modules (fs, path, child_process, os, url, module, ws, cloakbrowser, OTel) in the
 * in-browser actor build. The runtime only reaches them when an outDir / recorder / launcher is used, which
 * the in-browser actor never configures; any accidental call fails loudly instead of silently no-oping.
 */
const fail = (name: string) => () => { throw new Error(`${name} is not available in the in-browser actor`); };
const handler: ProxyHandler<any> = { get: (_t, k) => (k === "__esModule" ? true : k === "default" ? proxy : fail(String(k))) };
const proxy: any = new Proxy({}, handler);
export default proxy;
export const readFileSync = fail("fs.readFileSync"), writeFileSync = fail("fs.writeFileSync"), appendFileSync = fail("fs.appendFileSync"),
  mkdirSync = fail("fs.mkdirSync"), existsSync = () => false, mkdtempSync = fail("fs.mkdtempSync"), rmSync = fail("fs.rmSync"),
  writeFile = fail("fs.writeFile"), readFile = fail("fs.readFile"), createWriteStream = fail("fs.createWriteStream");
export const join = (...p: string[]) => p.filter(Boolean).join("/").replace(/\/+/g, "/");
export const dirname = (p: string) => p.replace(/\/[^/]*$/, "") || "/";
export const basename = (p: string) => p.replace(/^.*\//, "");
export const fileURLToPath = fail("url.fileURLToPath"), spawn = fail("child_process.spawn"), tmpdir = fail("os.tmpdir"),
  createRequire = fail("module.createRequire");
