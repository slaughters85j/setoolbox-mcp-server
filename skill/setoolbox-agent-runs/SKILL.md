---
name: setoolbox-agent-runs
description: Run RF and EO/IR engineering calculations through the SEToolBox app using the setoolbox_* MCP tools instead of computing them yourself, and read the user's SEToolBox projects to review them. Use this whenever the user asks for a link budget, link margin, EIRP, free-space path loss, received power, C/N0, Eb/N0, G/T, radar range, maximum detection range, required peak power or antenna gain or RCS for a radar, GSD, IFOV, swath, EO/IR signal or SNR, or mentions SEToolBox, even if they do not say "SEToolBox" and even if the numbers look easy. Also use it when the user wants a calculation saved as an analysis in a SEToolBox project, or asks you to look over, review, sanity-check, or compare the analyses, budgets, or TPMs in one of their projects.
---

# SEToolBox agent runs

SEToolBox is the user's engineering app. It has three calculators: `link_budget`, `radar_range`, and `eoir`. The `setoolbox_*` MCP tools let you hand the app a request and get its result back. The app does the math. You do not.

## Why you never compute these yourself

A number from the app carries a runId, the exact inputs it used, and for EO/IR a citation to the physics ledger the user spent months grounding. A number from your head carries nothing. The user built this exchange so every figure in their work is reproducible. Even a "simple" free-space path loss goes through the app.

## Workflow

1. **Check the folder once.** Call `setoolbox_status`. If `folderPresent` is false, stop and tell the user to choose the folder in SEToolBox Settings and set `SETOOLBOX_AGENT_FOLDER`.
2. **Read the schema first.** Call `setoolbox_get_schema` for the tool. Use only the field names it lists and only the units in each field's `allowed` list. Read `notes`; they are the app's own rules for that tool. Do not reuse a schema from an earlier session; the app can change it between launches.
3. **Build `inputs` from what the user gave you.** Every physical quantity is `{ "value": n, "unit": "..." }`. Enums and options are strings, integers and booleans are plain. Do not invent a value the user did not state. Leaving a field out is honest; guessing is not.
4. **Call `setoolbox_run`.** Pass `save` only when the user wants the analysis kept, with the project and analysis names they gave. For a sweep, use one call per step, omit `save` on every step but the one they want kept, and let the server generate a fresh runId each time.
5. **Read `status` before anything else.**
   - `ok`: report `answer.value` with `answer.unit`. Quote `run.runId`. Compare runs on `siValue`, never on display values.
   - `undetermined`: report the quantity as not determined. Do not fill it in yourself. Ask the user for the fields in `answer.missingInputs`, then submit a new request. `agentInstruction` says exactly this; obey it.
   - `error`: read `error`, `field`, `received`, `allowed`, and `nextAction`. Fix the request and submit again. Never resubmit under the same runId.
6. **Quote `assurance` honestly.** `link_budget` and `radar_range` results say `level: computed`, `citations: false`: they are the app's own calculation, reproducible by runId, not traced to a source. `eoir` results say `level: traced` and each quantity in `result[]` carries a `citation` with ledger relation ids; quote those ids when the user asks where a number came from.
7. **If no result appears**, the tool returns a timeout error and the request stays queued. Tell the user SEToolBox must be running with agent runs allowed, and on iPad in the foreground. Call `setoolbox_status`: `queueDepth` above zero confirms the app is not processing. Later, `setoolbox_get_result` with the same runId returns the result once the app catches up.

## Reviewing a project: the second set of eyes

The user keeps studies in SEToolBox projects. Each project holds records from nine tool families: TPMs, statistical tools, budget tools, mass budgets, space and non-space power budgets, and Link Budget, Radar Range, and EO/IR analyses. Two read tools let you look without changing anything.

1. `setoolbox_list_projects` to find the project. Use the exact name or the id from here; a name shared by two projects is refused, so fall back to the id.
2. `setoolbox_read_project` with the default `summary` to see one row per record: family, id, name, and for RF and EO/IR analyses whether an agent created it.
3. `setoolbox_read_project` with `detail: "full"` when you need values. This is the project's whole export JSON, every stored input and result of every record. The family names in the summary are the keys in the full form.
4. Review by reading, not by recomputing. Look for: the same physical quantity entered differently in two records (frequency, antenna diameter, data rate, altitude); a margin close to zero or negative; required inputs still at a placeholder value such as zero; a TPM allocation that disagrees with a budget total; an analysis named "Untitled" or dated long before its neighbors. Report each finding with the record's family, name, and id, and quote the two values that disagree.
5. When a finding needs a number to settle it, run the calculation through `setoolbox_run` and cite the runId. Never put your own arithmetic beside the app's.
6. Say plainly what you did not check. A full read is large; if you skimmed a family, say so.

