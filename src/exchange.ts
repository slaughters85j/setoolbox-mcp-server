/**
 * The SEToolBox agent run folder exchange, as seen from the agent side.
 *
 * The app owns the folder. This module only ever writes `in/<runId>.json.tmp` and renames it to
 * `in/<runId>.json`. It reads `out/` and `schema/`. It never touches `done/`, never deletes, and
 * never rewrites a result. The protocol is described in the README.
 */

import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

/** Tool names the app accepts in a request. */
export const TOOL_NAMES = ["link_budget", "radar_range", "eoir"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** One-line descriptions for `setoolbox_list_tools`; the schema file carries the detail. */
export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  link_budget: "RF link budget: EIRP, path loss, received power, C/N0, Eb/N0, link margin.",
  radar_range: "Radar range equation: maximum detection range, or the peak power, gain, or RCS needed to reach a given range.",
  eoir: "EO/IR imaging chain: GSD, IFOV, swath, signal electrons, and SNR, with ledger citations.",
};

/** The app's own rule: 1 to 64 characters of `[A-Za-z0-9._-]`, no leading dot. */
export const RUN_ID_PATTERN = /^(?!\.)[A-Za-z0-9._-]{1,64}$/;

/** A calculation request as the app expects it on disk. `inputs` is validated by the app, not here. */
export interface AgentRequest {
  runId: string;
  tool: ToolName;
  inputSchemaVersion: number;
  inputs: Record<string, unknown>;
  save?: { projectName: string; analysisName: string };
  displayUnits?: Record<string, string>;
}

/** A read request. The app writes nothing and recomputes nothing for these. */
export interface AgentReadRequest {
  runId: string;
  operation: "project.list" | "project.read";
  inputSchemaVersion: number;
  projectId?: string;
  projectName?: string;
  detail?: "summary" | "full";
}

/** One sweep axis: explicit values, or start, stop, and step, always with a unit. */
export type SweepAxis = { unit: string; values: number[] } | { unit: string; start: number; stop: number; step: number };

/** A length with its unit. */
export interface Length {
  value: number;
  unit: string;
}

/** An EO/IR sweep export request. The app writes workbooks under out/exports/<runId>/ and changes nothing in its store. */
export interface AgentExportRequest {
  runId: string;
  operation: "eoir.sweepExport";
  inputSchemaVersion: number;
  projectId?: string;
  projectName?: string;
  analysisIds?: string[];
  heights: SweepAxis;
  ranges: SweepAxis;
  metrics: string[];
  target?: { width: Length; height: Length; geometry: string; label?: string; photonRadiance?: Length };
}

/** A result file. Only the keys this module reads are typed; everything is passed through verbatim. */
export interface AgentResult {
  status: "ok" | "undetermined" | "error";
  run?: { runId?: string; tool?: string; timestamp?: string; analysisId?: string | null; persisted?: boolean };
  error?: string;
  [key: string]: unknown;
}

/** A recent-runs row. */
export interface RunSummary {
  runId: string;
  file: string;
  tool: string | null;
  status: string;
  timestamp: string | null;
  analysisId: string | null;
  error: string | null;
}

/** What `setoolbox_status` reports. */
export interface FolderStatus {
  folder: string;
  folderPresent: boolean;
  subfolders: Record<"in" | "out" | "done" | "schema", boolean>;
  schemaVersions: Partial<Record<ToolName, number>>;
  queueDepth: number;
  lastResultAgeSeconds: number | null;
}

/** Thrown for failures on the agent side of the exchange: bad folder, bad runId, timeout. */
export class ExchangeError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "ExchangeError";
  }
}

/** Reads a JSON file, or returns undefined when the file is absent or not yet complete. */
async function readJsonIfComplete<T>(file: string): Promise<T | undefined> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Validates a runId against the app's rule. */
export function assertValidRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new ExchangeError(
      `runId "${runId}" is not valid. Use 1 to 64 characters of letters, digits, dot, underscore, or hyphen, with no leading dot.`,
      "invalid_run_id",
    );
  }
}

/** A fresh runId: UTC timestamp with colons replaced, plus four hex characters. */
export function generateRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "").replace(/[:]/g, "-");
  return `${stamp}-${randomBytes(2).toString("hex")}`;
}

/** One watched folder. */
export class AgentFolder {
  readonly inDir: string;
  readonly outDir: string;
  readonly doneDir: string;
  readonly schemaDir: string;

  constructor(readonly root: string) {
    this.inDir = path.join(root, "in");
    this.outDir = path.join(root, "out");
    this.doneDir = path.join(root, "done");
    this.schemaDir = path.join(root, "schema");
  }

  /** The result file names the app may write for a runId, in the order they are checked. */
  resultCandidates(runId: string): string[] {
    return [path.join(this.outDir, `${runId}.json`), path.join(this.outDir, `${runId}.json.error.json`)];
  }

  /** Throws unless the folder and its `in/` and `out/` subfolders exist. */
  async assertReady(): Promise<void> {
    if (!(await exists(this.root))) {
      throw new ExchangeError(
        `Agent folder not found: ${this.root}. Choose the folder in SEToolBox Settings and set SETOOLBOX_AGENT_FOLDER to the path shown there.`,
        "folder_missing",
      );
    }
    for (const dir of [this.inDir, this.outDir]) {
      if (!(await exists(dir))) {
        throw new ExchangeError(
          `${dir} does not exist. SEToolBox creates in/, out/, done/, and schema/ when the folder is chosen and agent runs are allowed.`,
          "folder_not_prepared",
        );
      }
    }
  }

