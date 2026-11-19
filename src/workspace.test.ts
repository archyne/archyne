import { beforeEach, describe, expect, it, vi } from "vitest";
import { useGraphStore, loadInitialCode, SAMPLE } from "./store";
import { useFileStore } from "./files";
import {
  adoptFileHere,
  createDoc,
  deleteDoc,
  documentList,
  duplicateDoc,
  moveDoc,
  renameDoc,
  shouldOpenInNewDoc,
  sortDocs,
  switchTo,
  unsavedDocuments,
} from "./documents";
import { DOC_PREFIX, INDEX_KEY, LEGACY_KEY, loadWorkspace, useWorkspace } from "./workspace";

const FLOWCHART = `flowchart TD\n  a["A"] --> b["B"]\n`;
const OTHER = `flowchart LR\n  x["X"] --> y["Y"]\n`;

/** Boot the app the way `main.tsx` does, from whatever is in localStorage. */
async function boot() {
  const code = loadInitialCode();
  await useGraphStore.getState().applyCode(code, { record: false });
}

beforeEach(() => {
  localStorage.clear();
  useWorkspace.setState({ docs: [], activeId: "" });
  useFileStore.setState({ name: null, path: null, handle: null, savedCode: null });
});

describe("migration from the single-document era", () => {
  it("adopts an existing graph:code diagram instead of discarding it", async () => {
    localStorage.setItem(LEGACY_KEY, FLOWCHART);
    await boot();

    expect(useGraphStore.getState().code).toBe(FLOWCHART);
    expect(documentList()).toHaveLength(1);
    // The old key is cleared only once the document exists under the new one.
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    const [doc] = documentList();
    expect(localStorage.getItem(DOC_PREFIX + doc.id)).toBe(FLOWCHART);
  });

  it("starts with one sample document when there is nothing stored", async () => {
    await boot();
    expect(documentList()).toHaveLength(1);
    expect(useGraphStore.getState().code).toBe(SAMPLE);
  });

  it("survives a corrupted index rather than failing to boot", async () => {
    localStorage.setItem(INDEX_KEY, "{not json");
    await boot();
    expect(documentList()).toHaveLength(1);
  });
});

