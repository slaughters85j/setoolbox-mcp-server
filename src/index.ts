#!/usr/bin/env node
/**
 * setoolbox-mcp-server: eight tools over the SEToolBox agent run folder exchange, six for calculations and two for reading projects.
 *
 * Transport is stdio only. Configuration comes from `SETOOLBOX_AGENT_FOLDER` (or `--folder <path>`),
 * `SETOOLBOX_AGENT_TIMEOUT_S` (default 60), and `SETOOLBOX_AGENT_POLL_MS` (default 1000).
 * Result files are returned verbatim; the server never summarizes, reorders, or drops keys.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  AgentFolder,
  ExchangeError,
  RUN_ID_PATTERN,
  TOOL_DESCRIPTIONS,
  TOOL_NAMES,
  generateRunId,
  type AgentReadRequest,
  type AgentRequest,
} from "./exchange.js";

const SERVER_VERSION = "0.2.0";
const INPUT_SCHEMA_VERSION = 1;

/** Resolves the folder path from `--folder` or the environment. Exits with a clear message otherwise. */
function resolveFolder(argv: string[]): string {
  const flag = argv.indexOf("--folder");
  const fromFlag = flag >= 0 ? argv[flag + 1] : undefined;
  const folder = fromFlag ?? process.env.SETOOLBOX_AGENT_FOLDER;
  if (!folder) {
    console.error("ERROR: set SETOOLBOX_AGENT_FOLDER to the agent runs folder shown in SEToolBox Settings, or pass --folder <path>.");
    process.exit(1);
  }
  return folder;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const folder = new AgentFolder(resolveFolder(process.argv.slice(2)));
const defaultTimeoutMs = positiveNumber(process.env.SETOOLBOX_AGENT_TIMEOUT_S, 60) * 1000;
const pollMs = positiveNumber(process.env.SETOOLBOX_AGENT_POLL_MS, 1000);

type ToolResponse = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

/** JSON text plus structured content, so both kinds of client see the same object. */
function jsonResponse(payload: Record<string, unknown>): ToolResponse {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
}

/** Server-side failures become MCP tool errors; app error results are never routed here. */
function errorResponse(error: unknown): ToolResponse {
  const message = error instanceof ExchangeError ? `${error.code}: ${error.message}` : `unexpected: ${error instanceof Error ? error.message : String(error)}`;
  return { isError: true, content: [{ type: "text", text: message }] };
}

async function guarded(work: () => Promise<Record<string, unknown>>): Promise<ToolResponse> {
  try {
    return jsonResponse(await work());
  } catch (error) {
    return errorResponse(error);
  }
}

const toolNameSchema = z.enum(TOOL_NAMES).describe("One of link_budget, radar_range, eoir.");
const runIdSchema = z.string().regex(RUN_ID_PATTERN, "1 to 64 characters of [A-Za-z0-9._-], no leading dot").describe("The request's runId.");

const server = new McpServer({ name: "setoolbox-mcp-server", version: SERVER_VERSION });

server.registerTool(
  "setoolbox_list_tools",
  {
    title: "List SEToolBox calculation tools",
    description: `List the three SEToolBox calculation tools an agent can run through the folder exchange, with one-line descriptions and the input schema version each one currently publishes.

Returns: { "tools": [{ "name", "description", "inputSchemaVersion" | null }] }. A null version means the app has not written that schema file yet (the app must be running with agent runs allowed).`,
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () =>
    guarded(async () => {
      const status = await folder.status();
      return {
        tools: TOOL_NAMES.map((name) => ({ name, description: TOOL_DESCRIPTIONS[name], inputSchemaVersion: status.schemaVersions[name] ?? null })),
      };
    }),
);

server.registerTool(
  "setoolbox_get_schema",
  {
    title: "Get a tool's input schema",
    description: `Return schema/<tool>.json verbatim: the blank input form for one tool. Read it before every setoolbox_run and use only the field names and units it lists.

Each entry in "fields" has name, label, symbol, kind (quantity | enum | integer | boolean | text | option), allowed (units for a quantity, values for an enum or option), required, requiredWhen, and when sourced min, max, exclusiveMin, exclusiveMax, rangeSource. "echo" lists the derived symbols every result reports. "notes" are the app's own rules for that tool; follow them.

Never cache this across app launches; the app rewrites the file when its schema version changes.`,
    inputSchema: { tool: toolNameSchema },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ tool }) => guarded(() => folder.readSchema(tool)),
);

server.registerTool(
  "setoolbox_run",
  {
    title: "Run a SEToolBox calculation",
    description: `Submit one calculation request to SEToolBox and wait for its result. The app does the math; this tool only writes the request file and reads the result file back verbatim.

Args:
  - tool: link_budget | radar_range | eoir
  - inputs: object keyed by schema field name. Every physical quantity is { "value": number, "unit": "<one of the field's allowed units>" }. Enum, option, and text fields are strings; integer and boolean fields are plain. Bare numbers for quantities are rejected by the app. Unknown field names are rejected. Omit what the user did not give you; the app never fills a required field from a default.
  - save (optional): { "projectName", "analysisName" }. Present means the app creates one new marked analysis in that project (created if absent). Absent means compute only.
  - displayUnits (optional): { "<field>": "<unit>" } to choose the unit used for "value" in the result; "siValue" is always SI.
  - runId (optional): supplied by you, or generated as <UTC timestamp>-<4 hex>. Must be new; the app never overwrites a result.
  - timeoutSeconds (optional): how long to wait for the result. Default from SETOOLBOX_AGENT_TIMEOUT_S (60).

Returns the result file as JSON, unchanged. Top-level keys in order: status, answer, assurance, result, warnings, run, then agentInstruction or the error fields.
  - status "ok": answer.value/unit in display units, answer.siValue/siUnit in SI; result[] echoes every derived quantity and every supplied input (state entered or pinned). Compare runs on siValue.
  - status "undetermined": answer.value is null, answer.missingInputs names what to supply, and agentInstruction says to report the quantity as not determined. This is a normal outcome, not an error.
  - status "error": error code plus field, received, allowed (when a finite set exists), and nextAction. Fix the request and resubmit with a new runId.
  - assurance is never empty. link_budget and radar_range: level "computed", citations false. eoir: level "traced", with citation and determinacy on each quantity.

A tool error (isError) means the exchange itself failed: folder missing, bad or duplicate runId, or timeout. On timeout the request stays queued; the app processes it when it is running and in front, and setoolbox_get_result returns it later. Never resubmit under the same runId.`,
    inputSchema: {
      tool: toolNameSchema,
      inputs: z.record(z.string(), z.unknown()).describe("Field name to value, per schema/<tool>.json."),
      save: z.object({ projectName: z.string().min(1), analysisName: z.string().min(1) }).strict().optional().describe("Create one saved analysis."),
      displayUnits: z.record(z.string(), z.string()).optional().describe("Field name to display unit."),
      runId: runIdSchema.optional(),
      timeoutSeconds: z.number().positive().max(3600).optional().describe("Seconds to wait for the result."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ tool, inputs, save, displayUnits, runId, timeoutSeconds }) =>
    guarded(async () => {
      const request: AgentRequest = { runId: runId ?? generateRunId(), tool, inputSchemaVersion: INPUT_SCHEMA_VERSION, inputs };
      if (save) request.save = save;
      if (displayUnits) request.displayUnits = displayUnits;
      await folder.submit(request);
      return folder.awaitResult(request.runId, (timeoutSeconds ?? defaultTimeoutMs / 1000) * 1000, pollMs);
    }),
);

/** Submits a read request and waits for its result, the same way a run does. */
async function read(request: Omit<AgentReadRequest, "runId" | "inputSchemaVersion">, timeoutSeconds?: number): Promise<Record<string, unknown>> {
  const full: AgentReadRequest = { runId: generateRunId(), inputSchemaVersion: INPUT_SCHEMA_VERSION, ...request };
  await folder.submit(full);
  return folder.awaitResult(full.runId, (timeoutSeconds ?? defaultTimeoutMs / 1000) * 1000, pollMs);
}

const readTimeoutSchema = z.number().positive().max(3600).optional().describe("Seconds to wait for the result.");

server.registerTool(
  "setoolbox_list_projects",
  {
    title: "List SEToolBox projects",
    description: `List every project in the user's SEToolBox store: id, name, dateCreated, lastModified, and counts of records per tool family (tpmDataList, statisticalTools, massBudgetProjects, budgetTools, spacePowerBudgetProjects, nonSpacePowerBudgetProjects, linkBudgetAnalyses, radarRangeAnalyses, eoirAnalyses).

Goes through the same folder exchange as a run, so the app must be running with agent runs allowed. Returns the result file verbatim; the payload is under "data.projects". Nothing in the app changes.`,
    inputSchema: { timeoutSeconds: readTimeoutSchema },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ timeoutSeconds }) => guarded(() => read({ operation: "project.list" }, timeoutSeconds)),
);

server.registerTool(
  "setoolbox_read_project",
  {
    title: "Read one SEToolBox project",
    description: `Read one project from the user's SEToolBox store, by projectId or by exact projectName (never both). Use it to review a study, cross-check values between tools, or find an analysis id.

detail "summary" (default): the project header plus "records", one row per record with family, id, name, and for Link Budget, Radar Range, and EO/IR analyses also lastModified and isAgentRun.
detail "full": the project's complete export JSON, the same bytes the app's Export command writes, with every stored input and result of every record. Large; ask for it when you need values.

Family names in the summary are the keys of the full form, so a summary row can be found again in the full read. Returns the result file verbatim; the payload is under "data". Nothing in the app changes. A wrong name yields status "error" with project_not_found; a name shared by two projects yields ambiguous_project, so select by projectId from setoolbox_list_projects.`,
    inputSchema: {
      projectId: z.string().uuid().optional().describe("Project id from setoolbox_list_projects."),
      projectName: z.string().min(1).optional().describe("Exact project name."),
      detail: z.enum(["summary", "full"]).default("summary"),
      timeoutSeconds: readTimeoutSchema,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ projectId, projectName, detail, timeoutSeconds }) =>
    guarded(async () => {
      if ((projectId === undefined) === (projectName === undefined)) {
        throw new ExchangeError("Send exactly one of projectId or projectName.", "invalid_selector");
      }
      const request: Omit<AgentReadRequest, "runId" | "inputSchemaVersion"> = { operation: "project.read", detail };
      if (projectId !== undefined) request.projectId = projectId;
      if (projectName !== undefined) request.projectName = projectName;
      return read(request, timeoutSeconds);
    }),
);

server.registerTool(
  "setoolbox_get_result",
  {
    title: "Get a result by runId",
    description: `Return the result file for a runId, verbatim, if one exists in out/. Use it after a setoolbox_run timeout, or for a run submitted by another session. Returns { "found": false, "queued": boolean } when no result has appeared; queued true means the request is still waiting in in/ for the app.`,
    inputSchema: { runId: runIdSchema },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ runId }) =>
    guarded(async () => {
      const result = await folder.readResult(runId);
      if (result !== undefined) return result;
      return { found: false, queued: await folder.isQueued(runId), runId };
    }),
);

