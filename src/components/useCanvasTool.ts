import { useEffect } from "react";
import { create } from "zustand";
import { singleKeyShortcutsEnabled } from "../prefs";

/**
 * What a press-and-drag on the canvas does.
 *
 * **Select** draws a marquee and moves what it lands on, which is what the
 * canvas is mostly for. **Pan** moves the canvas instead, wherever the press
 * lands — on a box, a line or bare canvas — the hand tool of draw.io, Figma
 * and every drawing program. The middle and right buttons pan with either.
 *
 * The canvas used to show the hand all the time, because React Flow puts it
 * on any canvas that pans, while a left drag drew a marquee: the cursor
 * promised one thing and the press did another, and there was no way to get
 * the thing the cursor promised without a middle button.
 */
export type CanvasTool = "select" | "pan";

export const useCanvasTool = create<{
  tool: CanvasTool;
  /** Space held down: the hand for as long as it is held, then back. */
  spaceHeld: boolean;
  setTool: (tool: CanvasTool) => void;
}>((set) => ({
  tool: "select",
  spaceHeld: false,
  setTool: (tool) => set({ tool }),
}));

/** Is the canvas panning on a plain drag right now? */
export function usePanning(): boolean {
  return useCanvasTool((s) => s.tool === "pan" || s.spaceHeld);
}

/** Somewhere typing goes, where a letter or a space is text and not a command. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el?.tagName) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable ||
    // The code editor: its surface is a contenteditable, but focus can sit on
    // its wrapper too.
    !!el.closest?.(".cm-editor")
  );
}

/**
 * The keys: V for select, H for the hand — the letters draw.io, Figma and
 * Photoshop use — and Space held for the hand until it is let go.
 *
 * Space only while the pointer's attention is the canvas: not in a field, not
 * on a button (where Space presses it), not in a dialog.
 */
export function useCanvasToolKeys(): void {
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      const target = e.target as HTMLElement | null;
      if (e.key === " " || e.code === "Space") {
        if (target?.closest?.("button, a, [role='button'], [role='dialog'], .modal")) return;
        e.preventDefault(); // or the page scrolls
        if (!e.repeat) useCanvasTool.setState({ spaceHeld: true });
        return;
      }
      if (!singleKeyShortcutsEnabled() || e.repeat) return;
      const key = e.key.toLowerCase();
      if (key === "v") useCanvasTool.getState().setTool("select");
      else if (key === "h") useCanvasTool.getState().setTool("pan");
    };
    const release = () => {
      if (useCanvasTool.getState().spaceHeld) useCanvasTool.setState({ spaceHeld: false });
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key === " " || e.code === "Space") release();
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    // Let go of while the window was not looking: Alt+Tab with Space down.
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", release);
    };
  }, []);
}
