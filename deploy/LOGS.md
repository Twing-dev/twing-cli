# Coordinator logs -- cheat sheet

`twing serve` writes two date-rotated JSONL files (one JSON object per line,
UTC dates) to **`/var/log/twing-cli/`**, locally and in production:

| File | One line per |
|---|---|
| `http-YYYY-MM-DD.jsonl` | HTTP request + response |
| `llm-YYYY-MM-DD.jsonl` | LLM call: full prompt sent + reply (or error) |

- Kept 7 days, then deleted automatically (`TWING_LOG_RETENTION_DAYS`).
- Secrets (`Authorization`, any `*token*`/`*secret*`/`*password*` field) are
  replaced with `[redacted]`. HTTP bodies are capped at 64 KB; LLM prompts are
  logged in full.
- Production (Docker): the same path on the host, bind-mounted from the
  container. Run the commands below on the host, no `docker exec` needed.
- Turn off: `TWING_LOG_DISABLED=1`, then restart. Move: `TWING_LOG_DIR=<dir>`.
- Local one-time setup: `sudo mkdir -p /var/log/twing-cli && sudo chown $USER /var/log/twing-cli`

## Fields you can search on

| Field | http | llm | Notes |
|---|---|---|---|
| `requestId` | ✓ | ✓ | Same value on an HTTP line and every LLM call it caused, including background work it scheduled. Also returned as the `X-Request-Id` response header. |
| `groupId` | ✓ | ✓ | Best id for "everything about this piece of work". Absent on `design_extract` (runs before the design exists). |
| `designId` | ✓ | ✓ | |
| `sessionId` | ✓ | ✓ | The Claude Code session. The way to find `design_extract` calls. |
| `purpose` | | ✓ | `design_extract`, `semantic_check`, `design_chat`, `overview_resynthesis`, `group_overview_resynthesis` |
| `developerId`, `status`, `path`, `method`, `durationMs` | ✓ | | |
| `model`, `provider`, `endpoint`, `messages`, `response`, `error`, `durationMs` | | ✓ | `model` + `messages` is the exact request body sent to the provider. |
| `otherDesignId`, `otherGroupId` | | ✓ | `semantic_check` only: the design it was compared against. |
| `designIds` | | ✓ | `group_overview_resynthesis` only: every member design. |

## Commands

All commands assume `cd /var/log/twing-cli`. Swap `*` for a date
(`http-2026-10-11.jsonl`) to narrow to one day.

### What's there

```sh
ls -lh                                   # files and sizes
du -sh .                                 # total disk used
tail -f http-$(date -u +%F).jsonl        # watch HTTP traffic live
tail -f llm-$(date -u +%F).jsonl         # watch LLM calls live
```

### LLM calls by type

```sh
grep -h '"purpose":"design_extract"'             llm-*.jsonl   # plan -> design
grep -h '"purpose":"semantic_check"'             llm-*.jsonl   # design-vs-design conflict check
grep -h '"purpose":"design_chat"'                llm-*.jsonl   # "Ask this design" chat
grep -h '"purpose":"overview_resynthesis"'       llm-*.jsonl   # one design's overview rewrite
grep -h '"purpose":"group_overview_resynthesis"' llm-*.jsonl   # group overview rewrite

grep -ho '"purpose":"[a-z_]*"' llm-*.jsonl | sort | uniq -c   # count per type
```

### Everything for one piece of work

```sh
grep -h '<groupId>'   *.jsonl            # group: HTTP + LLM (all but design_extract)
grep -h '<designId>'  *.jsonl            # one design
grep -h '<sessionId>' *.jsonl            # one Claude session, incl. design_extract
grep -h '<requestId>' *.jsonl            # one request + every LLM call it caused
```

Find the `design_extract` call for a group (it has no group id): take the
`requestId` from the HTTP line that registered the design, then grep for it.

```sh
grep -h '<groupId>' http-*.jsonl | grep '/v1/designs/check'    # -> note "requestId"
grep -h '<requestId>' llm-*.jsonl                               # extraction + conflict check
```

### Combine filters

```sh
grep -h '"purpose":"overview_resynthesis"' llm-*.jsonl | grep '<groupId>'   # one type, one group
grep -h '<developerId>' http-*.jsonl                                         # one developer's requests
```

### Failures and slow calls

```sh
grep -h '"error":' llm-*.jsonl                                   # failed LLM calls
grep -hE '"status":5[0-9]{2}' http-*.jsonl                       # server errors (incl. stack)
grep -hE '"status":4[0-9]{2}' http-*.jsonl                       # client errors (401, 404, 426...)
grep -hE '"durationMs":[0-9]{5,}' *.jsonl                        # took 10s or more
```

### One request route

```sh
grep -h '"path":"/v1/designs/check"' http-*.jsonl                # registrations
grep -h '"path":"/v1/designs/[^"]*/amend"' http-*.jsonl          # amends
grep -h '"method":"POST"' http-*.jsonl                           # all writes
```

## Reading a line

`grep` prints raw JSON. To make one readable, pipe it through whichever is
installed:

```sh
grep -h '<requestId>' llm-*.jsonl | jq .                         # jq
grep -h '<requestId>' llm-*.jsonl | python3 -m json.tool         # python3

# just the prompt, message by message
grep -h '<requestId>' llm-*.jsonl | jq -r '.messages[] | "--- \(.role)\n\(.content)"'
# just the reply
grep -h '<requestId>' llm-*.jsonl | jq -r '.response // .error'
# compact timeline: time, type, group, outcome
grep -h '<groupId>' llm-*.jsonl | jq -r '[.ts, .purpose, .groupId, (.error // "ok")] | @tsv'
```
