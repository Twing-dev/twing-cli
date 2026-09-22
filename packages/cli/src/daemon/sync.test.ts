import { test } from "node:test";
import assert from "node:assert/strict";
import { Syncer } from "./sync.js";
import { getCliVersion } from "../version.js";
import { withMockFetch, jsonResponse, withHome, cacheToken } from "../test-support.js";

/** pollVersions is private -- this is whitebox testing of the class's own
 * internals rather than exercising the 5s real timer, same reasoning as
 * calling any other private method directly in a unit test. */
function pollVersions(syncer: Syncer): Promise<void> {
  return (syncer as unknown as { pollVersions(): Promise<void> }).pollVersions();
}

test("Syncer.versionMismatch: null before any version check has run", () => {
  const syncer = new Syncer();
  try {
    assert.equal(syncer.versionMismatch(), null);
  } finally {
    syncer.stop();
  }
});

test("Syncer.versionMismatch: null once the server reports the same version as this client", async () => {
  const syncer = new Syncer();
  try {
    syncer.registerProjectServer("proj-1", "http://coordinator.example");
    await withMockFetch(
      async () => jsonResponse({ version: getCliVersion() }),
      () => pollVersions(syncer),
    );
    assert.equal(syncer.versionMismatch(), null);
  } finally {
    syncer.stop();
  }
});

test("Syncer.versionMismatch: reflects a mocked /v1/version response that differs from this client's own version", async () => {
  const syncer = new Syncer();
  try {
    syncer.registerProjectServer("proj-1", "http://coordinator.example");
    await withMockFetch(
      async () => jsonResponse({ version: "0.0.1-does-not-match" }),
      () => pollVersions(syncer),
    );
    const mismatch = syncer.versionMismatch();
    assert.ok(mismatch);
    assert.equal(mismatch.clientVersion, getCliVersion());
    assert.equal(mismatch.serverVersion, "0.0.1-does-not-match");
  } finally {
    syncer.stop();
  }
});

test("Syncer.versionMismatch: a failed /v1/version check is logged and skipped, not treated as a mismatch", async () => {
  const syncer = new Syncer();
  try {
    syncer.registerProjectServer("proj-1", "http://coordinator.example");
    await withMockFetch(
      async () => {
        throw new Error("network error");
      },
      () => pollVersions(syncer),
    );
    assert.equal(syncer.versionMismatch(), null);
  } finally {
    syncer.stop();
  }
});

// --- stopAndFlush --------------------------------------------------------
//
// Claims sit in a pending batch until the next FLUSH_INTERVAL_MS tick, so
// exiting without a final flush silently drops everything enqueued since
// the previous one. That was survivable while the daemon only exited on an
// explicit shutdown; idle-exit makes it a routine path.

test("Syncer.stopAndFlush: pushes the pending batch instead of dropping it", async () => {
  const serverUrl = "http://localhost:9999";
  await withHome(async () => {
    cacheToken(serverUrl, "pat");
    const syncer = new Syncer();
    syncer.registerProjectServer("proj-1", serverUrl);
    syncer.enqueue(
      { projectId: "proj-1", developerId: "dev@example.com", sessionId: "s1", symbolId: "src/a.ts::f", stage: "firm", ts: Date.now(), ttlMs: 60_000 } as never,
      [],
    );

    const urls: string[] = [];
    const mockFetch = (async (url: string | URL) => {
      urls.push(String(url));
      return jsonResponse({ findings: [] });
    }) as typeof fetch;

    await withMockFetch(mockFetch, () => syncer.stopAndFlush());
    assert.ok(
      urls.some((u) => /\/v1\/claims$/.test(u)),
      "the batch enqueued since the last tick must reach the coordinator before the process exits",
    );
  });
});

test("Syncer.stopAndFlush: a failing coordinator still lets the daemon exit", async () => {
  const serverUrl = "http://localhost:9999";
  await withHome(async () => {
    cacheToken(serverUrl, "pat");
    const syncer = new Syncer();
    syncer.registerProjectServer("proj-1", serverUrl);
    syncer.enqueue(
      { projectId: "proj-1", developerId: "dev@example.com", sessionId: "s1", symbolId: "src/a.ts::f", stage: "firm", ts: Date.now(), ttlMs: 60_000 } as never,
      [],
    );

    const throwingFetch = (async () => {
      throw new Error("coordinator unreachable");
    }) as typeof fetch;

    // Must resolve, not reject: shutdown can't be held hostage by a server
    // that happens to be down.
    await withMockFetch(throwingFetch, () => syncer.stopAndFlush());
  });
});