  /** Reads `schema/<tool>.json` fresh every call; the app rewrites it on launch. */
  async readSchema(tool: ToolName): Promise<Record<string, unknown>> {
    const file = path.join(this.schemaDir, `${tool}.json`);
    const schema = await readJsonIfComplete<Record<string, unknown>>(file);
    if (schema === undefined) {
      throw new ExchangeError(
        `${file} is missing or unreadable. The app writes it on launch when agent runs are allowed; open SEToolBox and try again.`,
        "schema_missing",
      );
    }
    return schema;
  }

  /** Writes the request atomically. Rejects a runId that already has a result or a queued request. */
  async submit(request: AgentRequest | AgentReadRequest | AgentExportRequest): Promise<string> {
    assertValidRunId(request.runId);
    await this.assertReady();
    const finalPath = path.join(this.inDir, `${request.runId}.json`);
    const collisions = [...this.resultCandidates(request.runId), finalPath, path.join(this.doneDir, `${request.runId}.json`)];
    for (const file of collisions) {
      if (await exists(file)) {
        throw new ExchangeError(
          `runId "${request.runId}" is already used (${file}). The app never overwrites a result; choose a new runId.`,
          "duplicate_run_id",
        );
      }
    }
    const tmpPath = `${finalPath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(request, null, 2), { encoding: "utf8", flag: "wx" });
    await fs.rename(tmpPath, finalPath);
    return finalPath;
  }

  /** True while the request still waits in `in/` for the app. */
  async isQueued(runId: string): Promise<boolean> {
    assertValidRunId(runId);
    return exists(path.join(this.inDir, `${runId}.json`));
  }

  /** Returns the parsed result for a runId, or undefined when none has appeared yet. */
  async readResult(runId: string): Promise<AgentResult | undefined> {
    assertValidRunId(runId);
    for (const file of this.resultCandidates(runId)) {
      const result = await readJsonIfComplete<AgentResult>(file);
      if (result !== undefined) return result;
    }
    return undefined;
  }

  /** Polls `out/` until a result appears or the timeout elapses. */
  async awaitResult(runId: string, timeoutMs: number, pollMs: number): Promise<AgentResult> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = await this.readResult(runId);
      if (result !== undefined) return result;
      if (Date.now() >= deadline) {
        throw new ExchangeError(
          `No result for runId "${runId}" after ${Math.round(timeoutMs / 1000)} s. SEToolBox must be running, agent runs must be allowed in Settings, and on iPad the app must be in the foreground. The request stays queued in in/ and will run when the app processes it; call setoolbox_get_result with this runId later. Do not resubmit under the same runId.`,
          "timeout",
        );
      }
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    }
  }

  /** Recent results, newest first, from every `*.json` in `out/`. */
  async listRuns(limit: number): Promise<RunSummary[]> {
    await this.assertReady();
    const names = (await fs.readdir(this.outDir)).filter((name) => name.endsWith(".json") && !name.startsWith("."));
    const stamped = await Promise.all(
      names.map(async (name) => ({ name, mtime: (await fs.stat(path.join(this.outDir, name))).mtimeMs })),
    );
    stamped.sort((a, b) => b.mtime - a.mtime);
    const rows: RunSummary[] = [];
    for (const { name } of stamped.slice(0, limit)) {
      const result = await readJsonIfComplete<AgentResult>(path.join(this.outDir, name));
      rows.push({
        runId: name.replace(/\.json(\.error\.json)?$/, ""),
        file: name,
        tool: result?.run?.tool ?? null,
        status: result?.status ?? "unreadable",
        timestamp: result?.run?.timestamp ?? null,
        analysisId: result?.run?.persisted ? (result.run.analysisId ?? null) : null,
        error: typeof result?.error === "string" ? result.error : null,
      });
    }
    return rows;
  }

  /** Folder health for the agent to relay to the user. Never throws for a missing folder. */
  async status(): Promise<FolderStatus> {
    const folderPresent = await exists(this.root);
    const subfolders = {
      in: await exists(this.inDir),
      out: await exists(this.outDir),
      done: await exists(this.doneDir),
      schema: await exists(this.schemaDir),
    };
    const schemaVersions: Partial<Record<ToolName, number>> = {};
    if (subfolders.schema) {
      for (const tool of TOOL_NAMES) {
        const schema = await readJsonIfComplete<{ inputSchemaVersion?: number }>(path.join(this.schemaDir, `${tool}.json`));
        if (typeof schema?.inputSchemaVersion === "number") schemaVersions[tool] = schema.inputSchemaVersion;
      }
    }
    let queueDepth = 0;
    if (subfolders.in) {
      queueDepth = (await fs.readdir(this.inDir)).filter((name) => name.endsWith(".json")).length;
    }
    let lastResultAgeSeconds: number | null = null;
    if (subfolders.out) {
      const names = (await fs.readdir(this.outDir)).filter((name) => name.endsWith(".json"));
      let newest = 0;
      for (const name of names) newest = Math.max(newest, (await fs.stat(path.join(this.outDir, name))).mtimeMs);
      if (newest > 0) lastResultAgeSeconds = Math.round((Date.now() - newest) / 1000);
    }
    return { folder: this.root, folderPresent, subfolders, schemaVersions, queueDepth, lastResultAgeSeconds };
  }
}
