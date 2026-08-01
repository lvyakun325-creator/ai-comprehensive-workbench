# Competitor Task And Artifact Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist every Douyin/Xiaohongshu scrape as a long-lived competitor task, register its local artifacts, and automatically focus the result-files page when the complete scrape/report workflow succeeds.

**Architecture:** Add a focused Python `project_records.py` store behind the existing loopback report bridge on `127.0.0.1:8768`. Add a typed browser client and keep the dynamic snapshot in `AgentWorkspace`, which injects merged task/result queries into the existing task and result components. The scrape panel owns task lifecycle updates; Douyin account tasks wait for `CompetitorReportRunner` to finish before the workspace navigates, while Xiaohongshu and single-work tasks navigate after scrape artifacts are registered.

**Tech Stack:** Python 3 `unittest`, `pathlib`, atomic JSON writes and `subprocess`; React 19, TypeScript 5.9, Node test runner, Testing Library; existing Vinext/Sites deployment.

## Global Constraints

- Work only in `/Users/lvyakun/Documents/AI综合工作台/.worktrees/fix-xhs-prod-verification` on branch `codex/persist-competitor-artifacts`.
- The record store is `outputs/competitor-insight/.workbench/project-records.json`, is Git-ignored, and never enters the Sites package.
- Only `outputs/competitor-insight/douyin/`, `outputs/competitor-insight/xiaohongshu/`, and `outputs/competitor-insight/reports/` are valid artifact roots.
- Persist a canonical public source link but remove `xsec_token`, token/signature parameters, and tracking parameters before writing or rendering it.
- The reveal endpoint consumes an artifact ID, never a path supplied by the browser, and invokes `open` with an argument array without a shell.
- Do not read, export, log, or copy platform Cookie/state files; do not like, follow, comment, post, or create accounts.
- Existing non-competitor Agent task/result behavior remains Markdown-only and backward compatible.
- Douyin account automatic report generation must not be interrupted by navigation; navigate only after the final report is saved, or after evidence-only completion when no model is configured is explicitly represented as a non-completed task.
- Run GitNexus `detect-changes --scope compare --base-ref origin/main` before committing.

---

### Task 1: Local durable record store and artifact security

**Files:**
- Create: `agents/competitor-insight/runtime/project_records.py`
- Create: `agents/competitor-insight/runtime/tests/test_project_records.py`

**Interfaces:**
- Produces: `create_task(payload: dict[str, object]) -> dict[str, object]`
- Produces: `update_task(task_id: str, patch: dict[str, object]) -> dict[str, object]`
- Produces: `read_records(agent_id: str) -> dict[str, object]`
- Produces: `register_artifacts(task_id: str, payload: dict[str, object]) -> dict[str, object]`
- Produces: `reveal_artifact(artifact_id: str, runner=subprocess.run) -> dict[str, object]`
- Produces: `sanitize_source_url(value: str) -> str`

- [ ] **Step 1: Write failing store tests**

Create literal fixtures that catch: sensitive query persistence, task status/progress corruption, non-atomic initialization, out-of-root artifact registration, symlink escape, exact artifact classification, file disappearance, and path-based reveal injection.

