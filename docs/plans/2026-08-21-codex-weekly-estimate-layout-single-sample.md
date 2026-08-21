# Codex Weekly Estimate Layout and Single-Sample Estimation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move the Codex “预估周额度” display below “最近请求” and allow a low-confidence weekly quota estimate when only one valid usage snapshot is available.

**Architecture:** Keep the existing snapshot persistence and multi-sample weighted delta calculation as the preferred path. Extend the estimator with a single-sample fallback based on the current reset window’s cumulative local cost divided by the official weekly used percentage; expose an explicit confidence/source marker so the UI can distinguish it from multi-sample estimates. Render the recent-request line and estimate as separate stacked rows without changing account usage totals or upstream quota data.

**Tech Stack:** Node.js ES modules, Jest, existing usage API/UI modules, CSS, Docker local smoke test.

**Project Progress Doc:** `.plans/current.md`
**Test Overview Doc:** No dedicated test-overview document found; use focused Jest tests listed below.

---

### Task 1: Confirm the current behavior and preserve the existing worktree boundary

**Files:**
- Read: `src/services/codex-weekly-estimate.js`
- Read: `src/ui-modules/usage-api.js`
- Read: `static/app/usage-manager.js`
- Read: `static/components/section-usage.css`
- Read: `tests/codex-weekly-estimate.test.js`
- Read: `tests/usage-manager-display-source.test.js`

**Step 1: Capture the baseline status**

Run:

```powershell
git status --short
git log -3 --oneline
```

Expected: `353e96c` remains the latest feature commit; existing untracked runtime artifacts remain uncommitted and are not part of this change.

**Step 2: Record the current focused test behavior**

Run:

```powershell
npm test -- --runInBand tests/codex-weekly-estimate.test.js tests/usage-manager-display-source.test.js
```

Expected: Current targeted tests pass before the new assertions are added.

**Step 3: Commit**

No commit. This task is a read-only baseline checkpoint.

### Task 2: Add failing tests for single-sample estimation

**Files:**
- Modify: `tests/codex-weekly-estimate.test.js`

**Step 1: Write the failing tests**

Add cases covering:

- One valid snapshot with `usedPercent > 0`, non-negative cumulative `costUsd`, and a reset window returns `status: 'estimated'`.
- The single-sample result uses `costUsd * 100 / usedPercent` and marks `sampleCount: 1`, `confidence: 'low'`, and a source/method value identifying the single-sample fallback.
- A zero official percentage, zero local cost, missing reset context, or invalid snapshot remains `insufficient-data`.
- Existing two-sample delta behavior remains unchanged.

**Step 2: Run the tests to verify failure**

Run:

```powershell
npm test -- --runInBand tests/codex-weekly-estimate.test.js
```

Expected: The new single-sample assertions fail because the estimator currently requires a pair of snapshots.

### Task 3: Implement the single-sample estimator fallback

**Files:**
- Modify: `src/services/codex-weekly-estimate.js`

**Step 1: Define the fallback rule**

After attempting multi-sample deltas, use the latest normalized snapshot only when:

- `usedPercent > 0`;
- `costUsd > 0`;
- a reset window is present (`resetAt` is non-null); and
- no valid multi-sample estimate was produced.

Calculate:

```text
estimatedUsd = costUsd * 100 / usedPercent
```

Round to cents, return `sampleCount: 1`, `confidence: 'low'`, and a stable `method`/`source` field such as `single-sample-period-extrapolation`.

**Step 2: Keep multi-sample behavior authoritative**

Do not alter reset-boundary filtering, positive percentage-delta requirements, cost non-decrease checks, weighting, or the existing high/medium/low confidence thresholds for multi-sample results.

**Step 3: Run the focused tests**

Run:

```powershell
npm test -- --runInBand tests/codex-weekly-estimate.test.js
```

Expected: All estimator tests pass.

### Task 4: Add failing tests for stacked UI rows and confidence wording

**Files:**
- Modify: `tests/usage-manager-display-source.test.js`

**Step 1: Write the failing assertions**

Assert that the account summary source:

- renders the recent-request row separately from the estimate row;
- places the estimate after the recent-request row rather than inside the same horizontal row;
- renders a single-sample estimate with a low-confidence/source tooltip;
- keeps the existing “采样中” state when no estimate is available.

**Step 2: Run the test to verify failure**

Run:

```powershell
npm test -- --runInBand tests/usage-manager-display-source.test.js
```

