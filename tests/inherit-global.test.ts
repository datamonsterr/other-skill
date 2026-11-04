import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoRoot } from "../lib/otherskill/setup";
import {
  loadConfig,
  paidModelsAllowed,
  routingView,
  withRoutingOverrides,
} from "../lib/otherskill/config";
import {
  createSkill,
  discoverBank,
  installLocal,
} from "../lib/otherskill/bank";
import {
  Decisions,
  route,
  type DecisionRequest,
} from "../lib/otherskill/routing";

function answer(request: DecisionRequest, weights?: Record<string, number>) {
  const keys = Object.keys(request.questions.selection.criteria);
  const probabilities =
    weights ??
    Object.fromEntries(keys.map((key, index) => [key, index === 0 ? 1 : 0]));
  const choice = Object.keys(probabilities).sort(
    (a, b) => (probabilities[b] ?? 0) - (probabilities[a] ?? 0),
  )[0];
  return new Response(
    JSON.stringify({
      answers: {
        selection: { type: "choice", choice, probabilities, confidence: 0.9 },
      },
    }),
    { status: 200 },
  );
}

const cats = {
  a: { id: "alpha", description: "Project alpha" },
  b: { id: "beta", description: "Project beta" },
  g: { id: "gamma", description: "Global gamma" },
  bg: { id: "beta", description: "Global beta" },
};
function env(
  project: Record<string, unknown> = {},
  global: Record<string, unknown> = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "otherskill-inherit-"));
  const home = path.join(root, "home"),
    cwd = path.join(root, "project");
  const gfile = path.join(home, ".config/otherskill/otherskill.config.json");
  const pfile = path.join(cwd, "otherskill.config.json");
  fs.mkdirSync(path.dirname(gfile), { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(
    gfile,
    JSON.stringify({
      bankPath: "~/.local/share/otherskill/bank",
      categories: [cats.g, cats.bg],
      ...global,
    }),
  );
  fs.writeFileSync(
    pfile,
    JSON.stringify({
      bankPath: ".otherskill/bank",
      scope: "project",
      categories: [cats.a, cats.b],
      ...project,
    }),
  );
  const load = (extra = {}) => loadConfig({ home, cwd, ...extra });
  let n = 0;
  const skill = (name: string) =>
    createSkill(
      path.join(root, "src", `${name}-${n++}`),
      name,
      `Description of ${name}`,
      "body",
    );
  const put = (
    scope: "project" | "global",
    name: string,
    ids: string[],
    source?: string,
  ) => {
    const config = scope === "project" ? load() : load({ scope: "global" });
    return installLocal(config, skill(name), ids, {
      source: source ?? `file://${name}`,
    });
  };
  return {
    root,
    home,
    cwd,
    gfile,
    pfile,
    load,
    put,
    done: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
async function cli(e: ReturnType<typeof env>, args: string[]) {
  const child = Bun.spawn(
    [
      process.execPath,
      path.join(repoRoot, "otherskill.ts"),
      ...args,
      "--home",
      e.home,
      "--cwd",
      e.cwd,
    ],
    {
      cwd: e.cwd,
      env: {
        ...process.env,
        OPENROUTER_API_KEY: "",
        OTHERSKILL_CONFIG: "",
        OTHERSKILL_HOME: e.home,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { out, err, code };
}

test("discover and route see categories and skills of both banks as one pool", async () => {
  const e = env();
  try {
    e.put("project", "ps", ["alpha"]);
    e.put("global", "gs", ["gamma"]);
    const config = { ...e.load(), allowPaidModels: true };
    expect(config.inherited?.categories.map((c) => c.id)).toEqual([
      "gamma",
      "beta",
    ]);
    expect(
      discoverBank(config)
        .map((s) => s.name)
        .sort(),
    ).toEqual(["gs", "ps"]);
    const requests: DecisionRequest[] = [];
    const fetchFn = async (_u: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as DecisionRequest;
      requests.push(request);
      return request.state.stage === "categories"
        ? answer(request, { c0: 0.5, c2: 0.5, c1: 0, none: 0 })
        : answer(request);
    };
    const result = await route(
      config,
      "x",
      new Decisions(config, { apiKey: "k", fetchFn }),
    );
    expect(requests[0]?.state.categories?.map((c) => c.id)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(result.status).toBe("ok");
    expect(result.selected.map((s) => s.name).sort()).toEqual(["gs", "ps"]);
  } finally {
    e.done();
  }
});

test("same logical skill in both banks yields one instance with the project path; category collision keeps project description", () => {
  const e = env();
  try {
    e.put("project", "dup", ["beta"], "file://same");
    e.put("global", "dup", ["beta"], "file://same");
    const config = e.load();
    const found = discoverBank(config).filter((s) => s.name === "dup");
    expect(found).toHaveLength(1);
    expect(found[0]?.path.startsWith(config.bankPath)).toBe(true);
    expect(
      routingView(config).categories.find((c) => c.id === "beta")?.description,
    ).toBe("Project beta");
  } finally {
    e.done();
  }
});

test("enabledCategories union semantics and final --categories override", () => {
  const e = env();
  try {
    expect(routingView(e.load()).enabledCategories).toBeUndefined();
    fs.writeFileSync(
      e.pfile,
      JSON.stringify({
        bankPath: ".otherskill/bank",
        categories: [cats.a, cats.b],
        enabledCategories: ["beta"],
      }),
    );
    expect(routingView(e.load()).enabledCategories).toEqual(["beta", "gamma"]);
    fs.writeFileSync(
      e.gfile,
      JSON.stringify({
        bankPath: "~/.local/share/otherskill/bank",
        categories: [cats.g, cats.bg],
        enabledCategories: ["gamma"],
      }),
    );
    expect(routingView(e.load()).enabledCategories).toEqual(["beta", "gamma"]);
    const overridden = withRoutingOverrides(e.load(), {
      categories: ["gamma"],
    });
    expect(routingView(overridden).enabledCategories).toEqual(["gamma"]);
    expect(() =>
      withRoutingOverrides(e.load(), { categories: ["nope"] }),
    ).toThrow();
  } finally {
    e.done();
  }
});

test("inheritGlobal false, global scope and explicit global file do not inherit; explicit project file does", () => {
  const e = env();
  try {
    expect(e.load({ scope: "global" }).inherited).toBeUndefined();
    expect(e.load({ configPath: e.gfile }).inherited).toBeUndefined();
    expect(
      e.load({ configPath: e.pfile, cwd: e.root }).inherited,
    ).toBeDefined();
    fs.writeFileSync(
      e.pfile,
      JSON.stringify({
        bankPath: ".otherskill/bank",
        categories: [cats.a],
        inheritGlobal: false,
      }),
    );
    const config = e.load();
    expect(config.inherited).toBeUndefined();
    expect(routingView(config).categories).toEqual([cats.a]);
    expect(routingView(config).banks).toEqual([config.bankPath]);
  } finally {
    e.done();
  }
});

test("malformed global config fails with the fixed error", () => {
  const e = env();
  try {
    fs.writeFileSync(e.gfile, "{");
    expect(() => e.load()).toThrow("cannot read valid otherskill.config.json");
  } finally {
    e.done();
  }
});

test("too many merged categories throw", () => {
  const e = env({ limits: { maxCandidates: 2 } });
  try {
    expect(() => routingView(e.load())).toThrow("too many categories");
  } finally {
    e.done();
  }
});

test("config set never writes inherited data; add installs only into the project bank", async () => {
  const e = env();
  try {
    const set = await cli(e, [
      "config",
      "set",
      "model",
      "inception/mercury-decide:free",
    ]);
    expect(set.err).toBe("");
    expect(set.code).toBe(0);
    const written = fs.readFileSync(e.pfile, "utf8");
    expect(written).not.toContain("gamma");
    expect(written).not.toContain("inherited");
    expect(written).not.toContain(".local/share");
    const src = path.join(e.root, "src", "added");
    createSkill(src, "added", "Added skill", "body");
    const result = await cli(e, ["add", src, "--category", "gamma"]);
    expect(result.code).toBe(0);
    const config = e.load();
    expect(fs.existsSync(path.join(config.bankPath, "gamma"))).toBe(true);
    expect(
      fs.existsSync(path.join(e.home, ".local/share/otherskill/bank/gamma")),
    ).toBe(false);
    const doctor = JSON.parse((await cli(e, ["doctor"])).out);
    expect(doctor.inheritedConfigPath).toBe(e.gfile);
    expect(doctor.instances).toBe(1);
  } finally {
    e.done();
  }
});

test("a project config inherits the global paid-model opt-in, and doctor reports access", async () => {
  const gated = env();
  const allowed = env({}, { allowPaidModels: true });
  try {
    expect(paidModelsAllowed(gated.load())).toBe(false);
    expect(paidModelsAllowed(allowed.load())).toBe(true);
    expect(paidModelsAllowed(allowed.load({ scope: "global" }))).toBe(true);
    const doctor = await cli(gated, ["doctor"]);
    expect(JSON.parse(doctor.out).modelAccess).toBe(
      "paid_model_requires_opt_in",
    );
    const ok = await cli(allowed, ["doctor"]);
    expect(JSON.parse(ok.out)).toMatchObject({
      model: "perplexity/pplx-decider-flash-v1.2",
      allowPaidModels: true,
      modelAccess: "ok",
    });
  } finally {
    gated.done();
    allowed.done();
  }
});
