import { expect } from "vitest";
import { control, createAndSelectWorkspace, evalIn, waitFor } from "@openwork/behaviors";
import { desktop } from "@openwork/hosts";
import { needs, test } from "@openwork/testkit";

const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = e2eTestsEnabled
  ? "connector-backed tool calls show first-class branding and human-readable labels"
  : "connector tool-call branding skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

test.skipIf(!e2eTestsEnabled)(title, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });

  await using app = await desktop({ name: "connector-tool-call-branding" });
  await createAndSelectWorkspace(app, {
    path: `/tmp/openwork-connector-tool-call-branding-${Date.now()}`,
  });
  await waitFor(
    app,
    `window.__openworkControl.listActions().some((action) => action.id === "session.create_task" && !action.disabled)`,
    { timeoutMs: 30_000, label: "new task control ready" },
  );
  await control(app, "session.create_task");
  await waitFor(
    app,
    `window.__openworkControl.listActions().some((action) => action.id === "eval.connector_tool_call.seed" && !action.disabled)`,
    { timeoutMs: 30_000, label: "connector tool-call proof control ready" },
  );
  await control(app, "eval.connector_tool_call.seed");

  await waitFor(app, `(() => {
    const mark = document.querySelector('[data-connector-name="Google Workspace"]');
    const image = mark?.querySelector('img');
    return mark instanceof HTMLElement
      && image instanceof HTMLImageElement
      && image.complete
      && image.naturalWidth > 0;
  })()`, { timeoutMs: 15_000, label: "Google Workspace connector logo loaded" });

  const rendered = await evalIn(app, `(() => {
    const mark = document.querySelector('[data-connector-name="Google Workspace"]');
    const row = mark?.closest('[data-capability-call]');
    const image = mark?.querySelector('img');
    return {
      connector: mark?.getAttribute('data-connector-name') ?? null,
      image: image instanceof HTMLImageElement ? image.getAttribute('src') : null,
      text: row instanceof HTMLElement ? row.innerText.replace(/\\s+/g, ' ').trim() : '',
      rawNameVisible: document.body.innerText.includes('openwork-cloud_execute_capability'),
    };
  })()`);

  expect(rendered).toMatchObject({
    connector: "Google Workspace",
    rawNameVisible: false,
  });
  if (!rendered || typeof rendered !== "object" || !("text" in rendered) || typeof rendered.text !== "string") {
    throw new Error(`Connector tool row was not readable: ${JSON.stringify(rendered)}`);
  }
  expect(rendered.text).toContain("Fetched Google Workspace Calendar Events");
  evidence.recordAssertionEvidence(
    "Connector tool calls show the connector logo with a human-readable action",
    `The completed row loaded the bundled Google Workspace mark and read “${rendered.text}”.`,
    true,
  );

  evidence.recordAssertionEvidence(
    "Connector branding does not replace the readable label with the raw tool identifier",
    "The visible transcript contained the branded sentence and did not expose openwork-cloud_execute_capability.",
    true,
  );
});
