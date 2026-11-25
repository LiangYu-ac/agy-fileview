<div align="center">
  <img src="assets/logo.svg" alt="FileView Explorer logo" width="84" height="84" />
  <h1>FileView Explorer (<code>agy-fileview</code>)</h1>
  <p><strong>Enhanced side-panel file explorer MCP App plugin for Google Antigravity with full right-click file operations.</strong></p>
  <p><a href="README.zh-CN.md">简体中文</a> · English</p>
</div>

<div align="center">
  <img src="assets/preview.png" alt="FileView Preview" width="320" />
</div>

---

## AI One-Click Install (Copy & Paste Prompt)

Paste this prompt directly into **Antigravity** (or any AI coding assistant) to automatically install or update `agy-fileview` and activate its MCP server:

```text
Please install (or update) the agy-fileview plugin from https://github.com/LiangYu-ac/agy-fileview.git into my Antigravity global plugins directory:
1. Check OS: on Windows use "$env:USERPROFILE\.gemini\config\plugins\agy-fileview", on macOS/Linux use "$HOME/.gemini/config/plugins/agy-fileview".
2. If the directory already exists as a git repo, run `git pull`; otherwise run `git clone https://github.com/LiangYu-ac/agy-fileview.git <target_dir>`. (No `npm install` is required—pre-built `dist/server.mjs` and `dist/app.html` are included.)
3. Verify `GetAllPlugins` (or `agy plugin list`) detects `agy-fileview` as enabled, refresh/connect the `agy-fileview_explorer` MCP server if needed, and tell me how to open FileView.
```

---

## Where to Open & Use

Because Antigravity's official plugin API does not allow patching built-in panel menus directly, **FileView** runs as an official **MCP App** (`aux_pane` + `global`) file explorer inside Antigravity. Open **FileView** from any of these 4 entrypoints:

1. **Overview Panel**: Click **Overview** at the top-right of any conversation → **Plugins** → **FileView**
2. **Side Panel New Tab (`+`)**: Click **`+`** on the side panel tab bar (or **`⋯`** More actions in the conversation header) → **Plugins** → **FileView**
3. **Left Sidebar (Full-Page Mode)**: Click **Plugins** in the left sidebar → **FileView**
4. **Chat Command / Natural Language**: Type `/fileview` in chat, or ask the agent to open FileView or reveal a file in Explorer

> **Recommended Tip**: After opening **FileView** in the side panel, right-click the **FileView** tab and choose **Pin Tab** to keep it pinned alongside your conversations. Inside FileView, right-click any file, folder, or blank area to reveal its location in Explorer or run file actions.

---

## Why `agy-fileview`?

In the Antigravity desktop App, the built-in Files panel only offers a basic copy action on right-click. **FileView** provides a full-featured, native-themed file manager right inside your side panel with complete file & folder operations.

## Features

- **Right-Click Context Menu for Files, Folders & Empty Space**:
  - **Reveal in File Explorer / Finder** (`explorer.exe /select` on Windows, `open -R` on macOS, `FileManager1` / `xdg-open` on Linux)
  - **Open with Default App**
  - **Open in Antigravity Side Pane** (`toggle-aux-pane`, with automatic quick text preview fallback in full-page view)
  - **Open Terminal Here** (Windows Terminal `wt.exe` with PowerShell fallback, macOS Terminal, Linux terminal emulators)
  - **Copy Full Path / Relative Path / File or Folder Name** (3-tier clipboard copy including host OS fallback)
  - **Attach to Chat Context** (`updateModelContext`, when opened in a conversation side panel)
  - **Standard File Operations**: New File, New Folder, Rename (`F2`), Copy (`Ctrl+C`), Cut (`Ctrl+X`), Paste (`Ctrl+V`), Duplicate, Move to Recycle Bin / Trash (`Delete`, with optional permanent delete), and **Properties** (`Alt+Enter`, including folder counts & on-demand SHA-256 checksum)
- **Workspace & Location Switcher**: Auto-discovers Antigravity projects, pinned folders, OS shortcuts (Home, Desktop, Documents, Downloads), drives, and jump-to-path navigation.
- **Fast Filter & Recursive Search**: Instant filter over the expanded tree plus recursive deep filename search.
- **Native Antigravity Theming & Bilingual UI**: Automatically syncs Light/Dark theme and host CSS variables, with one-click Chinese/English toggle (`中` / `EN`).
- **Zero Runtime Dependencies**: Pre-bundled `dist/server.mjs` and `dist/app.html` run directly with Node.js—no `npm install` needed to use the plugin.

## Manual Installation (CLI)

Clone directly into your Antigravity global plugins directory:

**Windows PowerShell:**

```powershell
git clone https://github.com/LiangYu-ac/agy-fileview.git "$env:USERPROFILE\.gemini\config\plugins\agy-fileview"
```

**macOS / Linux:**

```bash
git clone https://github.com/LiangYu-ac/agy-fileview.git ~/.gemini/config/plugins/agy-fileview
```

Antigravity automatically discovers plugins in `~/.gemini/config/plugins/` without requiring a restart.

## Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| `ArrowUp` / `ArrowDown` | Move selection |
| `ArrowRight` / `ArrowLeft` | Expand / collapse folder |
| `Enter` | Open folder as root, or open file in Antigravity |
| `F2` | Rename |
| `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | Copy / Cut / Paste |
| `Delete` | Move to Recycle Bin |
| `Alt+Enter` | View Properties |
| `Escape` | Close context menu or dialog |

## Development & Building

```bash
npm install
npm run build
npm test
```

`npm run build` bundles `src/server.mjs` → `dist/server.mjs` and `src/ui/` → `dist/app.html` using `esbuild`.

## License

[MIT](LICENSE)
