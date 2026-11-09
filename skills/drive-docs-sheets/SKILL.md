---
name: drive-docs-sheets
description: Use when the user asks to find, read, create, edit, move, rename, share or trash Google Drive files, Docs, Sheets or Contacts.
---

# Drive, Docs, Sheets and Contacts

## Drive
- `google_drive_search` (name and content; filter with `mime_type` or `folder_id`), `google_drive_get` for one file.
- `google_drive_create_folder`, `google_drive_move`, `google_drive_rename`, `google_drive_trash` and `google_drive_share` all ask for approval. Trash is restorable from Drive; nothing here deletes permanently.
- `google_drive_share` gives one named person reader, commenter or writer access. Default to `reader`. Public links and ownership transfer are not available.

## Docs
`google_docs_read` → `google_docs_create`, `google_docs_append`, `google_docs_replace_text` (replaces every match; check the count it reports). Read the document before editing it.

## Sheets
- `google_sheets_metadata` shows tabs and row counts; `google_sheets_read` takes A1 ranges (`Budget!A1:D20`).
- `google_sheets_append` adds rows below existing data. `google_sheets_update_range` writes a fixed range and refuses to overwrite filled cells unless `overwrite` is true. Only set `overwrite` when the user has agreed to replace those values.
- `rows` is a list of rows, each a list of cell values.

## Contacts
Search with `google_contacts_search` before `google_contacts_create` so you don't add duplicates. `google_contacts_update` touches only the fields you pass. `google_contacts_delete` has a 30-day undo in the People app.