// ---------------------------------------------------------------------------
// Design review (2026-09): escalations and design links
// ---------------------------------------------------------------------------

/** `poll` is private for the same whitebox reason `pollVersions` above is --
 * driving the real 5s timer would make these tests slow and flaky. */
function poll(syncer: Syncer): Promise<void> {
  return (syncer as unknown as { poll(): Promise<void> }).poll();
}

const escalation = {
  commentId: "c1",
  designId: "d1",
  projectId: "proj-1",
  designSummary: "Add a retry budget",
  comment: "why 30s?",
  escalatedAt: 1,
  url: "https://monitor.example/?repos=proj-1&tab=designs&focus=d1",
};

/** Routes the three GETs a poll cycle makes. Anything unrecognised 404s, so
 * a new request appearing in the poll loop fails loudly here rather than
 * silently taking a default. */
function pollResponder(overrides: { escalations?: unknown[]; monitorUrl?: string } = {}): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/v1/version")) return jsonResponse({ version: getCliVersion(), ...(overrides.monitorUrl ? { monitorUrl: overrides.monitorUrl } : {}) });
    if (url.includes("/v1/notices")) return jsonResponse({ items: [] });
    if (url.includes("/v1/escalations")) return jsonResponse({ items: overrides.escalations ?? [] });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

test("Syncer.registerDeveloperProject: a session with no claims yet still joins the poll set", async () => {
  await withHome(async () => {
    cacheToken("http://coordinator.example", "test-token");
    const syncer = new Syncer();
    try {
      // Deliberately no `enqueue` -- that is the whole point. A fresh
      // SessionStart has produced no claims by definition, and keying the
      // poll set on claims alone made the escalation banner impossible at
      // exactly the moment it exists for.
      syncer.registerDeveloperProject("dev@example.com", "proj-1", "http://coordinator.example");
      await withMockFetch(pollResponder({ escalations: [escalation] }), () => poll(syncer));
      assert.equal(syncer.escalationsFor("dev@example.com").length, 1);
    } finally {
      syncer.stop();
    }
  });
});

// Notices age out after NOTICE_FRESHNESS_MS because they are ephemeral
// hints. An escalation is durable coordinator state -- a reviewer is waiting
// -- and ageing one out would silently drop review feedback.
test("Syncer.escalationsFor: not aged out the way a notice is", async () => {
  await withHome(async () => {
    cacheToken("http://coordinator.example", "test-token");
    const syncer = new Syncer();
    try {
      syncer.registerDeveloperProject("dev@example.com", "proj-1", "http://coordinator.example");
      await withMockFetch(pollResponder({ escalations: [escalation] }), () => poll(syncer));

      const originalNow = Date.now;
      try {
        // Well past NOTICE_FRESHNESS_MS (10 minutes).
        Date.now = () => originalNow() + 60 * 60 * 1000;
        assert.equal(syncer.escalationsFor("dev@example.com").length, 1, "an escalation stops when acknowledged, not when it gets old");
      } finally {
        Date.now = originalNow;
      }
    } finally {
      syncer.stop();
    }
  });
});

test("Syncer.escalationsFor: an acknowledged escalation disappears on the next poll", async () => {
  await withHome(async () => {
    cacheToken("http://coordinator.example", "test-token");
    const syncer = new Syncer();
    try {
      syncer.registerDeveloperProject("dev@example.com", "proj-1", "http://coordinator.example");
      await withMockFetch(pollResponder({ escalations: [escalation] }), () => poll(syncer));
      assert.equal(syncer.escalationsFor("dev@example.com").length, 1);

      // The server now excludes it, so a wholesale replace is what makes an
      // acknowledgement take effect with no local bookkeeping.
      await withMockFetch(pollResponder({ escalations: [] }), () => poll(syncer));
      assert.deepEqual(syncer.escalationsFor("dev@example.com"), []);
    } finally {
      syncer.stop();
    }
  });
});

// An unreachable coordinator must not read as "the reviewer withdrew their
// question".
test("Syncer.escalationsFor: a failed poll keeps the previous list rather than clearing it", async () => {
  await withHome(async () => {
    cacheToken("http://coordinator.example", "test-token");
    const syncer = new Syncer();
    try {
      syncer.registerDeveloperProject("dev@example.com", "proj-1", "http://coordinator.example");
      await withMockFetch(pollResponder({ escalations: [escalation] }), () => poll(syncer));

      await withMockFetch(
        (async (input: RequestInfo | URL) => {
          if (String(input).includes("/v1/escalations")) throw new Error("network down");
          return jsonResponse({ version: getCliVersion(), items: [] });
        }) as typeof fetch,
        () => poll(syncer),
      );
      assert.equal(syncer.escalationsFor("dev@example.com").length, 1);
    } finally {
      syncer.stop();
    }
  });
});

