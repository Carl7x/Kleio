# Memory

Memory is a native product module using the product database. The engine performs bounded extraction; it does not own the bank or its scheduling.

## Layers

1. Current durable facts, preferences and decisions, with a readable `MEMORY.md` projection.
2. Daily revision traces: distilled changes and evidence references, distinct from raw conversation history.
3. People and relationships: stable IDs and explicitly supported relations, with readable people pages.
4. Runtime bank/index: versions, sources, validity, forgetting blocks, full-text index and extraction watermarks.

Short-term conversation history remains separate. Substantive turns can retrieve both claims and past messages; the model makes associations. Retrieval uses lexical matching, including Chinese bigrams, and does not claim vector semantics.

## Automatic maintenance

After a quiet interval, the product supplies a bounded continuous conversation window to tool-free extraction. Deterministic checks validate schema, exact user-source quotations, credentials exclusion and supported relationships. Accepted claims are stored automatically. Assistant suggestions and external text cannot serve as user statements.

Model extraction can misunderstand meaning despite correct quotations. Source/version inspection and correction remain part of the product contract.

Claims include scope, validity and provenance. Explicit edits require an expected version. Forgetting blocks ordinary recall, idle re-extraction, and later work or review injection of the forgotten wording. It is not physical erasure: the conversation row and the bank record remain. Unrelated history stays eligible for recall. Explicit explain still shows the source, the replacement chain, and whether use has stopped.

Markdown files are database projections. Hash checks preserve conflicting external edits and report them through runtime health. Editing a managed file does not silently replace the authoritative bank.

## Limits

Cross-conversation same-name identities are not automatically merged. Alias resolution, rich groups, semantic retrieval, complete erasure/backup policy and nightly alignment synthesis require further work. Private cases and raw validation transcripts do not belong in source control.
