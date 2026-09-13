# setoolbox-mcp-server

An MCP server for [SEToolBox](https://ubs-analytics.com), the systems engineering calculator for macOS and iPadOS. It lets an AI agent run the app's Link Budget, Radar Range, and EO/IR calculators and read the user's projects, through the folder the app watches. The app does every calculation; this server only writes request files and returns the app's result files unchanged.

## Requirements

- SEToolBox running, with an agent runs folder chosen in Settings and "Allow agent runs" on. On iPad the app must be in the foreground.
- Node 20 or newer.
- The folder must be on local disk, not iCloud Drive or another sync folder. The exchange relies on an atomic rename.

## Install and register

No clone, no build: `npx` fetches and builds the server on first use. Pin a release tag so every machine gets the same code; the default branch is not pinned and npx caches what it fetched.

Warm the cache first, and confirm the version it prints:

```bash
npx -y github:slaughters85j/setoolbox-mcp-server#v0.2.0 --version
```

Claude Code:

```bash
claude mcp add --scope user setoolbox -e "SETOOLBOX_AGENT_FOLDER=/path/to/your/agent/folder" -- npx -y github:slaughters85j/setoolbox-mcp-server#v0.2.0
```

Codex CLI:

```bash
codex mcp add setoolbox --env SETOOLBOX_AGENT_FOLDER=/path/to/your/agent/folder -- npx -y github:slaughters85j/setoolbox-mcp-server#v0.2.0
```

Claude desktop app, in `~/Library/Application Support/Claude/claude_desktop_config.json`. Use the absolute path of `npx` (`which npx`); the desktop app does not load your shell PATH. Quit the app before editing when you can, since it rewrites the file on quit; if the agent doing this is running inside the desktop app, write the entry anyway and check it after the restart:

```json
"setoolbox": {
  "command": "/opt/homebrew/bin/npx",
  "args": ["-y", "github:slaughters85j/setoolbox-mcp-server#v0.2.0"],
  "env": { "SETOOLBOX_AGENT_FOLDER": "/path/to/your/agent/folder" }
}
```

Then quit and relaunch the tool. To confirm which build is live, call `setoolbox_status` and read `serverVersion`; tool descriptions can be stale in a client's cache, the status payload cannot.

| Setting | Source | Default |
|---|---|---|
| Folder | `SETOOLBOX_AGENT_FOLDER` or `--folder <path>` | required |
| Result timeout | `SETOOLBOX_AGENT_TIMEOUT_S` | 60 |
| Poll interval | `SETOOLBOX_AGENT_POLL_MS` | 1000 |

## Tools

| Tool | Does |
|---|---|
| `setoolbox_list_tools` | The three calculation tools and their schema versions |
| `setoolbox_get_schema` | `schema/<tool>.json` verbatim: the blank input form |
| `setoolbox_run` | Write a request, wait for the result, return it verbatim |
| `setoolbox_get_result` | Fetch a result by runId, after a timeout or from another session |
| `setoolbox_list_runs` | Recent results, newest first |
| `setoolbox_status` | Folder present, schema versions, queue depth, last result age |
| `setoolbox_list_projects` | Every project with per-family record counts (read only) |
| `setoolbox_read_project` | One project: summary rows, or the full export JSON (read only) |

## The folder protocol

```
<folder>/
  in/      requests, written as <runId>.json.tmp then renamed to <runId>.json
  out/     results, <runId>.json; or <request file name>.error.json when the runId could not be trusted
  done/    archived requests
  schema/  link_budget.json, radar_range.json, eoir.json
```

- `runId`: 1 to 64 characters of `[A-Za-z0-9._-]`, no leading dot, equal to the file name without `.json`, never reused. The app never overwrites a result.
- A calculation request carries `tool`, `inputSchemaVersion` (1), `inputs` (every physical quantity as `{"value": n, "unit": "..."}`), optional `save` (`projectName`, `analysisName`), and optional `displayUnits`.
- A read request carries `operation` (`project.list` or `project.read`) instead of `tool` and `inputs`.
- Results carry, in order: `status` (`ok`, `undetermined`, `error`), `answer`, `assurance`, `result`, `warnings`, `run`, then `data` for reads, `agentInstruction` for undetermined answers, or the error fields. `run` holds `runId`, `toolVersion`, `inputSchemaVersion`, `timestamp`, `analysisId`, `persisted`, `sessionId`, and on calculation results `tool`.
- `undetermined` is a normal outcome. Report the quantity as not determined and ask for `answer.missingInputs`.

The server writes only `in/<runId>.json.tmp` and the rename. It never touches `out/`, `done/`, or `schema/`, never deletes, and never resends under a used runId.

## Skill

`skill/setoolbox-agent-runs/SKILL.md` teaches an agent when and how to use these tools, including a project review procedure. Copy or link it into your agent's skills folder.

## Development

```bash
npm install
npm test
```

Seventeen tests run against a temporary folder with a fake responder standing in for the app. Two live tests run only when `SETOOLBOX_AGENT_FOLDER` is set and the app is running.
