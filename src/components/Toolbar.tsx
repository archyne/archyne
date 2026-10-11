import { useRef, useState } from "react";
import { useGraphStore } from "../store";
import { useThemeStore, type ThemeChoice } from "../theme";
import { usePrefs } from "../prefs";
import { useNarrow } from "./useMediaQuery";
import { useLayoutStore } from "../layoutStore";
import { readPicked, useFileStore, type PickMode } from "../files";
import {
  createDoc,
  documentMenuActions,
  openContentHere,
  openFileHere,
  reloadFromDisk,
} from "../documents";
import { toast, toastError } from "../toast";
import { hostOwnsFile } from "../embed";
import { LOCALES, useI18n, useT, type Locale } from "../i18n";
import { ExportDialog } from "./ExportDialog";
import { AboutDialog } from "./AboutDialog";
import { TemplateDialog } from "./TemplateDialog";
import { PendingImport } from "./ImportDialog";
import { MenuButton, MenuItem } from "./MenuButton";
import { LayoutPreview } from "./LayoutPreview";
import type { DiagramKind, Direction } from "../model/types";
import type { Arrangement } from "../layout/autoLayout";

/** What the fallback `<input type=file>` offers, per action. */
const MERMAID_ACCEPT = ".mmd,.mermaid,.txt,.md";
const IMPORT_ACCEPT =
  ".drawio,.xml,.vsdx,.lucid,.dot,.gv,.sql,.ddl,.excalidraw,.puml,.plantuml,.iuml,.wsd";

/** Diagram kinds in menu order; labels come from the catalogue. */
const KINDS: DiagramKind[] = [
  "flowchart",
  "state",
  "er",
  "class",
  "sequence",
  "architecture",
  "c4",
];

