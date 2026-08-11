import { test } from "node:test";
import assert from "node:assert/strict";
import { extractDesign } from "./design-extract.js";

function withMockFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

test("no apiKey -> empty extraction, no network call", async () => {
  let called = false;
  await withMockFetch(
    (async () => {
      called = true;
      throw new Error("should not be called");
    }) as typeof fetch,
    async () => {
      const result = await extractDesign("some plan text", { model: "m" });
      assert.deepEqual(result, { creates: [], touches: [], dependsOn: [], summary: "" });
    },
  );
  assert.equal(called, false);
});

test("valid JSON response parses correctly", async () => {
  await withMockFetch(
    (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ creates: ["Foo"], touches: ["a.ts"], dependsOn: [], summary: "does foo" }) } }],
        }),
        { status: 200 },
      )) as typeof fetch,
    async () => {
      const result = await extractDesign("plan", { model: "m", apiKey: "key" });
      assert.deepEqual(result, { creates: ["Foo"], touches: ["a.ts"], dependsOn: [], summary: "does foo" });
    },
  );
});

test("markdown-fenced JSON is unwrapped", async () => {
  await withMockFetch(
    (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "```json\n" + JSON.stringify({ creates: [], touches: [], dependsOn: [], summary: "s" }) + "\n```" } }],
        }),
        { status: 200 },
      )) as typeof fetch,
    async () => {
      const result = await extractDesign("plan", { model: "m", apiKey: "key" });
      assert.equal(result.summary, "s");
    },
  );
});

test("malformed JSON after one retry fails soft to empty", async () => {
  let calls = 0;
  await withMockFetch(
    (async () => {
      calls++;
      return new Response(JSON.stringify({ choices: [{ message: { content: "not json at all" } }] }), { status: 200 });
    }) as typeof fetch,
    async () => {
      const result = await extractDesign("plan", { model: "m", apiKey: "key" });
      assert.deepEqual(result, { creates: [], touches: [], dependsOn: [], summary: "" });
    },
  );
  assert.equal(calls, 2);
});

test("network error fails soft to empty", async () => {
  await withMockFetch(
    (async () => {
      throw new Error("network down");
    }) as typeof fetch,
    async () => {
      const result = await extractDesign("plan", { model: "m", apiKey: "key" });
      assert.deepEqual(result, { creates: [], touches: [], dependsOn: [], summary: "" });
    },
  );
});
