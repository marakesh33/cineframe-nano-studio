import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the CineFrame studio", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>CineFrame — Nano Movie Studio<\/title>/i);
  assert.match(html, /Вставь текст — получи готовый ролик/);
  assert.match(html, /Промпт сцен и видео/);
  assert.match(html, /СОЗДАТЬ ГОТОВОЕ ВИДЕО/);
  assert.doesNotMatch(html, /codex-preview|Building your site|react-loading-skeleton/i);
});

test("keeps scene generation varied and reference-driven", async () => {
  const [page, nanoRoute] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/nano/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /psychology-style-old-soft\.jpg/);
  assert.match(page, /Build a varied story-driven sequence instead of a portrait series/);
  assert.match(page, /Change the subject, posture and setting from neighboring frames/);
  assert.match(nanoRoute, /const VISUAL_ROLES = \[/);
  assert.match(nanoRoute, /ACTION DETAIL:/);
  assert.match(nanoRoute, /ATMOSPHERIC LOCATION:/);
  assert.match(nanoRoute, /SEQUENCE DIVERSITY — STRICT:/);
  assert.match(nanoRoute, /no seated person, chair, armchair, sofa, bed/i);
});