export function Toolbar() {
  const direction = useGraphStore((s) => s.direction);
  const kind = useGraphStore((s) => s.kind);
  const unsupported = useGraphStore((s) => s.unsupported);
  const setDirection = useGraphStore((s) => s.setDirection);
  const runAutoLayout = useGraphStore((s) => s.runAutoLayout);
  const lastArranged = useGraphStore((s) => s.lastArranged);
  const undo = useGraphStore((s) => s.undo);
  const redo = useGraphStore((s) => s.redo);
  const canUndo = useGraphStore((s) => s.canUndo);
  const canRedo = useGraphStore((s) => s.canRedo);
  const fileRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [pickMode, setPickMode] = useState<PickMode>("open");
  const paletteOpen = useLayoutStore((s) => s.paletteOpen);
  const sideOpen = useLayoutStore((s) => s.sideOpen);
  const togglePalette = useLayoutStore((s) => s.togglePalette);
  const toggleSide = useLayoutStore((s) => s.toggleSide);
  const saveFile = useFileStore((s) => s.save);
  const saveAsFile = useFileStore((s) => s.saveAs);
  // Subscribed rather than read once: the item has to appear the moment a
  // file is opened, and the toolbar has no other reason to re-render then.
  const fileBacked = useFileStore((s) => Boolean(s.path || s.handle));
  const themeChoice = useThemeStore((s) => s.choice);
  const singleKeys = usePrefs((s) => s.singleKeyShortcuts);
  const setSingleKeys = usePrefs((s) => s.setSingleKeyShortcuts);
  const setTheme = useThemeStore((s) => s.setTheme);
  const t = useT();
  const docActions = documentMenuActions();
  const locale = useI18n((s) => s.locale);
  const setLocale = useI18n((s) => s.setLocale);
  const narrow = useNarrow();

  /**
   * Prefer a real picker so Save writes back to the file the user opened.
   * `open()` throws "no-picker" on browsers without one, which is the signal
   * to fall back to the hidden <input type=file>.
   */
  const open = (mode: PickMode) => async () => {
    try {
      await openFileHere(mode);
    } catch (err) {
      if (err instanceof Error && err.message === "no-picker") {
        // The fallback input has to be told which list to accept before it
        // opens, so the mode is set first and read by the `accept` below.
        setPickMode(mode);
        // A state change does not reach the DOM before this returns, so the
        // click waits a tick for the new `accept` to be on the element.
        setTimeout(() => fileRef.current?.click(), 0);
        return;
      }
      toastError("toast.openFailed", err);
    }
  };

  const runSave = (fn: () => Promise<void>) => () =>
    void fn()
      .then(() => toast("toast.saved"))
      .catch((err: unknown) => toastError("toast.saveFailed", err));

  const reload = async () => {
    try {
      if (await reloadFromDisk()) toast("toast.reloadedFromDisk");
    } catch (err) {
      toastError("toast.openFailed", err);
    }
  };

  const copy = async () => {
    await navigator.clipboard.writeText(useGraphStore.getState().code);
    setCopied(true);
    toast("toast.copied");
    setTimeout(() => setCopied(false), 1200);
  };

  /** "Generate with AI": the side panel holds the Generate tab, so opening it
      opens the panel alongside. Both placements matter — without the panel an
      invisible tab has opened, without the tab a closed drawer has. */
  const openAi = () => {
    const layout = useLayoutStore.getState();
    if (!layout.sideOpen) layout.toggleSide();
    useGraphStore.getState().setAiOpen(true);
  };

  /* Controls that live in the bar when there is room for them and in the
     overflow menu when there is not, defined once so the two placements
     cannot drift apart. */
  const directionSelect =
    !unsupported && kind !== "sequence" && kind !== "architecture" && kind !== "c4" ? (
      <select
        className="tb-compact"
        value={direction === "TD" ? "TB" : direction}
        title={t("toolbar.direction")}
        aria-label={t("toolbar.direction")}
        onChange={(e) => setDirection(e.target.value as Direction)}
      >
        <option value="TB">{t("toolbar.dirTB")}</option>
        <option value="LR">{t("toolbar.dirLR")}</option>
        <option value="BT">{t("toolbar.dirBT")}</option>
        <option value="RL">{t("toolbar.dirRL")}</option>
      </select>
    ) : null;

  /**
   * The arrangements, in the order they are offered.
   *
   * A menu rather than a second dropdown beside the direction: the direction
   * is a property of the document that Mermaid itself writes down, and this is
   * an action you ask for once. What the file ends up holding is the positions
   * it produced — the choice itself is carried only until the next rearrange,
   * in `lastArranged`, and the menu ticks whichever item now sits on the
   * canvas, which is also how `auto` shows which arrangement won.
   */
  const layoutStyles = [
    ["auto", "toolbar.layoutAuto", "toolbar.layoutAutoHint"],
    ["layered", "toolbar.layoutLayered", "toolbar.layoutLayeredHint"],
    ["bands", "toolbar.layoutBands", "toolbar.layoutBandsHint"],
    ["rectpacking", "toolbar.layoutCompact", "toolbar.layoutCompactHint"],
    ["mrtree", "toolbar.layoutTree", "toolbar.layoutTreeHint"],
    ["force", "toolbar.layoutOrganic", "toolbar.layoutOrganicHint"],
  ] as const;

  /**
   * Which arrangement the pointer is over, so the panel can show what it does.
   *
   * A name alone does not tell you what "Banded" will do to your diagram, and
   * the only way to find out was to press it and undo. The picture is the
   * answer to a question asked in half a second, so it is a drawing of the
   * shape rather than a rendering of the open document — see `LayoutPreview`.
   */
  const [pointedAt, setPointedAt] = useState<Arrangement | null>(null);
  const pointedHint = layoutStyles.find(([s]) => s === pointedAt);

  const autoLayoutButton = !unsupported ? (
    <MenuButton
      label={t("toolbar.autoLayout")}
      className="layout-menu"
      trigger={t("toolbar.autoLayout")}
    >
      <>
        <div className="menu-heading">{t("toolbar.layoutAs")}</div>
        {layoutStyles.map(([style, key]) => (
          <MenuItem
            key={style}
            onSelect={() => void runAutoLayout(style)}
            onPointAt={() => setPointedAt(style)}
            current={lastArranged === style}
          >
            {t(key)}
          </MenuItem>
        ))}
        {pointedHint && (
          <div className="layout-hint">
            <LayoutPreview style={pointedHint[0]} />
            <p>{t(pointedHint[2])}</p>
          </div>
        )}
      </>
    </MenuButton>
  ) : null;

  // Hidden rather than disabled: a greyed-out Save invites you to work out
  // why, and the answer — the host has it — is not something a tooltip is
  // going to land. See `hostOwnsFile`.
  const hosted = hostOwnsFile();

  const newDiagramSelect = (
    <select
      className="tb-compact"
      value=""
      aria-label={t("toolbar.newDiagram")}
      onChange={(e) => {
        if (e.target.value) void createDoc(e.target.value as DiagramKind);
        e.target.value = "";
      }}
    >
      <option value="" disabled>
        {t("toolbar.new")}
      </option>
      {KINDS.map((k) => (
        <option key={k} value={k}>
          {t(`kind.${k}`)}
        </option>
      ))}
    </select>
  );

  return (
    <header className="toolbar">
      {/* Identity and document state — what you are looking at. */}
      <div className="tb-group tb-identity">
        {/* A wordmark, not a control. It used to open the About dialog, which
            is not what a logo is expected to do; About now sits in the
            overflow menu with the other occasional things. */}
        <span className="brand-lockup">
          <img src="./logo.svg" alt="" className="brand-logo" />
          <span className="brand">{t("app.name")}</span>
        </span>
        <span className="kind-badge" role="status">
          {unsupported ? t("unsupported.badge", { type: unsupported }) : t(`kind.${kind}`)}
        </span>
      </div>

      {/* Drawer toggles, deliberately not inside a `.tb-group`: the group
          would keep its separator once its only children were hidden at wide
          widths. CSS reveals these at the narrow breakpoint. */}
      <button
        type="button"
        className="drawer-toggle"
        aria-expanded={paletteOpen}
        onClick={togglePalette}
      >
        {t("toolbar.shapesDrawer")}
      </button>
      <button
        type="button"
        className="drawer-toggle"
        aria-expanded={sideOpen}
        onClick={toggleSide}
      >
        {t("toolbar.codeDrawer")}
      </button>

      <div className="toolbar-spacer" />

      {/* Editing the current diagram. */}
      <div className="tb-group">
        {/* Glyph-only, so they need an explicit name — `title` alone is not
            reliably announced. */}
        <button
          className="icon-button"
          onClick={() => void undo()}
          disabled={!canUndo}
          title={t("toolbar.undoHint")}
          aria-label={t("toolbar.undo")}
        >
          <span aria-hidden="true">↶</span>
        </button>
        <button
          className="icon-button"
          onClick={() => void redo()}
          disabled={!canRedo}
          title={t("toolbar.redoHint")}
          aria-label={t("toolbar.redo")}
        >
          <span aria-hidden="true">↷</span>
        </button>
        {!narrow && directionSelect}
        {!narrow && autoLayoutButton}
      </div>

      {/* The document itself. */}
      <div className="tb-group">
        {!narrow && !hosted && newDiagramSelect}
        {!narrow && (
          <>
            <button onClick={() => setShowTemplates(true)}>{t("tpl.open")}</button>
            {!hosted && (
              <>
                <button onClick={() => void open("open")()}>{t("toolbar.open")}</button>
                <button onClick={runSave(saveFile)}>{t("toolbar.save")}</button>
              </>
            )}
          </>
        )}
        {/* Export stays whatever the width. It is the one thing the bar must
            never make you go looking for. */}
        <button className="primary" onClick={() => setShowExport(true)}>
          {t("toolbar.export")}
        </button>
      </div>

      {/* Everything else. Keeping theme, language and Save as… out here is
          what lets the bar stay one row instead of wrapping to three. */}
      <MenuButton className="overflow-menu" label={t("toolbar.more")}>
        <>
          {/* On a phone the bar cannot hold these without wrapping to four
              rows and eating a third of the screen, so they come here — which
              is what this menu is for. */}
          {narrow && (
            <>
              <MenuItem onSelect={() => setShowTemplates(true)}>{t("tpl.open")}</MenuItem>
              {!hosted && (
                <MenuItem onSelect={() => void open("open")()}>{t("toolbar.open")}</MenuItem>
              )}
              <MenuItem onSelect={() => void open("import")()}>{t("toolbar.import")}</MenuItem>
              {!hosted && <MenuItem onSelect={runSave(saveFile)}>{t("toolbar.save")}</MenuItem>}
              {/* Flattened rather than nested: a menu inside a menu is a
                  panel that opens behind the one that opened it. On a phone
                  the arrangements are simply items in this list. */}
              {autoLayoutButton && (
                <>
                  <div className="menu-heading">{t("toolbar.layoutAs")}</div>
                  {layoutStyles.map(([style, key]) => (
                    <MenuItem
                      key={style}
                      onSelect={() => void runAutoLayout(style)}
                      current={lastArranged === style}
                    >
                      {t(key)}
                    </MenuItem>
                  ))}
                </>
              )}
              {!hosted && (
                <label className="menu-field">
                  {t("toolbar.newDiagram")}
                  {newDiagramSelect}
                </label>
              )}
              {directionSelect && (
                <label className="menu-field">
                  {t("toolbar.direction")}
                  {directionSelect}
                </label>
              )}
              <div className="menu-separator" />
            </>
          )}
          {!narrow && (
            <MenuItem onSelect={() => void open("import")()}>{t("toolbar.import")}</MenuItem>
          )}
          {!hosted && <MenuItem onSelect={runSave(saveAsFile)}>{t("toolbar.saveAs")}</MenuItem>}
          {/* Only offered when there is a file behind the document. It is
              also the way out of a conflict: the watcher will not overwrite
              unsaved work, which leaves the disk version otherwise
              unreachable. */}
          {fileBacked && !hosted && (
            <MenuItem onSelect={() => void reload()}>{t("menu.reloadFromDisk")}</MenuItem>
          )}
          {/* Renaming and duplicating are workspace gestures: one names a tab
              the host does not show, the other makes a second document the
              host has no file for. */}
          {!hosted && <MenuItem onSelect={docActions.rename}>{t("doc.rename")}</MenuItem>}
          {!hosted && <MenuItem onSelect={docActions.duplicate}>{t("doc.duplicate")}</MenuItem>}
          <MenuItem onSelect={() => void copy()}>
            {copied ? t("toolbar.copied") : t("toolbar.copyCode")}
          </MenuItem>
          <MenuItem onSelect={openAi}>{t("ai.tab")}</MenuItem>
          <div className="menu-separator" />
          <label className="menu-field">
            {t("prefs.singleKeys")}
            <input
              type="checkbox"
              checked={singleKeys}
              onChange={(e) => setSingleKeys(e.target.checked)}
            />
          </label>
          <label className="menu-field">
            {t("toolbar.theme")}
            <select
              value={themeChoice}
              aria-label={t("toolbar.theme")}
              onChange={(e) => setTheme(e.target.value as ThemeChoice)}
            >
              <option value="dark">{t("toolbar.themeDark")}</option>
              <option value="light">{t("toolbar.themeLight")}</option>
              <option value="system">{t("toolbar.themeSystem")}</option>
            </select>
          </label>
          <label className="menu-field">
            {t("toolbar.language")}
            <select
              value={locale}
              aria-label={t("toolbar.language")}
              onChange={(e) => void setLocale(e.target.value as Locale)}
            >
              {(Object.keys(LOCALES) as Locale[]).map((c) => (
                <option key={c} value={c}>
                  {LOCALES[c].label}
                </option>
              ))}
            </select>
          </label>
          <div className="menu-separator" />
          <MenuItem onSelect={() => setShowAbout(true)}>{t("about.title")}</MenuItem>
        </>
      </MenuButton>

      {showExport && <ExportDialog onClose={() => setShowExport(false)} />}
      {showAbout && <AboutDialog onClose={() => setShowAbout(false)} />}
      {showTemplates && <TemplateDialog onClose={() => setShowTemplates(false)} />}
      <PendingImport />
      <input
        ref={fileRef}
        type="file"
        accept={pickMode === "import" ? IMPORT_ACCEPT : MERMAID_ACCEPT}
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          // Same placement as the picker: beside your work, not on top of it.
          // Read through `readPicked` so a binary drawing arrives as bytes
          // rather than as UTF-8 that has destroyed it.
          if (file) await openContentHere(file.name, await readPicked(file));
          e.target.value = "";
        }}
      />
    </header>
  );
}