describe("switching documents", () => {
  it("keeps each document's source separate", async () => {
    await boot();
    const [first] = documentList();

    useGraphStore.getState().setCodeFromEditor(FLOWCHART);
    await useGraphStore.getState().applyCode(FLOWCHART, { record: false });

    const second = await createDoc();
    await useGraphStore.getState().applyCode(OTHER, { record: false });
    expect(useGraphStore.getState().code).toBe(OTHER);

    await switchTo(first.id);
    expect(useGraphStore.getState().code).toBe(FLOWCHART);

    await switchTo(second);
    expect(useGraphStore.getState().code).toBe(OTHER);
  });

  it("does not empty, or swap, documents switched through while one is still loading", async () => {
    // Opening a document makes it active at once and loads its source after.
    // Switching on before the load finished saved what was on screen — the
    // document being left — into the one being opened, and when its load did
    // finish, saved that into whichever was active by then. A diagram found
    // empty, an imported page empty on arrival.
    await boot();
    const [first] = documentList();
    await useGraphStore.getState().applyCode(FLOWCHART, { record: false });
    const second = await createDoc();
    await useGraphStore.getState().applyCode(OTHER, { record: false });
    const third = await createDoc();
    const THIRD = `flowchart TD\n  p["P"] --> q["Q"]\n`;
    await useGraphStore.getState().applyCode(THIRD, { record: false });

    // Three clicks in a row, none waiting for the one before.
    const a = switchTo(first.id);
    const b = switchTo(second);
    const c = switchTo(third);
    await Promise.all([a, b, c]);

    expect(localStorage.getItem(DOC_PREFIX + first.id)).toBe(FLOWCHART);
    expect(localStorage.getItem(DOC_PREFIX + second)).toBe(OTHER);
    expect(localStorage.getItem(DOC_PREFIX + third)).toBe(THIRD);
    expect(useGraphStore.getState().code).toBe(THIRD);
  });

  it("does not carry text typed in one document into the next", async () => {
    // Typing is read back after a short pause. Switching document within it
    // let the read-back run anyway, for whichever document was active by
    // then: it overtook that document's load and saved the other's text in.
    await boot();
    const [first] = documentList();
    await useGraphStore.getState().applyCode(FLOWCHART, { record: false });
    const second = await createDoc();
    await useGraphStore.getState().applyCode(OTHER, { record: false });
    await switchTo(first.id);

    const TYPED = `flowchart TD\n  a["A"] --> b["B"] --> c["C"]\n`;
    useGraphStore.getState().setCodeFromEditor(TYPED);
    await switchTo(second);
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(localStorage.getItem(DOC_PREFIX + first.id)).toBe(TYPED);
    expect(localStorage.getItem(DOC_PREFIX + second)).toBe(OTHER);
    expect(useGraphStore.getState().code).toBe(OTHER);
  });

  it("does not save an empty screen over a document just after a reload", async () => {
    await boot();
    const [first] = documentList();
    await useGraphStore.getState().applyCode(FLOWCHART, { record: false });
    const second = await createDoc();
    await useGraphStore.getState().applyCode(OTHER, { record: false });

    // A reload: the app starts again from what is stored, with nothing on
    // screen while the open document loads — and a tab is clicked before it
    // has.
    vi.resetModules();
    const store = await import("./store");
    const docs = await import("./documents");
    const loading = store.useGraphStore
      .getState()
      .applyCode(store.loadInitialCode(), { record: false });
    const away = docs.switchTo(first.id);
    await Promise.all([loading, away]);

    expect(localStorage.getItem(DOC_PREFIX + second)).toBe(OTHER);
    expect(store.useGraphStore.getState().code).toBe(FLOWCHART);
  });

  it("does not let undo reach across documents", async () => {
    await boot();
    const first = useWorkspace.getState().activeId;

    // Build some history in the first document.
    await useGraphStore.getState().applyCode(FLOWCHART, { record: true });
    expect(useGraphStore.getState().canUndo).toBe(true);

    const second = await createDoc();
    // A fresh document starts with nothing to undo, so undo cannot replay a
    // snapshot belonging to the other one over it.
    expect(useGraphStore.getState().canUndo).toBe(false);
    await useGraphStore.getState().undo();
    expect(useGraphStore.getState().code).toBe(SAMPLE);

    // The first document's history is still there when we go back.
    await switchTo(first);
    expect(useGraphStore.getState().canUndo).toBe(true);
    void second;
  });

  it("carries the file binding with the document, not the window", async () => {
    await boot();
    const first = useWorkspace.getState().activeId;
    useFileStore.setState({
      name: "a.mmd",
      path: "/tmp/a.mmd",
      handle: null,
      savedCode: SAMPLE,
    });

    const second = await createDoc();
    // A new scratch document is not bound to the file the other one owns.
    expect(useFileStore.getState().path).toBeNull();
    expect(useFileStore.getState().name).toBeNull();

    await switchTo(first);
    expect(useFileStore.getState().path).toBe("/tmp/a.mmd");
    expect(useFileStore.getState().name).toBe("a.mmd");
    void second;
  });
});

describe("managing documents", () => {
  it("names new documents without colliding", async () => {
    await boot();
    await createDoc();
    await createDoc();
    const names = documentList()
      .map((d) => d.name)
      .sort();
    expect(new Set(names).size).toBe(3);
    expect(names).toContain("Untitled");
  });

  it("renames without touching the file on disk", async () => {
    await boot();
    const id = useWorkspace.getState().activeId;
    useFileStore.setState({
      name: "a.mmd",
      path: "/tmp/a.mmd",
      handle: null,
      savedCode: SAMPLE,
    });

    renameDoc(id, "  Architecture  ");
    expect(documentList()[0].name).toBe("Architecture");
    // The path is the file; the name is only a label.
    expect(useFileStore.getState().path).toBe("/tmp/a.mmd");
  });

  it("ignores an empty rename", async () => {
    await boot();
    const id = useWorkspace.getState().activeId;
    const before = documentList()[0].name;
    renameDoc(id, "   ");
    expect(documentList().find((d) => d.id === id)?.name).toBe(before);
  });

  it("duplicates the unsaved content, unbound from the original file", async () => {
    await boot();
    const id = useWorkspace.getState().activeId;
    useFileStore.setState({
      name: "a.mmd",
      path: "/tmp/a.mmd",
      handle: null,
      savedCode: SAMPLE,
    });
    await useGraphStore.getState().applyCode(FLOWCHART, { record: false });

    await duplicateDoc(id);
    expect(useGraphStore.getState().code).toBe(FLOWCHART);
    // Saving the copy must not overwrite the file the original owns.
    expect(useFileStore.getState().path).toBeNull();
    expect(documentList()).toHaveLength(2);
  });

  it("replaces the last document rather than leaving an empty workspace", async () => {
    await boot();
    const id = useWorkspace.getState().activeId;
    await deleteDoc(id);

    const docs = documentList();
    expect(docs).toHaveLength(1);
    expect(docs[0].id).not.toBe(id);
    expect(localStorage.getItem(DOC_PREFIX + id)).toBeNull();
  });

  it("moves to another document when the active one is deleted", async () => {
    await boot();
    const first = useWorkspace.getState().activeId;
    const second = await createDoc();
    await useGraphStore.getState().applyCode(OTHER, { record: false });

    await deleteDoc(second);
    expect(useWorkspace.getState().activeId).toBe(first);
    expect(documentList()).toHaveLength(1);
  });

  it("leaves the active document alone when another is deleted", async () => {
    await boot();
    const first = useWorkspace.getState().activeId;
    const second = await createDoc();
    await useGraphStore.getState().applyCode(OTHER, { record: false });

    await deleteDoc(first);
    expect(useWorkspace.getState().activeId).toBe(second);
    expect(useGraphStore.getState().code).toBe(OTHER);
  });
});

