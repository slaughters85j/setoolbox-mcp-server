/**
 * Tests for the agent side of the folder exchange. A fake responder plays the app: it watches `in/`,
 * moves the request to `done/`, and writes a result to `out/`, so the tests need no running SEToolBox.
 *
 * Set SETOOLBOX_AGENT_FOLDER to run the live test at the bottom against the real app.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentFolder, ExchangeError, assertValidRunId, generateRunId, type AgentRequest } from "./exchange.js";

async function makeFolder(): Promise<AgentFolder> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "setoolbox-mcp-"));
  for (const sub of ["in", "out", "done", "schema"]) await fs.mkdir(path.join(root, sub));
  await fs.writeFile(path.join(root, "schema", "link_budget.json"), JSON.stringify({ tool: "link_budget", inputSchemaVersion: 1, fields: [], echo: [], notes: [] }));
  return new AgentFolder(root);
}

/** Waits for `in/<runId>.json`, archives it, and writes `payload` under the given result name. */
async function respond(folder: AgentFolder, runId: string, resultName: string, payload: Record<string, unknown>): Promise<void> {
  const requestPath = path.join(folder.inDir, `${runId}.json`);
  for (let i = 0; i < 100; i++) {
    try {
      await fs.access(requestPath);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  await fs.rename(requestPath, path.join(folder.doneDir, `${runId}.json`));
  const out = path.join(folder.outDir, resultName);
  await fs.writeFile(`${out}.tmp`, JSON.stringify(payload));
  await fs.rename(`${out}.tmp`, out);
}

const request = (runId: string): AgentRequest => ({ runId, tool: "link_budget", inputSchemaVersion: 1, inputs: { frequency: { value: 1, unit: "GHz" } } });

test("runId rule matches the app: charset, length, no leading dot", () => {
  assertValidRunId("2026-09-12T14-02-11-a7f3");
  assertValidRunId("a".repeat(64));
  for (const bad of ["", ".hidden", "has space", "a/b", "a".repeat(65)]) {
    assert.throws(() => assertValidRunId(bad), (e: unknown) => e instanceof ExchangeError && e.code === "invalid_run_id");
  }
  assertValidRunId(generateRunId());
});

test("submit writes .tmp then renames, and only in/ is touched", async () => {
  const folder = await makeFolder();
  const written = await folder.submit(request("r1"));
  assert.equal(written, path.join(folder.inDir, "r1.json"));
  assert.deepEqual(await fs.readdir(folder.inDir), ["r1.json"]);
  assert.deepEqual(await fs.readdir(folder.outDir), []);
  assert.deepEqual(await fs.readdir(folder.doneDir), []);
  assert.deepEqual(JSON.parse(await fs.readFile(written, "utf8")), request("r1"));
});

test("submit refuses a runId that already has a result, a queued request, or an archive", async () => {
  const folder = await makeFolder();
  await fs.writeFile(path.join(folder.outDir, "used.json"), "{}");
  await fs.writeFile(path.join(folder.outDir, "used2.json.error.json"), "{}");
  await fs.writeFile(path.join(folder.doneDir, "used3.json"), "{}");
  await folder.submit(request("queued"));
  for (const id of ["used", "used2", "used3", "queued"]) {
    await assert.rejects(folder.submit(request(id)), (e: unknown) => e instanceof ExchangeError && e.code === "duplicate_run_id");
  }
});

test("awaitResult returns the ok result file verbatim", async () => {
  const folder = await makeFolder();
  const payload = { status: "ok", answer: { value: 6.04 }, assurance: { level: "computed" }, result: [], warnings: [], run: { runId: "r2", tool: "link_budget" } };
  await folder.submit(request("r2"));
  const responder = respond(folder, "r2", "r2.json", payload);
  const result = await folder.awaitResult("r2", 5000, 20);
  await responder;
  assert.deepEqual(result, payload);
  assert.deepEqual(await fs.readdir(folder.doneDir), ["r2.json"]);
});

test("awaitResult also finds the .json.error.json form and passes it through untouched", async () => {
  const folder = await makeFolder();
  const payload = { status: "error", error: "unit_not_recognized", field: "frequency", received: "GHzz", allowed: ["Hz", "kHz", "MHz", "GHz"], nextAction: "Use an allowed unit." };
  await folder.submit(request("r3"));
  const responder = respond(folder, "r3", "r3.json.error.json", payload);
  const result = await folder.awaitResult("r3", 5000, 20);
  await responder;
  assert.deepEqual(result, payload);
  assert.equal(result.status, "error");
});

test("an undetermined result is returned as-is, not turned into an error", async () => {
  const folder = await makeFolder();
  const payload = { status: "undetermined", answer: { value: null, missingInputs: ["pixelPitchUm"], reason: "Missing form input." }, agentInstruction: "Report this quantity as not determined." };
  await folder.submit(request("r4"));
  const responder = respond(folder, "r4", "r4.json", payload);
  const result = await folder.awaitResult("r4", 5000, 20);
  await responder;
  assert.deepEqual(result, payload);
});

test("awaitResult times out with a timeout code and leaves the request queued", async () => {
  const folder = await makeFolder();
  await folder.submit(request("r5"));
  await assert.rejects(folder.awaitResult("r5", 100, 20), (e: unknown) => e instanceof ExchangeError && e.code === "timeout");
  assert.deepEqual(await fs.readdir(folder.inDir), ["r5.json"]);
  assert.equal(await folder.readResult("r5"), undefined);
});

test("a half-written result is not returned until it parses", async () => {
  const folder = await makeFolder();
  const out = path.join(folder.outDir, "r6.json");
  await fs.writeFile(out, '{"status": "ok", "answer": ');
  assert.equal(await folder.readResult("r6"), undefined);
  await fs.writeFile(out, '{"status": "ok"}');
  assert.deepEqual(await folder.readResult("r6"), { status: "ok" });
});

test("listRuns is newest first and reports analysisId only when persisted", async () => {
  const folder = await makeFolder();
  await fs.writeFile(path.join(folder.outDir, "old.json"), JSON.stringify({ status: "ok", run: { tool: "eoir", timestamp: "t1", analysisId: "A", persisted: false } }));
  await new Promise((r) => setTimeout(r, 15));
  await fs.writeFile(path.join(folder.outDir, "new.json.error.json"), JSON.stringify({ status: "error", error: "unknown_field" }));
  const runs = await folder.listRuns(10);
  assert.deepEqual(runs.map((r) => r.runId), ["new", "old"]);
  assert.equal(runs[0].error, "unknown_field");
  assert.equal(runs[1].analysisId, null);
  assert.equal((await folder.listRuns(1)).length, 1);
});

test("status reports queue depth, schema versions, and survives a missing folder", async () => {
  const folder = await makeFolder();
  await folder.submit(request("r7"));
  const status = await folder.status();
  assert.equal(status.folderPresent, true);
  assert.equal(status.queueDepth, 1);
  assert.equal(status.schemaVersions.link_budget, 1);
  assert.equal(status.lastResultAgeSeconds, null);
  const missing = await new AgentFolder(path.join(folder.root, "nope")).status();
  assert.equal(missing.folderPresent, false);
  assert.equal(missing.queueDepth, 0);
});

test("readSchema fails clearly when the app has not written the file", async () => {
  const folder = await makeFolder();
  await assert.rejects(folder.readSchema("eoir"), (e: unknown) => e instanceof ExchangeError && e.code === "schema_missing");
  assert.equal((await folder.readSchema("link_budget")).tool, "link_budget");
});

test("live: a real request through the running app", { skip: !process.env.SETOOLBOX_AGENT_FOLDER }, async () => {
  const folder = new AgentFolder(process.env.SETOOLBOX_AGENT_FOLDER!);
  const runId = `mcp-live-${generateRunId()}`;
  await folder.submit({
    runId,
    tool: "link_budget",
    inputSchemaVersion: 1,
    inputs: { frequency: { value: 2200, unit: "MHzz" } },
  });
  const result = await folder.awaitResult(runId, 30000, 500);
  assert.equal(result.status, "error");
  assert.equal(result.error, "unit_not_recognized");
  assert.ok(Array.isArray(result.allowed));
});

test("live: project.list through the running app", { skip: !process.env.SETOOLBOX_AGENT_FOLDER }, async () => {
  const folder = new AgentFolder(process.env.SETOOLBOX_AGENT_FOLDER!);
  const runId = `mcp-live-list-${generateRunId()}`;
  await folder.submit({ runId, operation: "project.list", inputSchemaVersion: 1 });
  const result = await folder.awaitResult(runId, 30000, 500);
  assert.equal(result.status, "ok");
  const data = result.data as { projects: { name: string; counts: Record<string, number> }[] };
  assert.ok(Array.isArray(data.projects));
  assert.ok(data.projects.every((p) => typeof p.name === "string" && typeof p.counts.linkBudgetAnalyses === "number"));
});
