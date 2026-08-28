import { expect } from "vitest";
import { clickButton, control, createAndSelectWorkspace, evalIn, seedSessions, waitFor } from "@openwork/behaviors";
import { desktop } from "@openwork/hosts";
import { needs, test } from "@openwork/testkit";

const enabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = enabled
  ? "Mermaid renders safely in completed chat and Markdown artifacts"
  : "Mermaid rendering skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

test.skipIf(!enabled)(title, async () => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });
  await using app = await desktop({
    name: "mermaid-rendering",
    mode: process.env.OPENWORK_EVAL_CDP_URL?.trim() ? "attach" : "spawn",
    env: { OPENWORK_ELECTRON_START_URL: "", PORT: "0" },
  });
  await createAndSelectWorkspace(app, { path: `/tmp/openwork-mermaid-rendering-${Date.now()}` });
  await seedSessions(app, ["Mermaid rendering proof"]);
  await waitFor(app, `window.__openworkControl.listActions().some((action) => action.id === "eval.markdown_primitive.seed_chat" && !action.disabled)`, {
    timeoutMs: 30_000,
    label: "Mermaid chat fixture available",
  });

  await control(app, "eval.mermaid.set_theme", { mode: "light" });
  await waitFor(app, `document.documentElement.dataset.theme === "light"`, { timeoutMs: 10_000, label: "light theme applied" });
  await control(app, "eval.markdown_primitive.seed_chat");
  await waitFor(app, `(() => {
    const diagrams = Array.from(document.querySelectorAll("[data-openwork-mermaid]"));
    return diagrams.length === 4 && diagrams.every((diagram) => diagram.getAttribute("aria-busy") === "false");
  })()`, { timeoutMs: 30_000, label: "all chat Mermaid diagrams settled" });

  const chatContract = await evalIn(app, `(() => {
    const diagrams = Array.from(document.querySelectorAll("[data-openwork-mermaid]"));
    const find = (text) => diagrams.find((diagram) => diagram.querySelector("[data-openwork-mermaid-source]")?.textContent?.includes(text));
    const valid = find("Inline Mermaid Start");
    const remote = find("No remote resources");
    const malformed = find("not-a-mermaid-diagram");
    const guarded = find("Guard node 250");
    const sourceVisible = (diagram) => diagram?.querySelector("[data-openwork-mermaid-source]")?.hidden === false;
    return {
      validRendered: valid?.dataset.openworkMermaidState === "rendered" && Boolean(valid.querySelector("svg")),
      controls: Boolean(valid?.querySelector("[data-openwork-mermaid-view='source']") && valid.querySelector("[data-openwork-mermaid-view='rendered']") && valid.querySelector("[data-openwork-mermaid-download]:not([hidden])")),
      unsafeFallback: remote?.dataset.openworkMermaidReason === "unsafe" && sourceVisible(remote) && !remote.querySelector("svg"),
      malformedFallback: malformed?.dataset.openworkMermaidReason === "invalid" && sourceVisible(malformed) && !malformed.querySelector("svg"),
      guardFallback: guarded?.dataset.openworkMermaidReason === "complexity" && sourceVisible(guarded) && !guarded.querySelector("svg"),
      lightTheme: valid?.dataset.openworkMermaidTheme === "light",
      states: diagrams.map((diagram) => ({
        source: diagram.querySelector("[data-openwork-mermaid-source]")?.textContent?.slice(0, 40),
        state: diagram.getAttribute("data-openwork-mermaid-state"),
        reason: diagram.getAttribute("data-openwork-mermaid-reason"),
        theme: diagram.getAttribute("data-openwork-mermaid-theme"),
      })),
    };
  })()`);
  expect(chatContract, JSON.stringify(chatContract)).toMatchObject({
    validRendered: true,
    controls: true,
    unsafeFallback: true,
    malformedFallback: true,
    guardFallback: true,
    lightTheme: true,
  });

  const toggleContract = await evalIn(app, `(() => {
    const diagram = Array.from(document.querySelectorAll("[data-openwork-mermaid]")).find((item) => item.textContent?.includes("Inline Mermaid Start"));
    diagram?.querySelector("[data-openwork-mermaid-view='source']")?.click();
    const source = diagram?.dataset.openworkMermaidState === "source" && diagram.querySelector("[data-openwork-mermaid-source]")?.hidden === false;
    diagram?.querySelector("[data-openwork-mermaid-view='rendered']")?.click();
    return source && diagram?.dataset.openworkMermaidState === "rendered";
  })()`);
  expect(toggleContract).toBe(true);

  const downloadContract = await evalIn(app, `(async () => {
    const diagram = Array.from(document.querySelectorAll("[data-openwork-mermaid]")).find((item) => item.textContent?.includes("Inline Mermaid Start"));
    const button = diagram?.querySelector("[data-openwork-mermaid-download]");
    if (!button) return false;
    return await new Promise((resolve) => {
      const listener = (event) => {
        if (!(event.target instanceof HTMLAnchorElement) || !event.target.download.endsWith(".svg")) return;
        event.preventDefault();
        clearTimeout(timer);
        document.removeEventListener("click", listener, true);
        resolve(event.target.href.startsWith("blob:"));
      };
      const timer = setTimeout(() => {
        document.removeEventListener("click", listener, true);
        resolve(false);
      }, 2_000);
      document.addEventListener("click", listener, true);
      button.click();
    });
  })()`, { awaitPromise: true });
  expect(downloadContract).toBe(true);

  await control(app, "eval.mermaid.set_theme", { mode: "dark" });
  expect(await evalIn(app, `(() => {
    const diagram = Array.from(document.querySelectorAll("[data-openwork-mermaid]")).find((item) => item.textContent?.includes("Inline Mermaid Start"));
    diagram?.querySelector("[data-openwork-mermaid-view='source']")?.click();
    return diagram?.dataset.openworkMermaidState === "source";
  })()`)).toBe(true);
  await waitFor(app, `(() => {
    const diagram = Array.from(document.querySelectorAll("[data-openwork-mermaid]")).find((item) => item.textContent?.includes("Inline Mermaid Start"));
    return diagram?.getAttribute("data-openwork-mermaid-theme") === "dark" && diagram?.getAttribute("data-openwork-mermaid-state") === "source";
  })()`, {
    timeoutMs: 30_000,
    label: "dark theme rerender preserved the selected source view",
  });
  expect(await evalIn(app, `document.documentElement.dataset.theme === "dark" && Boolean(document.querySelector("[data-openwork-mermaid-theme='dark'] svg")) && document.querySelector("[data-openwork-mermaid-theme='dark'] [data-openwork-mermaid-source]")?.hidden === false`)).toBe(true);

  await control(app, "browser.open_url", { url: "about:blank" }).catch(() => undefined);
  await waitFor(app, `window.__openworkControl.listActions().some((action) => action.id === "eval.markdown_primitive.seed_artifact" && !action.disabled)`, {
    timeoutMs: 30_000,
    label: "Mermaid artifact fixture available",
  });
  await control(app, "eval.markdown_primitive.seed_artifact");
  await clickButton(app, "markdown-primitive-proof.md");
  await waitFor(app, `Boolean(document.querySelector("[data-openwork-markdown-preview] [data-openwork-mermaid-state='rendered'] svg"))`, {
    timeoutMs: 30_000,
    label: "fenced Mermaid rendered in Markdown artifact preview",
  });
  expect(await evalIn(app, `document.querySelector("[data-openwork-markdown-preview] [data-openwork-mermaid-source]")?.textContent?.includes("Artifact Mermaid Start")`)).toBe(true);

  await control(app, "eval.markdown_primitive.seed_artifact", { standalone: true });
  await clickButton(app, "standalone-mermaid-proof.mmd");
  await waitFor(app, `Boolean(document.querySelector("[data-openwork-mermaid-artifact] [data-openwork-mermaid-state='rendered'] svg"))`, {
    timeoutMs: 30_000,
    label: "standalone mmd artifact rendered",
  });
  expect(await evalIn(app, `document.body.innerText.includes("standalone-mermaid-proof.mmd") && Array.from(document.querySelectorAll("button")).some((button) => button.textContent?.trim() === "Edit")`)).toBe(true);
  expect(await evalIn(app, `(() => {
    const button = document.querySelector("button[aria-label='Artifact actions']");
    button?.click();
    return Boolean(button);
  })()`)).toBe(true);
  const rawDownloadSelector = `[role="menuitem"]`;
  await waitFor(app, `Array.from(document.querySelectorAll(${JSON.stringify(rawDownloadSelector)})).some((item) => item.textContent?.trim() === "Download")`, { timeoutMs: 10_000, label: "raw Mermaid artifact download action" });
  expect(await evalIn(app, `Array.from(document.querySelectorAll(${JSON.stringify(rawDownloadSelector)})).some((item) => item.textContent?.trim() === "Download")`)).toBe(true);

});