```python
def test_create_task_persists_sanitized_public_link(self):
    task = project_records.create_task({
        "id": "competitor-20260801-a1",
        "agentId": "competitor-insight",
        "title": "小红书作品抓取",
        "platformId": "xiaohongshu",
        "platformLabel": "小红书",
        "skillId": "xiaohongshu-scraper",
        "sourceUrl": "https://www.xiaohongshu.com/explore/abc?xsec_token=secret&source=feed",
    })
    self.assertEqual(task["sourceUrl"], "https://www.xiaohongshu.com/explore/abc")
    persisted = json.loads(self.store_path.read_text("utf-8"))
    self.assertNotIn("secret", json.dumps(persisted))

def test_register_artifacts_scans_only_the_task_output_directory(self):
    output = self.project_root / "outputs/competitor-insight/xiaohongshu/run-a"
    output.mkdir(parents=True)
    (output / "result.xlsx").write_bytes(b"xlsx")
    (output / "result.md").write_text("# report", "utf-8")
    (output / "result.json").write_text("{}", "utf-8")
    (output / "images").mkdir()
    snapshot = project_records.register_artifacts(
        "competitor-20260801-a1",
        {"outputDir": str(output), "explicitPaths": []},
    )
    self.assertEqual(
        {item["kind"] for item in snapshot["artifacts"]},
        {"excel", "markdown", "json", "image-directory", "output-directory"},
    )

def test_reveal_uses_only_persisted_artifact_id(self):
    calls = []
    project_records.reveal_artifact(
        "artifact-a1-output",
        runner=lambda argv, **kwargs: calls.append((argv, kwargs)),
    )
    self.assertEqual(calls[0][0][:2], ["open", "--"])
    self.assertFalse(calls[0][1].get("shell", False))
```

- [ ] **Step 2: Run the new store tests and verify RED**

Run:

```bash
agents/competitor-insight/.venv/bin/python -m unittest \
  agents/competitor-insight/runtime/tests/test_project_records.py -v
```

Expected: FAIL because `project_records` and its contracts do not exist.

- [ ] **Step 3: Implement the minimal durable store**

Use `service.PROJECT_ROOT` only through a patchable module-level `PROJECT_ROOT`; validate IDs with anchored regular expressions; clamp progress to `0..100`; enforce allowed status transitions; use `Path.resolve(strict=True)` for existing artifacts; reject symbolic links before and after resolution; classify only `.xlsx`, `.md`, `.json`, image directories, and the output directory. Write JSON using a same-directory temporary file, `flush`, `os.fsync`, then `os.replace`.

```python
SCHEMA_VERSION = 1
AGENT_ID = "competitor-insight"
ALLOWED_STATUSES = {"waiting", "running", "completed", "failed", "stopped"}
STORE_COMPONENTS = ("outputs", "competitor-insight", ".workbench", "project-records.json")
SENSITIVE_QUERY_PARTS = ("token", "sign", "signature", "verify", "trace", "source")

def _empty_store() -> dict[str, object]:
    return {"schemaVersion": SCHEMA_VERSION, "tasks": [], "artifacts": []}

def _atomic_write(store: dict[str, object]) -> None:
    target = _store_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.{secrets.token_hex(8)}.tmp")
    with temporary.open("x", encoding="utf-8") as handle:
        json.dump(store, handle, ensure_ascii=False, separators=(",", ":"))
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, target)
```

- [ ] **Step 4: Run the store tests and verify GREEN**

Run the Step 2 command. Expected: all tests PASS.

- [ ] **Step 5: Run the existing Python runtime suite**

Run:

```bash
agents/competitor-insight/.venv/bin/python -m unittest discover \
  -s agents/competitor-insight/runtime/tests -p 'test_*.py' -v
```

Expected: existing report/evidence tests and the new record tests PASS.

---

### Task 2: Expose record operations through the loopback bridge

**Files:**
- Modify: `agents/competitor-insight/runtime/bridge_server.py`
- Modify: `agents/competitor-insight/runtime/tests/test_bridge_server.py`

**Interfaces:**
- Consumes: Task 1 `project_records` functions.
- Produces: `GET /project-records?agentId=competitor-insight`
- Produces: `POST /project-tasks`
- Produces: `PATCH /project-tasks/{taskId}`
- Produces: `POST /project-tasks/{taskId}/artifacts`
- Produces: `POST /project-artifacts/{artifactId}/reveal`

- [ ] **Step 1: Write failing HTTP contract tests**

Add tests using the real `ThreadingHTTPServer` test fixture. Patch both `service.PROJECT_ROOT` and `project_records.PROJECT_ROOT` to the temporary root. Assert the exact CORS and response behavior:

