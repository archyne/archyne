import * as vscode from "vscode";
import { attachAi } from "./ai";
import { webviewHtml } from "./webview";

/**
 * Archyne as an editor for `.mmd` files.
 *
 * A `CustomTextEditorProvider` rather than a `CustomEditorProvider`, because
 * a Mermaid file *is* text and VS Code should keep owning it: the dirty dot,
 * undo, save, the diff against HEAD and everything git-shaped come from the
 * `TextDocument`, and this only has to draw it and hand edits back. Nothing
 * here touches the disk.
 *
 * Registered at `priority: "option"`, so opening a `.mmd` still gives the
 * text editor — the canvas is a way to look at the file, not a replacement
 * for reading it.
 */
export class ArchyneEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = "archyne.editor";

  constructor(private readonly appRoot: vscode.Uri) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    panel.webview.options = {
      enableScripts: true,
      // The only directory the webview may read. The app is static files and
      // asks for nothing outside itself, so this is the whole of it.
      localResourceRoots: [this.appRoot],
    };
    panel.webview.html = await webviewHtml(panel.webview, this.appRoot);
    // Generate's calls, answered here so no secret ever enters the webview.
    const ai = attachAi(panel.webview);

    /**
     * The text this side last wrote into the document.
     *
     * Without it the two sides chase each other: an edit from the canvas
     * changes the document, the document change is pushed back to the canvas,
     * and the canvas reports it as a fresh edit. Comparing the text rather
     * than counting edits means a change that arrives while one is in flight
     * is still noticed — it will not match.
     */
    let lastFromCanvas: string | null = null;

    const push = () =>
      void panel.webview.postMessage({ type: "load", code: document.getText() });

    const applyFromCanvas = async (code: string) => {
      if (code === document.getText()) return;
      lastFromCanvas = code;
      const edit = new vscode.WorkspaceEdit();
      // The whole document, replaced. A Mermaid file is small, and a canvas
      // edit is a re-serialization of the entire graph rather than a change
      // to a known range — there is no smaller truthful edit to make.
      edit.replace(
        document.uri,
        new vscode.Range(0, 0, document.lineCount, 0),
        code.endsWith("\n") ? code : `${code}\n`,
      );
      await vscode.workspace.applyEdit(edit);
    };

    const received = panel.webview.onDidReceiveMessage(
      (msg: { type?: string; code?: string }) => {
        switch (msg?.type) {
          case "ready":
            // The canvas asks first: it loads its own last document from
            // storage, and the file has to arrive after that rather than be
            // overwritten by it.
            push();
            break;
          case "change":
            void applyFromCanvas(String(msg.code ?? ""));
            break;
        }
      },
    );

    const changed = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      if (e.contentChanges.length === 0) return;
      // Our own edit coming back around.
      if (document.getText() === lastFromCanvas) return;
      push();
    });

    panel.onDidDispose(() => {
      received.dispose();
      ai.dispose();
      changed.dispose();
    });
  }
}
