# Shared design documents

A design group has one generated, read-only document explaining the overall
problem and solution. This applies equally to single-repository registrations
(groups of one) and linked registrations sharing a `groupId`.

The document uses these sections in order: Problem statement, Solution abstract,
Full solution, Implementation details, Risks and limitations, and Validation.
Only sections supported by the source material appear. Each contains Markdown.
The original summaries, plans, declarations, ownership, and review comments
remain on their individual designs.

## Generation and storage

Migration `0023_shared-design-documents` adds `design_documents` and source-change
triggers on `designs`. Registration, plan replacement, amendments, overview edits,
accepted rephrases, relinking, project reassignment, and deletion durably request
generation in the same transaction as the source write. Relinking requests both
the old and new groups. Heartbeats and status transitions do not request work.
The triggers also cover writes from older coordinator versions after rollback.

The production server starts `DesignDocumentService` in `main.ts`. Its sequential
worker polls pending requests every second, combining closely spaced linked
registrations, and resumes pending or interrupted running requests at startup.
Embedders using `createApp` directly must inject and start their own service;
tests can drain it with `processPending()` without timers or a real provider.

Generation reads all stored members, independently of monitor pagination. It
sends full plans, deduplicates identical plans, and includes current summaries
and each member's declared changes. The input fingerprint includes the prompt
version and actual source content. Version counters alone are insufficient
because linked summary updates can occur without incrementing those counters.
Publication runs in a short transaction and checks the fingerprint and persisted
request version again. A source change during generation discards that result.

The service uses the existing provider selection and
`TWING_<PROVIDER>_RESYNTHESIS_MODEL` setting. Each call has a 60-second deadline.
Malformed output is retried once; other failures terminate the request. Input
over 100,000 UTF-8 bytes is marked unavailable rather than truncated; validated
output is capped at 60,000 bytes. No provider, model failures, and oversized
inputs preserve registration, any previous document, and all original plans.
Failures store safe codes rather than provider error text. A source change or an
explicit generation request retries failed or unavailable work.

## API and monitor

`GET /v1/designs/:id/document` returns `{groupId, revision, status, stale, content?}`.
Status is `missing`, `pending`, `running`, `ready`, `failed`, or `unavailable`.
`stale` means a previous document exists but no longer matches current sources.

`POST /v1/designs/:id/document/regenerate` returns `202` after persisting a request.
The same ready fingerprint or pending request is reused rather than paying for
another model call. The response contains no published text.

Both endpoints require access to the anchor and every current source project.
Reads additionally require access to every project used by the published
document: a removed or relinked private source must not leak through stale prose.
Fully public documents are readable in observe mode; public viewers cannot
request generation. Restricted reads reveal no source-project names or content.

The monitor shows one document above the per-repository declarations and keeps
original overviews, owner editing, and plans in an expandable Originals section.
It polls pending documents every two seconds and ready documents every ten
seconds, shows stale and failure states, and offers generation or retry to
members. Generated Markdown uses the existing safe renderer. Reviewers can
highlight text in its sections and comment through the existing review rail.
Document anchors name the section (`document:<section>`), group, and published
revision; the coordinator rejects a comment if the document changed before
submission. Comments and replies are visible from any member of the group,
deduplicated in multi-repository views. After regeneration the quote is located
again: surviving words remain highlighted, missing words are marked outdated,
and changed revisions are indicated without discarding the discussion.

Migration `0024_design-document-comments` stores the anchor's document group,
revision, and published source projects. Quotes, comments, replies, notifications,
and activity entries require access to all current, published, and historical
source projects, including after a private contribution is relinked away.
Shared-document comments do not feed individual overview resynthesis. Original
summary, plan, and declaration comments retain their existing behavior.

Existing designs are not bulk-generated during migration. They retain their
current view until changed or explicitly generated. An older server without the
endpoint also retains the original view. Deploy the coordinator and monitor
changes together to enable the new presentation; no client or hook upgrade is
required for document generation.