```python
def test_project_task_lifecycle_is_persisted_and_queryable(self):
    created = self._json_request("POST", "/project-tasks", self.task_payload())
    self.assertEqual(created[0], 200)
    task_id = json.loads(created[2])["task"]["id"]
    updated = self._json_request(
        "PATCH",
        f"/project-tasks/{task_id}",
        {"status": "running", "progress": 60, "currentStep": "正在抓取平台数据"},
    )
    self.assertEqual(json.loads(updated[2])["task"]["progress"], 60)
    status, headers, body = self._request(
        "GET",
        "/project-records?agentId=competitor-insight",
        headers={"Origin": "http://localhost:3000"},
    )
    self.assertEqual(status, 200)
    self.assertEqual(headers["access-control-allow-origin"], "http://localhost:3000")
    self.assertEqual(json.loads(body)["tasks"][0]["id"], task_id)

def test_reveal_route_accepts_artifact_id_not_path(self):
    status, _headers, body = self._json_request(
        "POST", "/project-artifacts/not-found/reveal", {"path": "/tmp/escape"}
    )
    self.assertEqual(status, 400)
    self.assertEqual(json.loads(body)["error"], "INVALID_REQUEST")
```

- [ ] **Step 2: Run bridge tests and verify RED**

Run:

```bash
agents/competitor-insight/.venv/bin/python -m unittest \
  agents/competitor-insight/runtime/tests/test_bridge_server.py -v
```

Expected: new record endpoints return 404 or unsupported method failures.

- [ ] **Step 3: Implement route parsing without weakening existing endpoints**

Parse paths with `urllib.parse.urlsplit`; keep `/health` available without Origin; require an allowed Origin for record reads and every write/reveal request. Expand preflight methods to `GET, POST, PATCH, OPTIONS`. Route only exact anchored task/artifact IDs.

```python
TASK_PATH = re.compile(r"^/project-tasks/(?P<task_id>competitor-[0-9A-Za-z-]+)$")
ARTIFACTS_PATH = re.compile(r"^/project-tasks/(?P<task_id>competitor-[0-9A-Za-z-]+)/artifacts$")
REVEAL_PATH = re.compile(r"^/project-artifacts/(?P<artifact_id>artifact-[0-9A-Za-z-]+)/reveal$")
```

Map store errors to stable, non-sensitive responses: `INVALID_REQUEST`, `TASK_NOT_FOUND`, `ARTIFACT_NOT_FOUND`, `PATH_NOT_ALLOWED`, `ARTIFACT_MISSING`, and `RECORD_STORE_DAMAGED`.

- [ ] **Step 4: Run bridge tests and verify GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Run the full Python runtime suite**

Run the Task 1 Step 5 command. Expected: PASS.

---

### Task 3: Typed browser client and merged project-record queries

**Files:**
- Create: `app/lib/competitor-project-records-client.ts`
- Create: `tests/competitor-project-records-client.test.mjs`
- Modify: `app/lib/agent-project-records.mjs`
- Modify: `app/lib/agent-project-records.d.mts`
- Modify: `tests/agent-project-records.test.mjs`

**Interfaces:**
- Produces: `loadCompetitorProjectRecords(signal?: AbortSignal): Promise<CompetitorProjectSnapshot>`
- Produces: `createCompetitorTask(input: CreateCompetitorTaskInput): Promise<ProjectTask>`
- Produces: `updateCompetitorTask(taskId: string, patch: CompetitorTaskPatch): Promise<ProjectTask>`
- Produces: `registerCompetitorArtifacts(taskId: string, input: RegisterArtifactsInput): Promise<CompetitorProjectSnapshot>`
- Produces: `revealCompetitorArtifact(artifactId: string): Promise<void>`
- Produces: `mergeProjectTasks(staticTasks, dynamicTasks)` and `mergeProjectResults(staticResults, dynamicResults)`.

- [ ] **Step 1: Write failing client/parser and merge tests**

Use real `Response` objects and a fetch stub at the network boundary. Assert that malformed data, oversized responses, non-HTTPS source links, invalid task IDs, and unknown artifact kinds are rejected. Assert dynamic records replace same-ID fixtures and sort newest first.