Expected: The current inline-row source/layout assertions fail.

### Task 5: Implement the stacked estimate presentation

**Files:**
- Modify: `static/app/usage-manager.js`
- Modify: `static/components/section-usage.css`

**Step 1: Render two independent rows**

Change `renderAccountUsageSummary` so the recent-request element and `renderEstimatedWeeklyQuota` are emitted as separate stacked blocks. Keep the estimate visible when there is no `lastUsedAt` but an estimate exists.

**Step 2: Add confidence-aware tooltip text**

Use the estimator method/source field:

- multi-sample: explain the number of official quota-change samples;
- single-sample: explicitly say “单日低置信度估算” and that it is extrapolated from the current reset window;
- insufficient data: retain “采样中”.

**Step 3: Update CSS minimally**

Reuse existing spacing and responsive rules where possible. Make the two rows vertically stacked, preserve card width, and ensure narrow screens wrap without horizontal overflow. Do not alter the period grid or quota progress card.

**Step 4: Run focused tests and syntax checks**

Run:

```powershell
npm test -- --runInBand tests/codex-weekly-estimate.test.js tests/usage-manager-display-source.test.js
node --check src/services/codex-weekly-estimate.js
node --check static/app/usage-manager.js
git diff --check
```

Expected: Focused tests pass, syntax checks exit 0, and `git diff --check` reports no whitespace errors.

### Task 6: Verify API propagation without changing usage totals

**Files:**
- Read/modify only if required: `src/ui-modules/usage-api.js`
- Test: `tests/codex-weekly-estimate.test.js`

**Step 1: Verify estimator metadata propagation**

Confirm `weeklyQuotaEstimate` passes through unchanged for both multi-sample and single-sample results, including confidence and method/source metadata.

**Step 2: Add a regression assertion if propagation drops metadata**

Only add the smallest focused test or implementation change necessary. Do not modify token, request, cost, or provider totals.

**Step 3: Run the relevant tests**

Run:

```powershell
npm test -- --runInBand tests/codex-weekly-estimate.test.js tests/usage-manager-display-source.test.js tests/api-potluck-key-usage-summary.test.js
```

Expected: New tests pass; the known unrelated `listedKey` fixture failure, if still present, is reported separately and not folded into this feature.

### Task 7: Build and update only the local container

**Files:**
- Build artifact: local Docker image
- Runtime data: existing `docker-data` mounts, preserved in place

**Step 1: Build the candidate image**

Run with the already-approved local proxy if Docker dependency downloads require it:

```powershell
docker build --build-arg HTTP_PROXY=http://host.docker.internal:7890 --build-arg HTTPS_PROXY=http://host.docker.internal:7890 --build-arg ALL_PROXY=http://host.docker.internal:7890 -t aiclient2api:custom-<new-commit> .
```

Expected: Build succeeds and the image label points to the new commit.

**Step 2: Preserve rollback state**

Keep the currently running/stopped local container and all existing mounts. Do not delete runtime data, production containers, or the untracked SQLite/log artifacts.

**Step 3: Recreate the local container**

Reuse the existing network, ports, environment variables, volumes, restart policy, and command. Stop the old local container only after its configuration is captured; keep a renamed stopped container for rollback.

**Step 4: Validate the local runtime**

Check:

```powershell
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}'
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3000/api/health
```

Expected: `aiclient2api` is `running (healthy)` and health returns HTTP 200. Auth-protected usage endpoints may return 401 without a session; do not treat that alone as a service failure.

### Task 8: Review, commit, and hand off

**Files:**
- All modified feature/test files only

**Step 1: Review the diff boundary**

Run:

```powershell
git status --short
git diff --stat
git diff --name-only
```

Expected: Only estimator/UI/CSS/tests (and any explicitly required plan/progress docs) are candidates. Do not stage `.tmp-local-network-candidate-20260821/` or `custom-5c7f0cd-source.tar`.

**Step 2: Run final verification**

Run the focused tests, syntax checks, and local container health check from Tasks 5–7.

**Step 3: Commit**

Create one focused commit after verification:

```powershell
git add src/services/codex-weekly-estimate.js static/app/usage-manager.js static/components/section-usage.css tests/codex-weekly-estimate.test.js tests/usage-manager-display-source.test.js
git commit -m "feat(usage): refine Codex weekly quota estimate display"
```

Do not push and do not update production.

