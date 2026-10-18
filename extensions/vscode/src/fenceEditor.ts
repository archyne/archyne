import * as vscode from "vscode";
import {
  fenceAfterWrite,
  fenceAt,
  fenceReplacement,
  findMermaidFences,
  refindFence,
  wouldBreakFence,
  type Fence,
} from "./fences";
import { attachAi } from "./ai";
import { webviewHtml } from "./webview";

/**
 * The canvas, on one Mermaid block inside a Markdown file.
 *
 * The custom editor has a `TextDocument` to itself and can replace the whole of
 * it. This has a range in a document that is mostly prose, so the two halves
 * that are trivial there are the work here: writing back into the block rather
 * than over the file, and keeping hold of which block that is while the
 * document moves under it. Both live in `fences.ts`, which is tested.
 *
 * Nothing here touches the disk. Edits go through a `WorkspaceEdit`, so the
 * dirty dot, undo and Ctrl+S stay VS Code's — as they are for `.mmd`.
 */

const VIEW_TYPE = "archyne.fence";

/**
 * What an empty block opens as.
 *
 * An empty fence does not parse, and a parse error leaves the canvas holding
 * whatever it had — which for a fresh webview is the sample diagram. The first
 * edit would then write *that* into somebody's README. A bare header parses to
 * a diagram with no nodes, so the canvas opens empty, in the right kind, with
 * nothing to write back until there is something to write.
 */
const EMPTY_BLOCK = "flowchart TD";

export class FencePanels {
  private readonly bindings = new Set<FenceBinding>();
  private readonly appRoot: vscode.Uri;
  private readonly icon: vscode.Uri;

  constructor(extensionUri: vscode.Uri) {
    this.appRoot = vscode.Uri.joinPath(extensionUri, "media", "app");
    this.icon = vscode.Uri.joinPath(extensionUri, "media", "icon.png");
  }

  /** Open (or re-reveal) the canvas on the block a lens was drawn over. */
  async open(uri: vscode.Uri, line: number): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uri);
    const fence = fenceAt(findMermaidFences(document.getText()), line);
    if (!fence) {
      void vscode.window.showInformationMessage("That Mermaid block is no longer in the file.");
      return;
    }

    for (const binding of this.bindings) {
      if (binding.holds(uri, fence)) {
        binding.reveal();
        return;
      }
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      panelTitle(uri, fence),
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        // The only directory the webview may read; the app asks for nothing
        // outside itself.
        localResourceRoots: [this.appRoot],
        // As for the custom editor: the canvas holds a layout and an undo
        // stack, and switching tabs is not meant to discard them.
        retainContextWhenHidden: true,
      },
    );
    panel.iconPath = this.icon;
    panel.webview.html = await webviewHtml(panel.webview, this.appRoot);

    const binding = new FenceBinding(panel, document, fence);
    this.bindings.add(binding);
    // Generate's calls, answered here so no secret ever enters the webview.
    const ai = attachAi(panel.webview);
    panel.onDidDispose(() => {
      ai.dispose();
      binding.dispose();
      this.bindings.delete(binding);
    });
  }

  dispose(): void {
    // Disposing the panel runs the handler above, which disposes the binding.
    for (const binding of [...this.bindings]) binding.panel.dispose();
  }
}

function panelTitle(uri: vscode.Uri, fence: Fence): string {
  const name = uri.path.split("/").pop() ?? "Mermaid";
  return `${name} · Mermaid ${fence.index + 1}`;
}

