import { expect } from "vitest";
import { control, createAndSelectWorkspace, evalIn, waitFor } from "@openwork/behaviors";
import { desktop } from "@openwork/hosts";
import { needs, test } from "@openwork/testkit";

const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = e2eTestsEnabled
  ? "running delegated-task activity uses a quiet shimmer without a spinner"
  : "task activity shimmer skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

test.skipIf(!e2eTestsEnabled)(title, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });

  await using app = await desktop({ name: "task-activity-shimmer" });
  await createAndSelectWorkspace(app, {
    path: `/tmp/openwork-task-activity-shimmer-${Date.now()}`,
  });
  await waitFor(
    app,
    `window.__openworkControl.listActions().some((action) => action.id === "session.create_task" && !action.disabled)`,
    { timeoutMs: 30_000, label: "new task control ready" },
  );
  await control(app, "session.create_task");
  await waitFor(
    app,
    `window.__openworkControl.listActions().some((action) => action.id === "eval.task_activity.seed" && !action.disabled)`,
    { timeoutMs: 30_000, label: "subagent activity proof control ready" },
  );
  await control(app, "eval.task_activity.seed");

  await waitFor(
    app,
    `Boolean(document.querySelector('[data-subagent-activity="shimmer"] .ow-text-shimmer'))`,
    { timeoutMs: 15_000, label: "running subagent shimmer" },
  );
  const rendered = await evalIn(app, `(() => {
    const row = document.querySelector('[data-subagent-activity="shimmer"]');
    const shimmer = row?.querySelector('.ow-text-shimmer');
    return {
      text: row instanceof HTMLElement ? row.innerText.replace(/\\s+/g, ' ').trim() : '',
      hasSpinner: Boolean(row?.querySelector('.animate-spin')),
      hasShimmer: shimmer instanceof HTMLElement,
      animationName: shimmer instanceof HTMLElement ? getComputedStyle(shimmer).animationName : '',
    };
  })()`);

  expect(rendered).toMatchObject({
    hasSpinner: false,
    hasShimmer: true,
  });
  if (!rendered || typeof rendered !== "object" || !("text" in rendered) || typeof rendered.text !== "string") {
    throw new Error(`Subagent activity row was not readable: ${JSON.stringify(rendered)}`);
  }
  expect(rendered.text).toContain("Build isolated Azure repro");
  expect(rendered.text).toContain("Working");
  evidence.recordAssertionEvidence(
    "Running delegated tasks no longer show the circular spinner",
    "The live delegated-task row contained no animate-spin indicator while it was working.",
    true,
  );

  evidence.recordAssertionEvidence(
    "A quiet shimmer communicates activity without obscuring the task status",
    `The delegated-task title used the shimmer treatment while the readable row remained “${rendered.text}”.`,
    true,
  );
});
