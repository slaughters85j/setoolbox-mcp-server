/**
 * Talks to the built server over stdio with the SDK client, the way Claude Code does. A fake responder
 * plays the app. Run after `tsc`; this file imports nothing from the server itself.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");

async function makeFolder(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "setoolbox-mcp-server-"));
  for (const sub of ["in", "out", "done", "schema"]) await fs.mkdir(path.join(root, sub));
  await fs.writeFile(path.join(root, "schema", "radar_range.json"), JSON.stringify({ tool: "radar_range", inputSchemaVersion: 1, fields: [{ name: "frequency" }], echo: ["Rmax"], notes: [] }));
  return root;
}

/** Answers the next request in `in/` with `payload`. */
async function respondOnce(root: string, payload: Record<string, unknown>): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const names = (await fs.readdir(path.join(root, "in"))).filter((n) => n.endsWith(".json"));
    if (names.length > 0) {
      const runId = names[0].replace(/\.json$/, "");
      await fs.rename(path.join(root, "in", names[0]), path.join(root, "done", names[0]));
      const out = path.join(root, "out", `${runId}.json`);
      await fs.writeFile(`${out}.tmp`, JSON.stringify({ ...payload, run: { runId, tool: "radar_range" } }));
      await fs.rename(`${out}.tmp`, out);
      return runId;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("no request appeared");
}

async function connect(root: string): Promise<Client> {
  const client = new Client({ name: "server-test", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: { ...process.env, SETOOLBOX_AGENT_FOLDER: root, SETOOLBOX_AGENT_POLL_MS: "25", SETOOLBOX_AGENT_TIMEOUT_S: "5" },
    stderr: "ignore",
  });
  await client.connect(transport);
  return client;
}

function structured(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

test("the server exposes the eight tools", async () => {
  const client = await connect(await makeFolder());
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["setoolbox_get_result", "setoolbox_get_schema", "setoolbox_list_projects", "setoolbox_list_runs", "setoolbox_list_tools", "setoolbox_read_project", "setoolbox_run", "setoolbox_status"]);
  await client.close();
});

test("read tools write an operation request and return the data payload verbatim", async () => {
  const root = await makeFolder();
  const client = await connect(root);
  const listPayload = { status: "ok", assurance: { level: "stored" }, result: [], warnings: [], data: { projects: [{ id: "A", name: "Study" }] } };
  const listResponder = respondOnce(root, listPayload);
  const list = structured(await client.callTool({ name: "setoolbox_list_projects", arguments: {} }));
  const listRunId = await listResponder;
  assert.deepEqual(list.data, listPayload.data);
  const listRequest = JSON.parse(await fs.readFile(path.join(root, "done", `${listRunId}.json`), "utf8"));
  assert.deepEqual(listRequest, { runId: listRunId, inputSchemaVersion: 1, operation: "project.list" });
  const readResponder = respondOnce(root, { status: "ok", data: { name: "Study", records: [] } });
  const project = structured(await client.callTool({ name: "setoolbox_read_project", arguments: { projectName: "Study", detail: "full" } }));
  const readRunId = await readResponder;
  assert.deepEqual(project.data, { name: "Study", records: [] });
  const readRequest = JSON.parse(await fs.readFile(path.join(root, "done", `${readRunId}.json`), "utf8"));
  assert.deepEqual(readRequest, { runId: readRunId, inputSchemaVersion: 1, operation: "project.read", detail: "full", projectName: "Study" });
  const both = await client.callTool({ name: "setoolbox_read_project", arguments: { projectName: "Study", projectId: "3fa85f64-5717-4562-b3fc-2c963f66afa6" } });
  assert.equal(both.isError, true);
  assert.deepEqual(await fs.readdir(path.join(root, "in")), []);
  await client.close();
});

test("list_tools, get_schema, and status read the folder", async () => {
  const root = await makeFolder();
  const client = await connect(root);
  const tools = structured(await client.callTool({ name: "setoolbox_list_tools", arguments: {} })).tools as { name: string; inputSchemaVersion: number | null }[];
  assert.equal(tools.find((t) => t.name === "radar_range")?.inputSchemaVersion, 1);
  assert.equal(tools.find((t) => t.name === "eoir")?.inputSchemaVersion, null);
  const schema = structured(await client.callTool({ name: "setoolbox_get_schema", arguments: { tool: "radar_range" } }));
  assert.deepEqual(schema.echo, ["Rmax"]);
  const missing = await client.callTool({ name: "setoolbox_get_schema", arguments: { tool: "eoir" } });
  assert.equal(missing.isError, true);
  const status = structured(await client.callTool({ name: "setoolbox_status", arguments: {} }));
  assert.equal(status.folderPresent, true);
  assert.equal(status.queueDepth, 0);
  await client.close();
});

test("run writes a request, returns the result verbatim, and list_runs sees it", async () => {
  const root = await makeFolder();
  const client = await connect(root);
  const payload = { status: "ok", answer: { symbol: "Rmax", value: 123.4, unit: "km", siValue: 123400, siUnit: "m", state: "derived" }, assurance: { level: "computed", citations: false, determinacy: false }, result: [], warnings: [] };
  const responder = respondOnce(root, payload);
  const run = await client.callTool({ name: "setoolbox_run", arguments: { tool: "radar_range", inputs: { frequency: { value: 1.3, unit: "GHz" } }, save: { projectName: "P", analysisName: "A" } } });
  const runId = await responder;
  assert.notEqual(run.isError, true);
  const result = structured(run);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.answer, payload.answer);
  assert.equal((result.run as { runId: string }).runId, runId);
  const archived = JSON.parse(await fs.readFile(path.join(root, "done", `${runId}.json`), "utf8"));
  assert.deepEqual(archived.save, { projectName: "P", analysisName: "A" });
  assert.equal(archived.inputSchemaVersion, 1);
  const runs = structured(await client.callTool({ name: "setoolbox_list_runs", arguments: {} }));
  assert.equal(runs.count, 1);
  assert.equal((runs.runs as { runId: string }[])[0].runId, runId);
  const again = structured(await client.callTool({ name: "setoolbox_get_result", arguments: { runId } }));
  assert.deepEqual(again.answer, payload.answer);
  await client.close();
});

test("run times out as a tool error, and get_result reports the request as queued", async () => {
  const root = await makeFolder();
  const client = await connect(root);
  const run = await client.callTool({ name: "setoolbox_run", arguments: { tool: "radar_range", inputs: {}, runId: "slow", timeoutSeconds: 0.2 } });
  assert.equal(run.isError, true);
  assert.match((run.content as { text: string }[])[0].text, /^timeout:/);
  const pending = structured(await client.callTool({ name: "setoolbox_get_result", arguments: { runId: "slow" } }));
  assert.deepEqual(pending, { found: false, queued: true, runId: "slow" });
  const duplicate = await client.callTool({ name: "setoolbox_run", arguments: { tool: "radar_range", inputs: {}, runId: "slow" } });
  assert.match((duplicate.content as { text: string }[])[0].text, /^duplicate_run_id:/);
  await client.close();
});

test("a bad runId is rejected before anything is written", async () => {
  const root = await makeFolder();
  const client = await connect(root);
  const bad = await client.callTool({ name: "setoolbox_run", arguments: { tool: "radar_range", inputs: {}, runId: ".hidden" } });
  assert.equal(bad.isError, true);
  assert.deepEqual(await fs.readdir(path.join(root, "in")), []);
  await client.close();
});
