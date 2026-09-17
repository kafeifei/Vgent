import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { createLocalSandboxSession, localProcessEnvironment, type LocalSandboxOptions } from "./session.js";

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const node = (source: string) => `${quote(process.execPath)} -e ${quote(source)}`;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(extra: Partial<LocalSandboxOptions> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "vgent-local-sandbox-"));
  const session = await createLocalSandboxSession({ id: "test-session", cwd, terminateGraceMs: 50, ...extra });
  onTestFinished(async () => {
    await session.destroy();
    await rm(cwd, { recursive: true, force: true });
  });
  return { cwd, session };
}

async function eventual<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await sleep(10);
  }
  throw new Error("Timed out waiting for owned test process.");
}

async function waitForFile(path: string): Promise<string> {
  return eventual(async () => {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  });
}

describe("createLocalSandboxSession", () => {
  it("implements file streams, binary/text encoding and inclusive line reads", async () => {
    const { session } = await fixture();
    expect(await session.readFile({ path: "missing" })).toBe(null);
    expect(await session.readBinaryFile({ path: "missing" })).toBe(null);
    expect(await session.readTextFile({ path: "missing" })).toBe(null);
    await session.writeTextFile({ path: "nested/text.txt", content: "one\r\ntwo\r\nthree\n" });
    expect(await session.readTextFile({ path: "nested/text.txt", startLine: 2, endLine: 2 })).toBe("two\r\n");
    expect(await session.readTextFile({ path: "nested/text.txt", startLine: 3, endLine: 100 })).toBe("three\n");
    expect(await session.readTextFile({ path: "nested/text.txt", startLine: 20 })).toBe("");
    await session.writeTextFile({ path: "unicode.txt", content: "中文", encoding: "utf16le" });
    expect(await session.readTextFile({ path: "unicode.txt", encoding: "utf16le" })).toBe("中文");
    await session.writeBinaryFile({ path: "nested/data.bin", content: new Uint8Array([0, 255, 128]) });
    expect([...((await session.readBinaryFile({ path: "nested/data.bin" })) ?? [])]).toEqual([0, 255, 128]);
    await session.writeFile({
      path: "stream.bin",
      content: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([8, 9]));
          controller.close();
        },
      }),
    });
    const stream = await session.readFile({ path: "stream.bin" });
    expect([...new Uint8Array(await new Response(stream).arrayBuffer())]).toEqual([8, 9]);
    await expect(session.readTextFile({ path: "unicode.txt", startLine: 0 })).rejects.toThrow(/line numbers/);
    // Encoding is validated before any I/O starts, so this throws synchronously.
    expect(() => session.writeTextFile({ path: "unicode.txt", content: "bad", encoding: "invalid" })).toThrow(
      /encoding/,
    );
  });

  it("runs with explicit cwd/environment and returns nonzero exit with both streams", async () => {
    const { session } = await fixture({ env: { VGENT_SESSION_VALUE: "session", HOME: "/isolated-test-home" } });
    await session.writeTextFile({ path: "nested/marker", content: "x" });
    const result = await session.run({
      command: node(
        "process.stdout.write(JSON.stringify({cwd:process.cwd(),home:process.env.HOME,value:process.env.VGENT_SESSION_VALUE})); process.stderr.write('failure'); process.exitCode=7",
      ),
      workingDirectory: "nested",
      env: { VGENT_SESSION_VALUE: "command" },
    });
    expect(result.exitCode).toBe(7);
    expect(JSON.parse(result.stdout)).toEqual({
      cwd: join(session.defaultWorkingDirectory, "nested"),
      home: "/isolated-test-home",
      value: "command",
    });
    expect(result.stderr).toBe("failure");
  });

  it("does not implicitly inherit host credentials or Node preload settings", () => {
    const environment = localProcessEnvironment({ HOME: "/deliberate", EXPLICIT_AUTH: "supplied-by-caller" });
    expect(environment.HOME).toBe("/deliberate");
    expect(environment.EXPLICIT_AUTH).toBe("supplied-by-caller");
    for (const key of [
      "OPENAI_API_KEY",
      "CODEX_HOME",
      "ANTHROPIC_API_KEY",
      "GITHUB_TOKEN",
      "SSH_AUTH_SOCK",
      "NODE_OPTIONS",
      "NODE_PATH",
    ]) {
      expect(environment[key], key).toBeUndefined();
    }
    expect(Object.keys(environment).sort()).toEqual(
      ["EXPLICIT_AUTH", "HOME", "LANG", "PATH", ...(process.env.TMPDIR ? ["TMPDIR"] : [])].sort(),
    );
  });

  it("prepends caller-supplied PATH extensions ahead of the default entries", () => {
    const environment = localProcessEnvironment({}, ["/opt/vgent/bin"]);
    expect(environment.PATH?.startsWith("/opt/vgent/bin:")).toBe(true);
    expect(environment.PATH).toContain("/usr/bin");
  });

  it("waits on abort for an owned process group including a TERM-resistant grandchild", async () => {
    const { cwd, session } = await fixture();
    const ready = join(cwd, "ready");
    const abort = new AbortController();
    const processHandle = await session.spawn({
      command: `${node(
        `require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)`,
      )} & wait`,
      abortSignal: abort.signal,
    });
    const grandchild = Number(await waitForFile(ready));
    const reason = new Error("deliberate-test-abort");
    abort.abort(reason);
    await expect(processHandle.wait()).rejects.toBe(reason);
    expect(() => process.kill(grandchild, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    await processHandle.kill();
  });

  it("reclaims background children after their shell exited and retains user files", async () => {
    const { cwd, session } = await fixture();
    const ready = join(cwd, "background-ready");
    const source = `require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid)); setInterval(()=>{},1000)`;
    const shell = await session.spawn({ command: `${node(source)} >/dev/null 2>&1 &` });
    await shell.wait();
    const backgroundPid = Number(await waitForFile(ready));
    await writeFile(join(cwd, "user-work.txt"), "keep this");
    await session.stop();
    await session.stop();
    await session.destroy();
    expect(() => process.kill(backgroundPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    expect(await readFile(join(cwd, "user-work.txt"), "utf8")).toBe("keep this");
    await expect(session.run({ command: "true" })).rejects.toThrow(/stopped/);
  });

  it("leaves an unrelated loopback server alive on stop", async () => {
    const { session } = await fixture();
    const server = createServer(socket => socket.end("unrelated"));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    onTestFinished(
      () => new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))),
    );
    await session.run({ command: "true" });
    await session.stop();
    expect(server.listening).toBe(true);
  });

  it("waits through a transient EPERM group probe instead of abandoning cleanup", async () => {
    const { cwd, session } = await fixture();
    const ready = join(cwd, "permission-probe-ready");
    const proc = await session.spawn({
      command: node(`require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`),
    });
    await waitForFile(ready);
    const originalKill = process.kill;
    let injected = false;
    process.kill = ((pid: number, signal?: string | number) => {
      if (pid === -proc.pid! && signal === 0 && !injected) {
        injected = true;
        throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      }
      return originalKill.call(process, pid, signal);
    }) as typeof process.kill;
    try {
      await session.stop();
    } finally {
      process.kill = originalKill;
    }
    expect(injected).toBe(true);
    expect(() => process.kill(proc.pid!, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  });

  it("registers loopback port endpoints and hides lifecycle from the restricted view", async () => {
    const { session } = await fixture({ ports: [4317] });
    expect(await session.getPortEndpoint({ port: 4317, protocol: "ws" })).toEqual({ url: "ws://127.0.0.1:4317" });
    await expect(session.getPortEndpoint({ port: 9999 })).rejects.toThrow(/not registered/);
    await session.setPorts!([9999]);
    expect(session.ports).toEqual([9999]);
    await expect(session.getPortEndpoint({ port: 4317 })).rejects.toThrow(/not registered/);
    await expect(session.setPorts!([80])).rejects.toThrow(/port/);
    expect(session.ports).toEqual([9999]);
    const restricted = session.restricted();
    for (const key of ["stop", "destroy", "setPorts", "getPortEndpoint", "setNetworkPolicy"]) {
      expect(key in restricted, key).toBe(false);
    }
    expect(await restricted.readTextFile({ path: "missing" })).toBe(null);
    expect("setNetworkPolicy" in session).toBe(false);
    expect("setRequestTransformations" in session).toBe(false);
  });

  it("lets trusted dynamic bridges register a high port, never a low or invalid one", async () => {
    const { session } = await fixture({ allowDynamicPorts: true });
    expect(await session.getPortUrl({ port: 49153, protocol: "ws" })).toBe("ws://127.0.0.1:49153");
    expect(session.ports).toEqual([49153]);
    for (const port of [0, 80, -1, 65536, NaN]) {
      await expect(session.getPortEndpoint({ port })).rejects.toThrow(/port/);
    }
    await session.stop();
    await expect(session.getPortEndpoint({ port: 49153 })).rejects.toThrow(/stopped/);
  });

  it("preserves existing files on abort and terminates a command that overflows run output", async () => {
    const { cwd, session } = await fixture({ maxOutputBytes: 100 });
    await writeFile(join(cwd, "user.txt"), "before");
    const abortSignal = AbortSignal.abort(new Error("already-aborted"));
    await expect(session.writeTextFile({ path: "user.txt", content: "after", abortSignal })).rejects.toThrow(
      /already-aborted/,
    );
    expect(await readFile(join(cwd, "user.txt"), "utf8")).toBe("before");
    await expect(session.spawn({ command: "true", abortSignal })).rejects.toThrow(/already-aborted/);
    await expect(
      session.run({ command: node("setInterval(()=>process.stdout.write('x'.repeat(1000)),5)") }),
    ).rejects.toThrow(/exceeded/);
    await session.stop();
  });
});

