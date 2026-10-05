# Imports and synchronization

Identify one source of truth for each field. Define which records can be created, changed or left unchanged. Missing, blank and explicit-null fields can have different meanings in the destination. Do not overwrite a target field with an absent source field.

Use stable keys and preserve a source-to-target ID map. A human-readable name is a weak key. Check one-to-one, one-to-many and many-to-one mappings separately. For incremental updates, retain the source cursor or last checked version only after the corresponding changes have a known outcome.

Validate a sample that contains a new record, an existing record and a missing-value case. Check field types, time zones, enumeration values and account scope. A preview that passes schema validation can still point to the wrong account.

Before further batches, inspect the completed batch's actual destination state. Rate limits and errors do not prove that no write occurred. Save completed IDs and uncertain IDs separately; stop on an unexplained difference. Do not retry an uncertain write automatically. Produce a useful rejected-row file without access tokens or private content beyond the user's selected data.