describe("persistence", () => {
  it("reloads into the document that was open", async () => {
    await boot();
    await createDoc();
    await useGraphStore.getState().applyCode(OTHER, { record: false });
    const activeId = useWorkspace.getState().activeId;

    // Simulate a reload: same localStorage, fresh stores.
    useWorkspace.setState({ docs: [], activeId: "" });
    const reloaded = loadWorkspace(SAMPLE);
    expect(reloaded.state.activeId).toBe(activeId);
    expect(reloaded.code).toBe(OTHER);
    expect(reloaded.state.docs).toHaveLength(2);
  });

  it("does not persist file handles, which cannot survive JSON", async () => {
    await boot();
    const id = useWorkspace.getState().activeId;
    useFileStore.setState({
      name: "a.mmd",
      path: null,
      handle: {} as FileSystemFileHandle,
      savedCode: SAMPLE,
    });
    await createDoc(); // captures the active document on the way out

    const stored = JSON.parse(localStorage.getItem(INDEX_KEY) ?? "{}") as {
      docs: Array<Record<string, unknown>>;
    };
    const entry = stored.docs.find((d) => d.id === id);
    expect(entry).toBeDefined();
    expect("handle" in (entry ?? {})).toBe(false);
  });
});

describe("opening a file", () => {
  const picked = { path: "/tmp/arch.mmd", content: FLOWCHART };

  /** The desktop hand-off, which goes through the same placement as the picker. */
  const placeFileForTest = (f: { path: string; content: string }) => adoptFileHere(f);

  it("lands in the current document when it is an untouched scratch", async () => {
    await boot();
    const before = useWorkspace.getState().activeId;

    expect(shouldOpenInNewDoc()).toBe(false);
    await placeFileForTest(picked);

    expect(useWorkspace.getState().activeId).toBe(before);
    expect(documentList()).toHaveLength(1);
    expect(useGraphStore.getState().code).toBe(FLOWCHART);
    // The tab takes the file's name rather than staying "Untitled".
    expect(documentList()[0].name).toBe("arch.mmd");
  });

  it("arrives beside work in progress rather than on top of it", async () => {
    await boot();
    const first = useWorkspace.getState().activeId;
    await useGraphStore.getState().applyCode(OTHER, { record: false });

    expect(shouldOpenInNewDoc()).toBe(true);
    await placeFileForTest(picked);

    expect(useWorkspace.getState().activeId).not.toBe(first);
    expect(documentList()).toHaveLength(2);
    expect(useGraphStore.getState().code).toBe(FLOWCHART);

    // The work that was open is untouched.
    await switchTo(first);
    expect(useGraphStore.getState().code).toBe(OTHER);
  });

  it("takes the file's name from either path separator", async () => {
    await boot();
    // The desktop shell hands over Windows paths; the browser picker does not.
    await adoptFileHere({ path: String.raw`C:\work\arch.mmd`, content: FLOWCHART });
    expect(documentList().find((d) => d.active)?.name).toBe("arch.mmd");

    await adoptFileHere({ path: "/tmp/other.mmd", content: OTHER });
    expect(documentList().find((d) => d.active)?.name).toBe("other.mmd");
  });

  it("does not reopen into a document already bound to a file", async () => {
    await boot();
    useFileStore.setState({
      name: "a.mmd",
      path: "/tmp/a.mmd",
      handle: null,
      savedCode: SAMPLE,
    });
    expect(shouldOpenInNewDoc()).toBe(true);
  });
});