Reads are exact copies of the store at the time of the read. `assurance.level` is `stored`. The one non-stable field is `tpmModel.id` in a full read, which the export encoder regenerates on every call; ignore it when comparing two reads.

## Exporting EO/IR sweep workbooks

When the user wants the parameter sweep workbooks for a project's EO/IR analyses, call `setoolbox_export` once instead of asking them to export each analysis in the app. The app writes each workbook with its own sweep export, so the files match a hand export with the same settings, and nothing in the store changes.

1. Ask for the sweep settings if the user has not given them: heights, ground ranges, worksheets, and for target worksheets the target width, height, and geometry. Never invent them, and never assume the app's last-used values; the app refuses a request without axes.
2. Select the project by name or id. Omit `analysisIds` to export every EO/IR analysis, or list the ids from `setoolbox_read_project`.
3. Allow time: set `timeoutSeconds` to about 5 seconds per analysis for a large project.
4. Report `data.folder` and each `written` file, and every `skipped` analysis with its reason (a space-only analysis is skipped, for example). Pass on any `notices` on a written workbook; they are the same defects the app's export dialog lists.

## Per-tool rules the schema notes will repeat

**link_budget.** `linkType` picks the mode (Terrestrial, Space-to-Ground, Air-to-Ground, Ship-to-Shore, Satellite Crosslink). `additionalPathLoss` and `multiPathFadingMargin` are not inputs; the app sets them from `environmentType` and `pathType`. `autoCalculateWeatherLosses` defaults false; when true do not send `atmosphericLoss` or `rainLoss`. `requiredEbNo` is derived from modulation, coding gain, and implementation loss unless the user supplies it. Antenna efficiencies are fractions such as 0.55. Space links need `beamwidthFactorKappa`, `physicalTempOfAttenuation`, and `antennaNoiseTempClearSky` stated (typical 70, 290 K, 30 K) because the app never assumes them.

**radar_range.** Forward mode answers maximum range and rejects `maxRange` as an input. Inverse modes (`derivePeakPower`, `deriveAntennaGain`, `deriveMinimumRCS`) require `maxRange` and answer with Pt, Gt, or sigma. `deriveRequiredSNR` defaults true and then needs `probabilityOfDetection`, `probabilityOfFalseAlarm`, and `pulsesIntegrated`. Probabilities are strictly between 0 and 1.

**eoir.** `domain` is Terrestrial or Space. State a unit for every quantity even when the field name ends in M or Um; the app converts. The form requires `focalLengthM`, `apertureDiameterM`, `pixelPitchUm`, `pixelsCrossTrack`, `pixelsAlongTrack`, and `integrationTimeSec` for a stationary terrestrial platform. Signal and SNR need `quantumEfficiency`, `readNoiseElectrons`, `darkCurrentElectronsPerSec`, the scene inputs, and the transmissions; without them they come back undetermined, and that is the correct answer.

## Example

User: "What's the link margin for a 20 W S-band downlink at 2200 MHz from 400 km, 15 dBi on the satellite, 2 m dish on the ground, 50 Mbps, QPSK?"

1. `setoolbox_get_schema` with `tool: "link_budget"`.
2. `setoolbox_run` with `tool: "link_budget"` and inputs such as `linkType: "Space-to-Ground"`, `transmitPower: {value: 20, unit: "W"}`, `frequency: {value: 2200, unit: "MHz"}`, `altitude: {value: 400, unit: "km"}`, `transmitAntennaGain: {value: 15, unit: "dBi"}`, `receiveAntennaDiameter: {value: 2, unit: "m"}`, `dataRate: {value: 50, unit: "Mbps"}`, `modulationScheme: "QPSK"`, plus the fields the schema marks required that the user gave.
3. If the result is `undetermined` with `missingInputs: ["elevationAngle", ...]`, ask for those. Do not assume 45 degrees.
4. If `ok`, answer: "Link margin 6.04 dB (SEToolBox run 2026-09-12T14-02-11-a7f3, computed, not cited)."