```javascript
test("loads a complete typed competitor snapshot", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true,
    tasks: [TASK_FIXTURE],
    artifacts: [ARTIFACT_FIXTURE],
  }), {status: 200, headers: {"content-type": "application/json"}});
  const snapshot = await loadCompetitorProjectRecords();
  assert.equal(snapshot.tasks[0].sourceUrl, "https://www.xiaohongshu.com/explore/abc");
  assert.equal(snapshot.results[0].kind, "excel");
});

test("merges dynamic competitor records without changing static fixtures", () => {
  assert.deepEqual(
    mergeProjectTasks(PROJECT_TASKS, [{...PROJECT_TASKS[2], updatedAt: "2026-08-01T10:00:00.000Z"}])
      .filter((item) => item.agentId === "competitor-insight")
      .map((item) => item.id),
    ["competitor-completed"],
  );
});
```

- [ ] **Step 2: Run targeted Node tests and verify RED**

Run:

```bash
node --import tsx --test \
  tests/competitor-project-records-client.test.mjs \
  tests/agent-project-records.test.mjs
```

Expected: FAIL because the client and merge helpers do not exist.

- [ ] **Step 3: Implement strict client parsing and backward-compatible record helpers**

Extend `ProjectTask` with optional `platformId`, `platformLabel`, `skillId`, and `sourceUrl`. Extend `ProjectResult` with optional `kind`, `absolutePath`, `exists`, `isDirectory`, and nullable Markdown. Preserve all existing fixture behavior and function call signatures by adding optional collection parameters only.

Use a shared bounded JSON reader and stable Chinese errors; never include server response bodies or source URLs in thrown errors.

- [ ] **Step 4: Run targeted Node tests and verify GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Run typecheck and the complete record/client test group**

Run:

```bash
npm run typecheck
node --import tsx --test tests/agent-project-records.test.mjs \
  tests/competitor-project-records-client.test.mjs \
  tests/competitor-report-client.test.mjs
```

Expected: PASS.

---

### Task 4: Drive task lifecycle from scrape and report completion

**Files:**
- Modify: `app/components/CompetitorInsightPanel.tsx`
- Modify: `app/components/CompetitorReportRunner.tsx`
- Modify: `tests/workbench-ui.test.tsx`

**Interfaces:**
- Consumes: Task 3 client functions.
- Produces: `CompetitorInsightPanel` callbacks `onRecordsChanged?: () => void` and `onTaskCompleted?: (taskId: string) => void`.
- Produces: `CompetitorReportRunner` callbacks `onCompleted?: (report: ReportReadyResponse) => void`, `onEvidenceReady?: (evidence: EvidenceReadyResponse) => void`, and `onFailed?: (message: string) => void`.

- [ ] **Step 1: Write failing scrape lifecycle integration tests**

Add complete fetch sequences for: task creation before scraper health, Xiaohongshu success registration and navigation callback, scrape failure task update without callback, and Douyin account waiting for report completion before callback.

```tsx
test("小红书抓取先创建持久任务，登记成果后通知工作区跳转", async () => {
  const completedTaskIds: string[] = [];
  render(<CompetitorInsightPanel
    mode="run"
    onPreview={() => undefined}
    onTaskCompleted={(taskId) => completedTaskIds.push(taskId)}
  />);
  await user.type(screen.getByLabelText("竞品主页或作品链接"), XHS_URL);
  await user.click(screen.getByRole("button", {name: "抓取并分析"}));
  await waitFor(() => assert.deepEqual(completedTaskIds, ["competitor-fixed-id"]));
  assert.equal(fetchCalls[0].pathname, "/project-tasks");
  assert.equal(fetchCalls.at(-1).pathname, "/project-tasks/competitor-fixed-id/artifacts");
});
```

- [ ] **Step 2: Run the new UI tests and verify RED**

Run only the named competitor tests with Node test name filtering. Expected: FAIL because callbacks and persistence calls do not exist.