describe("the unsaved-changes guard", () => {
  it("says nothing about scratch documents, which are autosaved", async () => {
    await boot();
    await useGraphStore.getState().applyCode(OTHER, { record: false });
    expect(unsavedDocuments()).toHaveLength(0);
  });

  it("notices the document on screen", async () => {
    await boot();
    useFileStore.setState({
      name: "a.mmd",
      path: "/tmp/a.mmd",
      handle: null,
      savedCode: SAMPLE,
    });
    await useGraphStore.getState().applyCode(OTHER, { record: false });
    expect(unsavedDocuments()).toHaveLength(1);
  });

  it("notices a document that is not on screen", async () => {
    await boot();
    const first = useWorkspace.getState().activeId;
    // Bind the first document to a file, then dirty it.
    useFileStore.setState({
      name: "a.mmd",
      path: "/tmp/a.mmd",
      handle: null,
      savedCode: SAMPLE,
    });
    await useGraphStore.getState().applyCode(OTHER, { record: false });

    // Move away. Before the workspace, this is where the warning was lost.
    await createDoc();
    expect(useWorkspace.getState().activeId).not.toBe(first);
    expect(unsavedDocuments().map((d) => d.id)).toEqual([first]);
  });

  it("goes quiet once the other document is back in step with its file", async () => {
    await boot();
    useFileStore.setState({
      name: "a.mmd",
      path: "/tmp/a.mmd",
      handle: null,
      savedCode: OTHER,
    });
    await useGraphStore.getState().applyCode(OTHER, { record: false });
    await createDoc();
    expect(unsavedDocuments()).toHaveLength(0);
  });
});

describe("the order of the strip", () => {
  /** Three documents, named and dated so both orders are visible. */
  async function three() {
    await boot();
    const [first] = useWorkspace.getState().docs;
    renameDoc(first.id, "beta");
    await createDoc();
    renameDoc(useWorkspace.getState().activeId, "alpha");
    await createDoc();
    renameDoc(useWorkspace.getState().activeId, "Untitled 10");
    // Distinct timestamps, oldest first, whatever order they were made in.
    const ids = useWorkspace.getState().docs.map((d) => d.id);
    useWorkspace.setState((state) => ({
      docs: state.docs.map((d) => ({ ...d, updatedAt: 100 + ids.indexOf(d.id) })),
    }));
    return names();
  }
  const names = () => useWorkspace.getState().docs.map((d) => d.name);

  it("moves a document to the slot asked for", async () => {
    expect(await three()).toEqual(["beta", "alpha", "Untitled 10"]);
    const id = useWorkspace.getState().docs[2].id;

    expect(moveDoc(id, 0)).toBe(0);
    expect(names()).toEqual(["Untitled 10", "beta", "alpha"]);
  });

  it("clamps a move past either end rather than losing the document", async () => {
    await three();
    const id = useWorkspace.getState().docs[1].id;

    expect(moveDoc(id, -3)).toBe(0);
    expect(names()).toEqual(["alpha", "beta", "Untitled 10"]);
    expect(moveDoc(id, 99)).toBe(2);
    expect(names()).toEqual(["beta", "Untitled 10", "alpha"]);
  });

  it("reports the slot a document is already in without touching the order", async () => {
    await three();
    const before = names();
    const id = useWorkspace.getState().docs[1].id;
    expect(moveDoc(id, 1)).toBe(1);
    expect(names()).toEqual(before);
  });

  it("survives a reload, because the order is the index", async () => {
    await three();
    moveDoc(useWorkspace.getState().docs[2].id, 0);

    useWorkspace.setState({ docs: [], activeId: "" });
    const { state } = loadWorkspace(SAMPLE);
    expect(state.docs.map((d) => d.name)).toEqual(["Untitled 10", "beta", "alpha"]);
  });

  it("sorts by name, counting the digits in a name as a number", async () => {
    await three();
    await createDoc();
    renameDoc(useWorkspace.getState().activeId, "Untitled 2");

    sortDocs("name");
    // Not ["Untitled 10", "Untitled 2"], which is what a plain string sort
    // gives for the names this app hands out by default.
    expect(names()).toEqual(["alpha", "beta", "Untitled 2", "Untitled 10"]);
  });

  it("sorts by last used, most recent first", async () => {
    await three();
    sortDocs("recent");
    expect(names()).toEqual(["Untitled 10", "alpha", "beta"]);
  });
});