describe("loopback enforcement", () => {
  const listenSource = (host: string) =>
    node(
      `const s=require('node:net').createServer(); s.listen(0, ${JSON.stringify(host)}, () => { process.stdout.write(JSON.stringify(s.address())); s.close(); });`,
    );

  it("rewrites a wildcard bind to 127.0.0.1 inside the session", async () => {
    const { session } = await fixture();
    for (const host of ["0.0.0.0", "::"]) {
      const result = await session.run({ command: listenSource(host) });
      expect(result.stderr).toBe("");
      expect(result.exitCode, result.stdout).toBe(0);
      expect(JSON.parse(result.stdout).address).toBe("127.0.0.1");
    }
  });

  it("leaves the wildcard bind alone when loopbackOnly is disabled", async () => {
    const { session } = await fixture({ loopbackOnly: false });
    const result = await session.run({ command: listenSource("0.0.0.0") });
    expect(result.exitCode, result.stdout).toBe(0);
    expect(JSON.parse(result.stdout).address).toBe("0.0.0.0");
  });

  it("keeps a NODE_OPTIONS value supplied by the caller", async () => {
    const { session } = await fixture({ env: { NODE_OPTIONS: "--no-warnings" } });
    const result = await session.run({ command: node("process.stdout.write(process.env.NODE_OPTIONS ?? '')") });
    expect(result.stdout).toContain("--no-warnings");
    expect(result.stdout).toContain("--import=file://");
  });
});