- [ ] **Step 3: Implement lifecycle updates with a single active task ID**

Create the persisted task before platform health. Update to 25% before bridge health, 60% before `/scrape`, and 90% before artifact registration. On XHS/single-work success, register artifacts and call `onTaskCompleted(taskId)`. On Douyin account success, keep the task running during automatic report generation; call artifact registration a second time with `reportPath` when `CompetitorReportRunner.onCompleted` fires, then complete and navigate.

If the report reaches evidence-ready because no model is configured, retain the task as running with `currentStep: "证据包已生成，等待配置模型"`; do not claim completion and do not navigate away from the configuration guidance.

- [ ] **Step 4: Run competitor UI tests and verify GREEN**

Run the Step 2 test filter. Expected: PASS.

- [ ] **Step 5: Run typecheck and all report/scrape UI regressions**

Run:

```bash
npm run typecheck
node --import tsx --test --test-name-pattern='竞品|报告' tests/workbench-ui.test.tsx
```

Expected: PASS, including existing four-stage progress and report retry tests.

---

### Task 5: Dynamic task/result pages and automatic workspace navigation

**Files:**
- Modify: `app/components/AgentWorkspace.tsx`
- Modify: `app/components/AgentTaskList.tsx`
- Modify: `app/components/AgentResultFiles.tsx`
- Modify: `app/globals.css`
- Modify: `tests/workbench-ui.test.tsx`

**Interfaces:**
- Consumes: Task 3 snapshot/load/reveal APIs and Task 4 completion callback.
- Produces: competitor workspace refresh state and a focused artifact list for `initialTaskId`.

- [ ] **Step 1: Write failing task/result/navigation tests**

Add behavior tests that render real components with complete dynamic fixtures. Catch the following breaks: source link absent, wrong link query retained, non-Markdown artifacts hidden, missing file shown as usable, reveal invoked with a path instead of ID, and successful scrape failing to activate the result tab.

```tsx
test("竞品任务展示清理后的来源链接和 Skill", () => {
  render(<AgentTaskList {...TASK_LIST_PROPS} getAgentTasks={() => [DYNAMIC_TASK]} />);
  const link = screen.getByRole("link", {name: "查看抓取链接"});
  assert.equal(link.getAttribute("href"), "https://www.xiaohongshu.com/explore/abc");
  assert.ok(screen.getByText("xiaohongshu-scraper"));
});

test("竞品成果按任务聚焦并可通过成果 ID 在访达显示", async () => {
  const revealed: string[] = [];
  render(<AgentResultFiles
    agentId="competitor-insight"
    initialTaskId="competitor-fixed-id"
    getAgentResults={() => DYNAMIC_RESULTS}
    getTaskById={() => DYNAMIC_TASK}
    onRevealArtifact={async (id) => revealed.push(id)}
    onPreview={() => undefined}
  />);
  await user.click(screen.getByRole("button", {name: /在访达中显示result.xlsx/}));
  assert.deepEqual(revealed, ["artifact-fixed-excel"]);
});
```

- [ ] **Step 2: Run targeted UI tests and verify RED**

Run the Task 4 Step 5 test command. Expected: FAIL on the new task/result assertions.

- [ ] **Step 3: Implement dynamic workspace snapshot and focused results**

Load records when a competitor workspace mounts. Merge them with static fixtures through pure helpers. Pass query closures to both existing components. After `onTaskCompleted(taskId)`, reload the snapshot, set `resultTaskId`, and set `activeTab` to `成果文件` only after the task and artifacts are present.

In `AgentResultFiles`, keep the existing Markdown modal behavior and add inline actions for every dynamic artifact. Filter to `initialTaskId` when non-null and show “查看全部成果” to clear the filter. Use `navigator.clipboard.writeText(result.absolutePath)` for paths and `onRevealArtifact(result.id)` for Finder. Disable reveal and label “文件已不存在” when `exists === false`.

- [ ] **Step 4: Add minimal responsive styles**

