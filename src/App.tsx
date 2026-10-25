import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { Toolbar } from "./components/Toolbar";
import { DocumentTabs } from "./components/DocumentTabs";
import { Palette } from "./components/Palette";
import { CanvasView } from "./components/CanvasView";
import { CodePanel } from "./components/CodePanel";
import { SideResizer } from "./components/SideResizer";
import { Inspector } from "./components/Inspector";
import { StatusAnnouncer } from "./components/StatusAnnouncer";
import { loadInitialCode, useGraphStore } from "./store";
import { measureNode } from "./measureNode";
import {
  buildExport,
  DEFAULT_EXPORT_OPTIONS,
  exportDataUrlForTest,
  type ExportOptions,
} from "./export";
import { useThemeStore } from "./theme";
import { hostOwnsFile, initEmbedBridge, isEmbedded } from "./embed";
import { useLayoutStore } from "./layoutStore";
import { desktopBridge, initDesktopFiles, useFileStore } from "./files";
import { useWorkspace } from "./workspace";
import { adoptFileHere, openFileHere, unsavedDocuments } from "./documents";
import { toast, toastError } from "./toast";
import { Toasts } from "./components/Toasts";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { CommandPalette } from "./components/CommandPalette";
import { useT } from "./i18n";
import { singleKeyShortcutsEnabled } from "./prefs";
import { watchDisk } from "./diskWatch";
import { copyNow } from "./clipboard";

