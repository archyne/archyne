import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Modal } from "./Modal";
import { useT } from "../i18n";
import { useGraphStore } from "../store";
import { IMG_SIZE } from "../model/types";
import { toastError } from "../toast";
import { clampCrop, croppedSize, cutPicture, loadForCrop, type CropRect } from "../crop";

/** The room the picture is shown in, at most. */
const VIEW = { width: 520, height: 360 };
/** How far a small picture is blown up to be cropped by hand. */
const MAX_ZOOM = 8;

/** Which edges a handle moves: the frame itself moves all four together. */
type Grip = { left?: boolean; right?: boolean; top?: boolean; bottom?: boolean };
const GRIPS: Array<{ name: string; grip: Grip }> = [
  { name: "nw", grip: { left: true, top: true } },
  { name: "n", grip: { top: true } },
  { name: "ne", grip: { right: true, top: true } },
  { name: "e", grip: { right: true } },
  { name: "se", grip: { right: true, bottom: true } },
  { name: "s", grip: { bottom: true } },
  { name: "sw", grip: { left: true, bottom: true } },
  { name: "w", grip: { left: true } },
];

/**
 * Crop a node's picture: drag the frame or its handles over the picture, or
 * type the numbers, which is also the way to do it from the keyboard.
 */
export function CropDialog({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const t = useT();
  const node = useGraphStore((s) => s.nodes.find((n) => n.id === nodeId));
  const src = node?.type === "shape" ? node.data.img : undefined;
  const [loaded, setLoaded] = useState<{ image: HTMLImageElement; type: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rect, setRect] = useState<CropRect | null>(null);
  const drag = useRef<{ grip: Grip | "move"; x: number; y: number; from: CropRect } | null>(
    null,
  );

  useEffect(() => {
    if (!src) return;
    let live = true;
    loadForCrop(src).then(
      (got) => {
        if (!live) return;
        setLoaded(got);
        setRect({
          x: 0,
          y: 0,
          width: got.image.naturalWidth,
          height: got.image.naturalHeight,
        });
      },
      (err: unknown) => live && setError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      live = false;
    };
  }, [src]);

  const natural = loaded
    ? { width: loaded.image.naturalWidth, height: loaded.image.naturalHeight }
    : null;
  const zoom = natural
    ? Math.min(MAX_ZOOM, VIEW.width / natural.width, VIEW.height / natural.height)
    : 1;

  const begin = (e: ReactPointerEvent<HTMLElement>, grip: Grip | "move") => {
    if (!rect) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { grip, x: e.clientX, y: e.clientY, from: rect };
  };

  const move = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || !natural) return;
    const dx = (e.clientX - d.x) / zoom;
    const dy = (e.clientY - d.y) / zoom;
    const f = d.from;
    if (d.grip === "move") {
      setRect(clampCrop({ ...f, x: f.x + dx, y: f.y + dy }, natural));
      return;
    }
    // Each edge moves on its own, and stops at the picture's edge rather than
    // pushing the frame along with it.
    let left = f.x;
    let top = f.y;
    let right = f.x + f.width;
    let bottom = f.y + f.height;
    if (d.grip.left) left = Math.min(Math.max(0, f.x + dx), right - 4);
    if (d.grip.right) right = Math.max(Math.min(natural.width, right + dx), left + 4);
    if (d.grip.top) top = Math.min(Math.max(0, f.y + dy), bottom - 4);
    if (d.grip.bottom) bottom = Math.max(Math.min(natural.height, bottom + dy), top + 4);
    setRect(clampCrop({ x: left, y: top, width: right - left, height: bottom - top }, natural));
  };

  const end = () => {
    drag.current = null;
  };

  const field = (key: keyof CropRect, label: string) => (
    <label>
      {label}
      <input
        type="number"
        min={0}
        value={rect ? rect[key] : ""}
        disabled={!rect}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (!rect || !natural || !Number.isFinite(v)) return;
          setRect(clampCrop({ ...rect, [key]: v }, natural));
        }}
      />
    </label>
  );

  const apply = () => {
    if (!loaded || !natural || !rect || node?.type !== "shape") return;
    try {
      const shown = {
        width: node.data.imgWidth ?? IMG_SIZE,
        height: node.data.imgHeight ?? IMG_SIZE,
      };
      const size = croppedSize(shown, natural, rect);
      useGraphStore.getState().cropImage(nodeId, {
        src: cutPicture(loaded.image, loaded.type, rect),
        ...size,
      });
      onClose();
    } catch (err) {
      toastError("toast.cropFailed", err);
    }
  };

  const whole =
    !!rect && !!natural && rect.width === natural.width && rect.height === natural.height;

  return (
    <Modal title={t("crop.title")} onClose={onClose} className="crop-modal">
      <div className="modal-body stacked">
        {error && <p className="preview-error">{`${t("toast.cropFailed")}: ${error}`}</p>}
        {loaded && natural && rect && (
          <div
            className="crop-stage"
            style={{ width: natural.width * zoom, height: natural.height * zoom }}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
          >
            <img src={loaded.image.src} alt="" draggable={false} />
            {/* The dimming outside the frame, clipped to the picture in a
                layer of its own so the handles can stand past its edge. */}
            <div className="crop-shade" aria-hidden="true">
              <div
                style={{
                  left: rect.x * zoom,
                  top: rect.y * zoom,
                  width: rect.width * zoom,
                  height: rect.height * zoom,
                }}
              />
            </div>
            <div
              className="crop-frame"
              data-testid="crop-frame"
              style={{
                left: rect.x * zoom,
                top: rect.y * zoom,
                width: rect.width * zoom,
                height: rect.height * zoom,
              }}
              onPointerDown={(e) => begin(e, "move")}
            >
              {GRIPS.map(({ name, grip }) => (
                <span
                  key={name}
                  className={`crop-grip crop-grip-${name}`}
                  data-grip={name}
                  aria-hidden="true"
                  onPointerDown={(e) => begin(e, grip)}
                />
              ))}
            </div>
          </div>
        )}
        <div className="crop-fields">
          {field("x", t("crop.left"))}
          {field("y", t("crop.top"))}
          {field("width", t("crop.width"))}
          {field("height", t("crop.height"))}
        </div>
      </div>
      <div className="modal-actions">
        <button
          onClick={() => natural && setRect({ x: 0, y: 0, ...natural })}
          disabled={!natural || whole}
        >
          {t("crop.reset")}
        </button>
        <button onClick={onClose}>{t("common.cancel")}</button>
        <button className="primary" onClick={apply} disabled={!rect || whole}>
          {t("crop.apply")}
        </button>
      </div>
    </Modal>
  );
}