Add classes for task metadata/link, artifact kind badge, path wrapping, inline actions, focused-result banner, and missing-artifact state. Reuse existing colors, spacing, and button tokens; do not redesign unrelated panels.

- [ ] **Step 5: Run targeted UI tests and verify GREEN**

Run the Task 4 Step 5 command. Expected: PASS.

- [ ] **Step 6: Run the full Node/React suite**

Run:

```bash
npm test
```

Expected: build succeeds and every Node/React test passes.

---

### Task 6: Security review, live verification, deployment and progress sync

**Files:**
- Modify: `docs/superpowers/specs/2026-08-01-competitor-task-artifact-persistence-design.md`
- Modify: `docs/project-progress/00-项目进度总览.md`
- Create or modify: `docs/project-progress/2026-08-01-项目进度更新.md`
- Modify mirror: `/Users/lvyakun/Desktop/吕亚坤笔记库/codex 仓库/Codex产出/AI综合工作台/00-项目进度总览.md`
- Create or modify mirror: `/Users/lvyakun/Desktop/吕亚坤笔记库/codex 仓库/Codex产出/AI综合工作台/2026-08-01-项目进度更新.md`

**Interfaces:**
- Consumes: completed Tasks 1-5.
- Produces: verified branch, published owner-only Sites version, restarted loopback report bridge, synchronized project record.

- [ ] **Step 1: Run focused security and regression verification**

Run:

```bash
agents/competitor-insight/.venv/bin/python -m unittest discover \
  -s agents/competitor-insight/runtime/tests -p 'test_*.py' -v
npm run typecheck
npm run lint
npm test
git diff --check
```

Expected: all commands PASS. Existing unrelated failures must be reported separately and cannot be counted as success.

- [ ] **Step 2: Run GitNexus changed-scope verification**

Run:

```bash
node .gitnexus/run.cjs detect-changes \
  --scope compare --base-ref origin/main \
  --repo '/Users/lvyakun/Documents/AI综合工作台/.worktrees/fix-xhs-prod-verification' \
  --branch codex/persist-competitor-artifacts
```

Expected: changed symbols are limited to competitor records, bridge routes, competitor scrape/report components, task/result rendering, and their tests. No authentication, model credential, content-matrix, or unrelated Agent flow is affected.

- [ ] **Step 3: Restart and health-check the report bridge**

Start the checked-in bridge with the existing competitor Python environment and canonical project root, then verify:

```bash
curl -sS http://127.0.0.1:8768/health
curl -i -X OPTIONS http://127.0.0.1:8768/project-tasks \
  -H 'Origin: https://zhongfan-ai-workbench.lvyakun325.chatgpt.site' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type' \
  -H 'Access-Control-Request-Private-Network: true'
```

Expected: health 200; preflight 204 with the exact production Origin and private-network header; malicious Origin test remains 403.

- [ ] **Step 4: Perform one authorized live browser acceptance run**

Use the user-provided public Xiaohongshu link already authorized in this task. Verify in the production browser: task appears immediately; progress updates; success switches to Results; Excel/Markdown/JSON/image/output entries appear; refresh restores them; copy path returns the registered absolute path; reveal opens the recorded artifact in Finder. Do not inspect or export browser/platform login state.

- [ ] **Step 5: Update durable project progress and Obsidian mirrors**

Mark separately: implemented, automated-test verified, live verified, deployed, and still unverified. Include the published Sites version and exact test counts. Do not include source link tokens, cookies, credentials, customer data, or raw platform payloads.

- [ ] **Step 6: Final branch review and commit**

Run `git status --short`, review every diff, stage only scoped files, then commit with:

```bash
git commit -m "feat: persist competitor scrape artifacts"
```

- [ ] **Step 7: Publish only after all gates pass**

Push `codex/persist-competitor-artifacts`, open and merge the scoped PR, publish the existing owner-only Sites project, and re-run the live browser acceptance against the new production version. Do not change site visibility or create a second production site.