test("Syncer: a coordinator that publishes no monitorUrl yields no design links at all", async () => {
  await withHome(async () => {
    cacheToken("http://coordinator.example", "test-token");
    const syncer = new Syncer();
    try {
      syncer.registerDeveloperProject("dev@example.com", "proj-1", "http://coordinator.example");
      await withMockFetch(pollResponder(), () => poll(syncer));
      assert.equal(syncer.monitorUrlForProject("proj-1"), undefined);

      // No dashboard means no link to give, and a reminder with no link is
      // just noise in the agent's context -- so the design fetch is skipped
      // entirely rather than returning ids the agent can do nothing with.
      const links = await withMockFetch(
        (async () => {
          throw new Error("should never be called without a monitor URL");
        }) as typeof fetch,
        () => syncer.designLinksFor("dev@example.com", "proj-1", "session-1"),
      );
      assert.deepEqual(links, []);
    } finally {
      syncer.stop();
    }
  });
});

test("Syncer.designLinksFor: builds a review link per open design, cached for the session", async () => {
  await withHome(async () => {
    cacheToken("http://coordinator.example", "test-token");
    const syncer = new Syncer();
    try {
      syncer.registerDeveloperProject("dev@example.com", "proj-1", "http://coordinator.example");
      await withMockFetch(pollResponder({ monitorUrl: "https://monitor.example" }), () => poll(syncer));

      let designCalls = 0;
      const responder = (async (input: RequestInfo | URL) => {
        if (String(input).includes("/v1/designs")) {
          designCalls += 1;
          return jsonResponse({ items: [{ id: "d1", projectId: "proj-1", summary: "Add a retry budget" }] });
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch;

      const links = await withMockFetch(responder, () => syncer.designLinksFor("dev@example.com", "proj-1", "session-1"));
      assert.deepEqual(links, [
        { designId: "d1", projectId: "proj-1", summary: "Add a retry budget", url: "https://monitor.example/?repos=proj-1&tab=designs&focus=d1" },
      ]);

      // The reply path reads this synchronously, so it has to be there
      // without a second round trip.
      assert.deepEqual(syncer.cachedDesignLinksFor("session-1"), links);
      await withMockFetch(responder, () => syncer.designLinksFor("dev@example.com", "proj-1", "session-1"));
      assert.equal(designCalls, 1, "a repeated ask inside one session costs nothing");
    } finally {
      syncer.stop();
    }
  });
});

test("Syncer.cachedDesignLinksFor: empty for a session nothing has been fetched for yet", () => {
  const syncer = new Syncer();
  try {
    assert.deepEqual(syncer.cachedDesignLinksFor("never-seen"), []);
  } finally {
    syncer.stop();
  }
});

// Found in review: a `--no-auth` coordinator requires X-Twing-Developer-Id on
// every /v1/* request and answers 400 without it, so omitting the header meant
// escalations never arrived at all in that mode -- and the notices poll next
// to it had the same gap already.
test("Syncer: poll requests carry the X-Twing-Developer-Id header a --no-auth coordinator requires", async () => {
  await withHome(async () => {
    cacheToken("http://coordinator.example", "test-token");
    const syncer = new Syncer();
    try {
      syncer.registerDeveloperProject("dev@example.com", "proj-1", "http://coordinator.example");
      const seen: { url: string; developerHeader: string | null }[] = [];
      await withMockFetch(
        (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          seen.push({ url, developerHeader: new Headers(init?.headers).get("x-twing-developer-id") });
          if (url.includes("/v1/version")) return jsonResponse({ version: getCliVersion() });
          return jsonResponse({ items: [] });
        }) as typeof fetch,
        () => poll(syncer),
      );

      for (const path of ["/v1/notices", "/v1/escalations"]) {
        const call = seen.find((c) => c.url.includes(path));
        assert.ok(call, `${path} was not requested`);
        assert.equal(call.developerHeader, "dev@example.com", `${path} must identify the developer for a --no-auth coordinator`);
      }
    } finally {
      syncer.stop();
    }
  });
});
