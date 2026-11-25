---
name: fileview
description: >-
  Open the FileView enhanced file explorer side panel or reveal files and
  folders in the OS file manager (Explorer / Finder). Use when the user invokes
  /fileview, wants to browse or right-click manage files, or asks to show or
  locate a file in Explorer.
---

# FileView Explorer

Use the `agy-fileview_explorer` MCP server tools to open the interactive file explorer UI or locate files directly in the OS file manager:

1. **Open the FileView side panel (`open_file_explorer`)**:
   - Call `agy-fileview_explorer` / `open_file_explorer` (optionally passing `{ "path": "<directory-or-workspace-path>" }`).
   - This opens the **FileView** tab in the Antigravity side panel, where the user can right-click any file or folder for full context-menu operations (reveal in Explorer, open with default app, open terminal here, copy full/relative path, attach to chat context, create, rename, copy/cut/paste, duplicate, move to recycle bin, and view properties).
2. **Reveal a specific file or folder directly (`reveal_in_explorer`)**:
   - Call `agy-fileview_explorer` / `reveal_in_explorer` with `{ "path": "<absolute-path>" }` to open Windows Explorer (or macOS Finder / Linux file manager) and highlight the item immediately.
