import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cli = path.join(import.meta.dir, "../otherskill.ts");
async function run(args: string[], home: string) {
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", cli, ...args, "--home", home],
    {
      cwd: home,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: home, OPENROUTER_API_KEY: "" },
    },
  );
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { out, err, code };
}
const home = () => fs.mkdtempSync(path.join(os.tmpdir(), "otherskill-err-"));

test("per-command help prints command usage, not the global help", async () => {
  const h = home();
  const cmds = [
    "setup",
    "find",
    "add",
    "list",
    "config",
    "update",
    "doctor",
    "search",
    "create",
    "classify",
    "tree",
  ];
  const results = await Promise.all(
    cmds.flatMap((cmd) =>
      ["--help", "-h"].map(async (flag) => ({
        cmd,
        r: await run([cmd, flag], h),
      })),
    ),
  );
  for (const { cmd, r } of results) {
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Usage: otherskill ${cmd}`);
    expect(r.out).not.toContain("Canonical commands:");
  }
  const find = (await run(["find", "--help"], h)).out;
  for (const flag of [
    "--max-skills",
    "--max-categories",
    "--timeout-ms",
    "--categories",
    "--model",
    "--config",
    "--home",
    "--agent",
  ])
    expect(find).toContain(flag);
  expect((await run(["--help"], h)).out).toContain("Canonical commands:");
}, 30000);