export default function App() {
  const applyCode = useGraphStore((s) => s.applyCode);
  // Declared above the effects that reference it, not alongside the other
  // render-time reads further down.
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showPalette, setShowPalette] = useState(false);

  useEffect(() => {
    // Called either way: it builds the workspace as well as returning code,
    // and the rest of the app expects one to exist.
    const initial = loadInitialCode();
    // A host sends the document it owns, a moment later. Drawing ours first
    // is a flash of a diagram the user did not open — so the splash stays up
    // until the real one lands, which is what `booted` already means.
    if (hostOwnsFile()) return;
    void applyCode(initial);
  }, [applyCode]);

  useEffect(() => {
    if (isEmbedded()) initEmbedBridge();
  }, []);

  useEffect(() => {
    // Pick up a file the desktop shell was launched with. No-op on the web.
    initDesktopFiles((f) => void adoptFileHere(f));
  }, []);

  useEffect(() => {
    // Notice edits made to open files outside the app — typically an agent
    // writing through the MCP server. No-op until a file is actually open.
    return watchDisk();
  }, []);

  useEffect(() => {
    // Only guards edits made since the last open/save. A scratch diagram is
    // autosaved to localStorage, so warning about it would be noise.
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (unsavedDocuments().length === 0) return;
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  useEffect(() => {
    // Apply the stored theme, follow OS changes under "system", and
    // re-derive edge colors whenever the resolved theme flips.
    document.documentElement.dataset.theme = useThemeStore.getState().resolved;
    // On the desktop the shell needs it too: the widgets Chromium draws
    // itself take no notice of the page's CSS. No-op in a browser, where
    // `color-scheme` in the stylesheet is the whole of the story.
    desktopBridge()?.setTheme?.(useThemeStore.getState().resolved);
    const unsub = useThemeStore.subscribe((s) => {
      useGraphStore.getState().refreshEdges();
      desktopBridge()?.setTheme?.(s.resolved);
    });
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => useThemeStore.getState().sync();
    mq.addEventListener("change", onChange);
    return () => {
      unsub();
      mq.removeEventListener("change", onChange);
    };
  }, []);

  useEffect(() => {
    // Dev-only hooks for browser-driven e2e tests (see tests/e2e-export.mts).
    if (!import.meta.env.DEV) return;
    (window as unknown as Record<string, unknown>).__graphTest = {
      ready: () => {
        const s = useGraphStore.getState();
        return s.nodes.length > 0 && s.nodes.every((n) => n.measured?.width);
      },
      exportPng: () => exportDataUrlForTest(useGraphStore.getState().nodes),
      /** Drive the real export pipeline, either source, from a browser test. */
      exportWith: (opts: Partial<ExportOptions>) => {
        const s = useGraphStore.getState();
        return buildExport({ ...DEFAULT_EXPORT_OPTIONS, ...opts }, s.nodes, s.code, {
          edges: s.edges,
          kind: s.kind,
          classDefs: s.classDefs,
        });
      },
      store: useGraphStore,
      // The file binding and the workspace index, so a test can stand a
      // document on a fake file handle and let the real watcher find it.
      files: useFileStore,
      workspace: useWorkspace,
      state: () => {
        const s = useGraphStore.getState();
        return {
          kind: s.kind,
          nodes: s.nodes.length,
          edges: s.edges.length,
          parseError: s.parseError,
          warning: s.warning,
        };
      },
      /**
       * What each node measures to on its own account, beside what the browser
       * made of it.
       *
       * `measureNode` has to predict, without a browser, the box the browser
       * would compute — that is the whole basis of rendering outside the
       * editor. The only way to know whether it does is to ask both here,
       * where the real answer exists. `tests/e2e-measure.mts` is the caller.
       */
      measured: () =>
        useGraphStore.getState().nodes.map((n) => ({
          id: n.id,
          type: n.type,
          sized: n.style?.width !== undefined,
          predicted: measureNode(n),
          actual: { width: n.measured?.width ?? 0, height: n.measured?.height ?? 0 },
        })),
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) return;
      const s = useGraphStore.getState();

      // Unmodified keys first: the shortcut sheet, and nudging the selection.
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === "?" && singleKeyShortcutsEnabled()) {
          e.preventDefault();
          setShowShortcuts(true);
          return;
        }
        const nudge: Record<string, [number, number]> = {
          ArrowUp: [0, -1],
          ArrowDown: [0, 1],
          ArrowLeft: [-1, 0],
          ArrowRight: [1, 0],
        };
        const delta = nudge[e.key];
        if (delta && s.nodes.some((n) => n.selected)) {
          e.preventDefault();
          // Shift moves a grid step; plain arrows move a single pixel, which
          // is what you want when lining two nodes up by eye.
          const step = e.shiftKey ? 12 : 1;
          s.nudgeSelection(delta[0] * step, delta[1] * step);
          return;
        }
        return;
      }

      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        void s.undo();
      } else if (key === "y" || (key === "z" && e.shiftKey)) {
        e.preventDefault();
        void s.redo();
      } else if (key === "c") {
        // Words selected on the page are the browser's to copy.
        if (window.getSelection()?.toString()) return;
        e.preventDefault();
        copyNow();
      } else if (key === "d") {
        e.preventDefault();
        s.copySelection();
        s.pasteClipboard();
      } else if (key === "a") {
        e.preventDefault();
        s.selectAll();
      } else if (key === "s") {
        // Left alone where a host owns the file: not preventing the default
        // is what lets Ctrl+S reach VS Code, whose save is the real one. A
        // hidden Save button and a live Ctrl+S would be the same
        // contradiction, only harder to see.
        if (hostOwnsFile()) return;
        // The browser's own Save is meaningless here and would save the page.
        e.preventDefault();
        void (e.shiftKey ? useFileStore.getState().saveAs() : useFileStore.getState().save())
          .then(() => toast("toast.saved"))
          .catch((err: unknown) => toastError("toast.saveFailed", err));
      } else if (key === "k") {
        e.preventDefault();
        setShowPalette((open) => !open);
      } else if (key === "o") {
        // Same reasoning as Save: opening a file is the host's gesture, and
        // its Ctrl+O opens one properly rather than behind its back.
        if (hostOwnsFile()) return;
        e.preventDefault();
        void openFileHere().catch(() => {
          // "no-picker" browsers fall back to the toolbar's file input.
          document.querySelector<HTMLInputElement>('input[type="file"]')?.click();
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const booted = useGraphStore((s) => s.booted);
  const paletteOpen = useLayoutStore((s) => s.paletteOpen);
  const sideOpen = useLayoutStore((s) => s.sideOpen);
  const sideWidth = useLayoutStore((s) => s.sideWidth);
  const closeDrawers = useLayoutStore((s) => s.closeDrawers);
  const sideRef = useRef<HTMLElement>(null);
  const t = useT();

  return (
    <ReactFlowProvider>
      {!booted && (
        <div className="splash">
          <img src="./logo.svg" alt="" className="splash-mark" />
          <div className="splash-name">Archyne</div>
          <div className="splash-sub">{t("app.loading")}</div>
        </div>
      )}
      <div className="app">
        <Toolbar />
        <div
          className={`main${paletteOpen ? " palette-open" : ""}${sideOpen ? " side-open" : ""}`}
          // Unset until the divider is dragged, so the stylesheet's own
          // responsive widths stay in charge for anyone who never drags it.
          style={
            sideWidth === null ? undefined : ({ "--side-w": `${sideWidth}px` } as CSSProperties)
          }
        >
          <Palette />
          {/* The tab strip belongs to the diagram, not to the window, so it
              spans the canvas column rather than the whole application. */}
          <div className="canvas-column">
            <CanvasView />
            {/* A host binds this window to one of its documents, so a strip
                offering to switch to another is not just spare furniture: the
                one you switched to would be sent back as an edit to the file
                the host still has open. */}
            {!hostOwnsFile() && <DocumentTabs />}
          </div>
          <SideResizer targetRef={sideRef} />
          <aside ref={sideRef} className="side" aria-label={t("panel.sourceAndInspector")}>
            <CodePanel />
            <Inspector />
          </aside>
          {/* Only rendered while a drawer is open, and only reachable at the
              narrow breakpoint where drawers exist. */}
          {(paletteOpen || sideOpen) && (
            <>
              <button
                type="button"
                className="drawer-backdrop"
                aria-label={t("palette.close")}
                onClick={closeDrawers}
              />
              {/* An open drawer covers the canvas, and the only ways out of
                  one were a 47px strip of unmarked backdrop and the toolbar
                  toggle that opened it — neither of which reads as "close".
                  Sits over whichever drawer is open: the side panel is flush
                  with the right edge, the palette with the left. */}
              <button
                type="button"
                className={`drawer-close${sideOpen ? " at-end" : " at-start"}`}
                aria-label={t("palette.close")}
                onClick={closeDrawers}
              >
                <span aria-hidden="true">×</span>
              </button>
            </>
          )}
        </div>
        <StatusAnnouncer />
        <Toasts />
        {showShortcuts && <ShortcutsDialog onClose={() => setShowShortcuts(false)} />}
        {showPalette && <CommandPalette onClose={() => setShowPalette(false)} />}
      </div>
    </ReactFlowProvider>
  );
}