server.registerTool(
  "setoolbox_list_runs",
  {
    title: "List recent runs",
    description: `List recent results in out/, newest first: runId, file name, tool, status, timestamp, analysisId (when the app saved an analysis), and the error code for error results. Default limit 20, maximum 200. Read-only audit view.`,
    inputSchema: { limit: z.number().int().min(1).max(200).default(20).describe("Maximum rows.") },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ limit }) =>
    guarded(async () => {
      const runs = await folder.listRuns(limit);
      return { count: runs.length, runs };
    }),
);

server.registerTool(
  "setoolbox_status",
  {
    title: "Check the exchange folder",
    description: `Report whether the agent folder exists and is prepared, the schema version of each tool, how many requests wait in in/ (queueDepth), and the age in seconds of the newest result. Use it to tell the user "SEToolBox is not running" when runs time out: a queueDepth above zero for longer than a few seconds means the app is closed, agent runs are off, or the iPad app is not in the foreground. Never throws for a missing folder; read folderPresent.`,
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => guarded(async () => ({ ...(await folder.status()), serverVersion: SERVER_VERSION, defaultTimeoutSeconds: defaultTimeoutMs / 1000, pollMs })),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`setoolbox-mcp-server ${SERVER_VERSION} on stdio, folder ${folder.root}`);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