/** One open panel, and the block it is editing. */
class FenceBinding {
  private document: vscode.TextDocument;
  private fence: Fence;
  /**
   * The text the canvas is showing, set by whichever side last put it there.
   *
   * One field rather than a pair of "last written" flags, because it answers
   * the only question both directions ask: is what I am about to send already
   * what the other side has? An echo of our own edit fails that test, and so
   * does a change to a different part of the Markdown file.
   */
  private showing: string;
  private detached = false;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    readonly panel: vscode.WebviewPanel,
    document: vscode.TextDocument,
    fence: Fence,
  ) {
    this.document = document;
    this.fence = fence;
    this.showing = fence.text === "" ? EMPTY_BLOCK : fence.text;

    this.subscriptions.push(
      panel.webview.onDidReceiveMessage((msg: { type?: string; code?: string }) => {
        switch (msg?.type) {
          case "ready":
            // The canvas asks first, and the block has to arrive after its own
            // start-up rather than be overwritten by it.
            this.push();
            break;
          case "change":
            void this.applyFromCanvas(String(msg.code ?? ""));
            break;
        }
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() !== this.uri.toString()) return;
        if (e.contentChanges.length === 0) return;
        this.document = e.document;
        this.followDocument();
      }),
    );
  }

  private get uri(): vscode.Uri {
    return this.document.uri;
  }

  /** Whether this panel is already editing `fence` in `uri`. */
  holds(uri: vscode.Uri, fence: Fence): boolean {
    return this.uri.toString() === uri.toString() && this.fence.index === fence.index;
  }

  reveal(): void {
    this.panel.reveal(this.panel.viewColumn, false);
  }

  private push(): void {
    void this.panel.webview.postMessage({ type: "load", code: this.showing });
  }

  /** The document changed: find our block again, and send it if it moved on. */
  private followDocument(): void {
    if (this.detached) return;
    const found = refindFence(findMermaidFences(this.document.getText()), this.fence);
    if (!found) {
      this.detach();
      return;
    }
    this.fence = found;
    if (found.text === this.showing) return;
    // Still the empty block we seeded, which the file is right not to hold.
    if (found.text === "" && this.showing === EMPTY_BLOCK) return;
    this.showing = found.text;
    this.push();
  }

  private async applyFromCanvas(code: string): Promise<void> {
    if (this.detached || code === this.showing) return;
    this.showing = code;

    if (wouldBreakFence(code, this.fence.marker)) {
      // Writing it would end the fence early and turn the rest of the diagram
      // into prose. Detaching rather than skipping the one edit: the canvas and
      // the file have diverged, and quietly dropping later edits that happen to
      // be writable would be worse than saying so once.
      this.detach(
        "This diagram contains a line that would close the Markdown code fence, so Archyne stopped writing to the file.",
      );
      return;
    }

    const document = await this.reopened();
    // Located again immediately before the write. `followDocument` keeps this
    // current, but an edit that landed while the canvas was serializing has not
    // reached it yet, and the range is about to be written to.
    const current = refindFence(findMermaidFences(document.getText()), this.fence);
    if (!current) {
      this.detach();
      return;
    }

    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      document.uri,
      new vscode.Range(current.startLine, 0, current.endLine, 0),
      fenceReplacement(code, current.indent),
    );
    await vscode.workspace.applyEdit(edit);
    this.fence = fenceAfterWrite(current, code);
  }

  /**
   * The document, reopened if it has been closed.
   *
   * A `TextDocument` goes stale when its last editor closes, and the Markdown
   * file is one the user may well close while keeping the canvas open.
   * `openTextDocument` hands back the open one when there is one, so this
   * costs nothing in the ordinary case.
   */
  private async reopened(): Promise<vscode.TextDocument> {
    if (this.document.isClosed) {
      this.document = await vscode.workspace.openTextDocument(this.uri);
    }
    return this.document;
  }

  /**
   * Stop writing to the file, and say so.
   *
   * The panel stays: it holds a diagram and an undo stack the user may still
   * want to copy out of, and tearing it down on a deleted block would take
   * their work with it. What it stops being is a view of the file.
   */
  private detach(message?: string): void {
    if (this.detached) return;
    this.detached = true;
    this.panel.title = `${this.panel.title} (detached)`;
    void vscode.window.showWarningMessage(
      message ??
        "The Mermaid block this canvas was editing is no longer in the file, so Archyne stopped writing to it.",
    );
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}
