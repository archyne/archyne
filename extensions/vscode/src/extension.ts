import * as vscode from "vscode";
import { setAiContext } from "./ai";
import { associated, patternsFor } from "./association";
import { ArchyneEditorProvider } from "./editor";
import { FencePanels } from "./fenceEditor";
import { FenceLensProvider, OPEN_FENCE } from "./lens";

/**
 * The extension is a shell around the editor that already exists: it hands a
 * VS Code `TextDocument` to the same bundle the web app and the desktop app
 * run, and hands the edits back. What it adds is where it runs — beside the
 * file, in the tool the diagram is already committed from.
 *
 * Two ways in, because Mermaid lives in two places. A `.mmd` file gets the
 * custom editor, which owns the whole document. A fenced block in Markdown
 * gets a CodeLens and a panel bound to the block's range — which is where most
 * Mermaid in a repository actually is: a README, an ADR, a page under `docs/`.
 */
/** How long after activation a file opened as text is taken to be the race below. */
const STARTUP_MS = 10_000;

/**
 * VS Code 1.143 sometimes opens a file named on its command line — which is
 * what a double click in the file manager does — as text, before it applies
 * the person's `workbench.editorAssociations`, even when that says Archyne;
 * intermittently, so a race on its side — and then without asking for this
 * editor, so nothing would start the extension but the `mermaid` language it
 * contributes for those files (`onLanguage:mermaid`). For the first seconds
 * after it starts, such a tab is reopened on the canvas, once per file.
 * Later, a text tab is one the person chose (Reopen Editor With… Text
 * Editor) and is left alone; so is one with unsaved changes.
 */
function reopenAssociated(context: vscode.ExtensionContext): void {
  const done = new Set<string>();
  const fix = () => {
    const patterns = patternsFor(
      vscode.workspace.getConfiguration("workbench").get("editorAssociations"),
      ArchyneEditorProvider.viewType,
    );
    if (patterns.length === 0) return;
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (!(tab.input instanceof vscode.TabInputText) || tab.isDirty) continue;
        const uri = tab.input.uri;
        if (uri.scheme !== "file" || done.has(uri.toString())) continue;
        if (!associated(uri.path, patterns)) continue;
        done.add(uri.toString());
        void vscode.commands
          .executeCommand("vscode.openWith", uri, ArchyneEditorProvider.viewType, {
            viewColumn: group.viewColumn,
            preview: tab.isPreview,
            preserveFocus: !tab.isActive,
          })
          .then(() => vscode.window.tabGroups.close(tab));
      }
    }
  };
  fix();
  const watching = vscode.window.tabGroups.onDidChangeTabs(fix);
  const stop = setTimeout(() => watching.dispose(), STARTUP_MS);
  context.subscriptions.push(watching, { dispose: () => clearTimeout(stop) });
}

export function activate(context: vscode.ExtensionContext): void {
  // Generate's host side keeps its secrets in this context's SecretStorage.
  setAiContext(context);
  const appRoot = vscode.Uri.joinPath(context.extensionUri, "media", "app");

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      ArchyneEditorProvider.viewType,
      new ArchyneEditorProvider(appRoot),
      {
        // The canvas holds a parsed graph, a layout and an undo stack, none of
        // which survive the panel being torn down — and switching tabs is not
        // meant to be a way of discarding your history.
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      },
    ),
  );
  reopenAssociated(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("archyne.open", async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        void vscode.window.showInformationMessage("Open a .mmd file first.");
        return;
      }
      await vscode.commands.executeCommand(
        "vscode.openWith",
        target,
        ArchyneEditorProvider.viewType,
      );
    }),
  );

  // Markdown, and MDX where a language extension has registered it. Both are
  // selectors rather than a single `scheme: "file"` entry, so a diagram in an
  // untitled buffer or in a remote workspace gets a lens too.
  const lenses = new FenceLensProvider();
  const panels = new FencePanels(context.extensionUri);
  context.subscriptions.push(
    lenses,
    panels,
    vscode.languages.registerCodeLensProvider(
      [{ language: "markdown" }, { language: "mdx" }],
      lenses,
    ),
    // One command, two ways in. The lens names the block it was drawn over;
    // the command palette names nothing, and the cursor says which block —
    // which is also the only way to reach a lens without a mouse.
    vscode.commands.registerCommand(OPEN_FENCE, async (uri?: vscode.Uri, line?: number) => {
      const editor = vscode.window.activeTextEditor;
      const target = uri ?? editor?.document.uri;
      const at = line ?? editor?.selection.active.line;
      if (!target || at === undefined) {
        void vscode.window.showInformationMessage(
          "Put the cursor inside a Mermaid code block first.",
        );
        return;
      }
      await panels.open(target, at);
    }),
  );
}

export function deactivate(): void {}
