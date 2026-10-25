import { useEffect, useState } from "react";
import { useGraphStore } from "../store";
import { ACTOR_PATH } from "./ActorGlyph";
import { ImportIcon } from "./ImportIcon";
import { useIconPrefs } from "../iconPrefs";
import { SHAPES, type NodeSeed, type Shape } from "../model/types";
import { BUILTIN_ICON_NAMES, ICON_COLLECTIONS, iconsByPrefix, searchIcons } from "../icons";
import { useAddNodeAtCenter } from "../placement";
import { COMMON_ICONS } from "../iconSuggestions";
import { useIconPack } from "../iconPack";
import { iconRole, plainName, VENDORS, VENDOR_LABELS } from "../model/iconRole";
import { useT, type MessageKey } from "../i18n";
import { IconView } from "./ArchView";

/** Draggable icon cell with a favorite toggle. */
function IconCell({ name, onShow }: { name: string; onShow?: (name: string | null) => void }) {
  const favorites = useIconPrefs((s) => s.favorites);
  const toggleFavorite = useIconPrefs((s) => s.toggleFavorite);
  const addAtCenter = useAddNodeAtCenter();
  const t = useT();
  const fav = favorites.includes(name);
  // A virtual network is a thing you put things inside; a function app is a
  // thing you put in one. Adding both as the same box made the containers
  // useless — you cannot draw a topology if the VNet cannot hold the subnet.
  // In a flowchart every icon is a picture, so none of them is a container.
  const flowchart = useGraphStore((s) => s.kind === "flowchart");
  const container = !flowchart && iconRole(plainName(name)) === "group";
  const seed: NodeSeed = container
    ? { type: "group", icon: name }
    : { type: "service", icon: name };
  return (
    // The cell stays a plain container so the icon and the favourite toggle
    // can each be their own button — nesting them would be invalid.
    <div
      className="icon-cell"
      draggable
      onMouseEnter={() => onShow?.(name)}
      onMouseLeave={() => onShow?.(null)}
      onFocus={() => onShow?.(name)}
      onBlur={() => onShow?.(null)}
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-graph-node", JSON.stringify(seed));
      }}
    >
      <button
        type="button"
        className={`icon-add${container ? " container" : ""}`}
        title={container ? t("palette.addGroup", { name }) : t("palette.add", { name })}
        onClick={() => addAtCenter(seed)}
      >
        <IconView name={name} size={26} />
      </button>
      <button
        className={`star${fav ? " active" : ""}`}
        title={fav ? t("palette.removeFavorite") : t("palette.addFavorite")}
        aria-pressed={fav}
        onClick={(e) => {
          e.stopPropagation();
          toggleFavorite(name);
        }}
      >
        <span aria-hidden="true">{fav ? "★" : "☆"}</span>
      </button>
    </div>
  );
}

const GROUP_PREVIEW = "M4,3 h40 v18 h-40 Z M4,3 v4 M8,3 h6";

const GROUP_ITEM: Item = {
  labelKey: "shape.group",
  seed: { type: "group" },
  preview: GROUP_PREVIEW,
};

const SHAPE_PREVIEW: Record<Shape, string> = {
  square: "M2,2 h44 v20 h-44 Z",
  round: "M8,2 h32 a6,6 0 0 1 6,6 v8 a6,6 0 0 1 -6,6 h-32 a6,6 0 0 1 -6,-6 v-8 a6,6 0 0 1 6,-6",
  stadium: "M12,2 h24 a10,10 0 0 1 0,20 h-24 a10,10 0 0 1 0,-20",
  subroutine: "M2,2 h44 v20 h-44 Z M7,2 v20 M41,2 v20",
  cylinder: "M2,6 a22,4 0 0 1 44,0 v12 a22,4 0 0 1 -44,0 Z M2,6 a22,4 0 0 0 44,0",
  circle: "M24,2 a10,10 0 1 1 0,20 a10,10 0 1 1 0,-20",
  doublecircle:
    "M24,2 a10,10 0 1 1 0,20 a10,10 0 1 1 0,-20 M24,5 a7,7 0 1 1 0,14 a7,7 0 1 1 0,-14",
  diamond: "M24,1 L46,12 L24,23 L2,12 Z",
  hexagon: "M10,2 h28 l8,10 l-8,10 h-28 l-8,-10 Z",
  odd: "M2,12 L10,2 h36 v20 h-36 Z",
  trapezoid: "M10,2 h28 l8,20 h-44 Z",
  inv_trapezoid: "M2,2 h44 l-8,20 h-28 Z",
  lean_right: "M9,2 h37 l-7,20 h-37 Z",
  lean_left: "M2,2 h37 l7,20 h-37 Z",
};

interface Item {
  /** Catalogue key, resolved at render so the palette follows the locale. */
  labelKey: MessageKey;
  seed: NodeSeed;
  preview: string;
}

const STATE_ITEMS: Item[] = [
  {
    labelKey: "item.state",
    seed: { type: "state", stateType: "normal" },
    preview: SHAPE_PREVIEW.round,
  },
  {
    labelKey: "item.start",
    seed: { type: "state", stateType: "start" },
    preview: "M24,4 a8,8 0 1 1 0,16 a8,8 0 1 1 0,-16 Z",
  },
  {
    labelKey: "item.end",
    seed: { type: "state", stateType: "end" },
    preview:
      "M24,2 a10,10 0 1 1 0,20 a10,10 0 1 1 0,-20 M24,7 a5,5 0 1 1 0,10 a5,5 0 1 1 0,-10 Z",
  },
  {
    labelKey: "item.choice",
    seed: { type: "state", stateType: "choice" },
    preview: "M24,1 L46,12 L24,23 L2,12 Z",
  },
  {
    labelKey: "item.forkJoin",
    seed: { type: "state", stateType: "fork" },
    preview: "M6,9 h36 v6 h-36 Z",
  },
];
const ER_ITEMS: Item[] = [
  {
    labelKey: "item.entity",
    seed: { type: "entity" },
    preview: "M2,2 h44 v20 h-44 Z M2,10 h44",
  },
];
const CLASS_ITEMS: Item[] = [
  {
    labelKey: "item.class",
    seed: { type: "class" },
    preview: "M2,2 h44 v20 h-44 Z M2,9 h44 M2,16 h44",
  },
  {
    labelKey: "item.note",
    seed: { type: "note" },
    preview: "M4,2 h32 l8,8 v12 h-40 Z M36,2 v8 h8",
  },
];
const C4_ITEMS: Item[] = [
  {
    labelKey: "item.person",
    seed: { type: "c4", c4Shape: "person" },
    preview: "M24,3 a4,4 0 1 1 0,8 a4,4 0 1 1 0,-8 M14,22 v-3 a10,7 0 0 1 20,0 v3",
  },
  {
    labelKey: "item.system",
    seed: { type: "c4", c4Shape: "system" },
    preview: "M4,4 h40 v16 h-40 Z",
  },
  {
    labelKey: "item.systemExt",
    seed: { type: "c4", c4Shape: "external_system" },
    preview: "M4,4 h40 v16 h-40 Z M8,8 h6",
  },
  {
    labelKey: "item.systemDb",
    seed: { type: "c4", c4Shape: "system_db" },
    preview: "M6,7 a18,4 0 0 1 36,0 v10 a18,4 0 0 1 -36,0 Z",
  },
  {
    labelKey: "item.container",
    seed: { type: "c4", c4Shape: "container" },
    preview:
      "M6,4 h36 a4,4 0 0 1 4,4 v8 a4,4 0 0 1 -4,4 h-36 a4,4 0 0 1 -4,-4 v-8 a4,4 0 0 1 4,-4",
  },
  {
    labelKey: "item.component",
    seed: { type: "c4", c4Shape: "component" },
    preview: "M8,4 h36 v16 h-36 Z M4,8 h8 M4,14 h8",
  },
];

const SEQ_ITEMS: Item[] = [
  {
    labelKey: "item.participant",
    seed: { type: "participant", ptype: "participant" },
    preview: "M6,2 h36 v12 h-36 Z M24,14 v8",
  },
  {
    labelKey: "item.actor",
    seed: { type: "participant", ptype: "actor" },
    preview: ACTOR_PATH,
  },
  {
    labelKey: "item.note",
    seed: { type: "seqnote" },
    preview: "M4,2 h32 l8,8 v12 h-40 Z M36,2 v8 h8",
  },
  {
    labelKey: "item.loop",
    seed: { type: "seqblock", op: "loop" },
    preview: "M2,2 h44 v20 h-44 Z M2,9 h16 M2,2 v7",
  },
  {
    labelKey: "item.altElse",
    seed: { type: "seqblock", op: "alt" },
    preview: "M2,2 h44 v20 h-44 Z M2,9 h14 M2,13 h44",
  },
  {
    labelKey: "item.opt",
    seed: { type: "seqblock", op: "opt" },
    preview: "M2,2 h44 v20 h-44 Z M2,9 h12",
  },
];

function PaletteItem({ item }: { item: Item }) {
  const addAtCenter = useAddNodeAtCenter();
  const t = useT();
  const label = t(item.labelKey);
  return (
    // A button, not a div: dragging is the pointer shortcut, but activating
    // it with Enter or Space has to work too.
    <button
      type="button"
      className="palette-item"
      title={t("palette.add", { name: label })}
      draggable
      onClick={() => addAtCenter(item.seed)}
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-graph-node", JSON.stringify(item.seed));
        e.dataTransfer.effectAllowed = "move";
      }}
    >
      <svg width={48} height={24} viewBox="0 0 48 24" aria-hidden="true">
        <path d={item.preview} className="palette-shape" />
      </svg>
      <span>{label}</span>
    </button>
  );
}

interface IconCategory {
  label: string;
  prefixes: string[];
  /** Restrict the category to specific collections (default: all). */
  collections?: string[];
  /**
   * Prefixes for one collection in place of `prefixes`. Azure needs it: all of
   * Microsoft's own set belongs, which is an empty prefix — and an empty
   * prefix anywhere else is every icon in that collection, which is how the
   * Azure chip came to show Adobe, Airbnb and Amazon.
   */
  byCollection?: Record<string, string[]>;
}

const ICON_CATEGORIES: IconCategory[] = [
  { label: "AWS", prefixes: ["aws"] },
  { label: "Google", prefixes: ["google", "gcp", "firebase"] },
  {
    label: "Azure",
    // Microsoft's own set first — it is the one that has a VNet in it — with
    // the brand logos behind it for anything it does not cover.
    prefixes: ["azure", "microsoft"],
    byCollection: { azure: [""] },
    collections: ["azure", "logos", "devicon", "simple-icons"],
  },
  {
    label: "Generic",
    collections: ["carbon", "tabler"],
    prefixes: [
      "bare-metal-server",
      "load-balancer",
      "firewall",
      "gateway",
      "server",
      "data-base",
      "database",
      "user-multiple",
      "user",
      "devices",
      "mobile",
      "browser",
      "network",
      "queue",
      "api",
      "cloud",
      "shield",
      "mail",
      "lock",
      "world",
      "router",
    ],
  },
  {
    label: "Data",
    prefixes: [
      "postgresql",
      "mysql",
      "mariadb",
      "mongodb",
      "redis",
      "elastic",
      "kafka",
      "rabbitmq",
      "cassandra",
      "snowflake",
      "sqlite",
      "clickhouse",
      "influxdb",
      "neo4j",
    ],
  },
  {
    label: "DevOps",
    prefixes: [
      "kubernetes",
      "docker",
      "terraform",
      "ansible",
      "jenkins",
      "github",
      "gitlab",
      "argo",
      "prometheus",
      "grafana",
      "nginx",
      "helm",
      "vault",
      "consul",
      "istio",
    ],
  },
];

/**
 * The vendor icons: the ones this diagram carries, the recent and favourite
 * ones, and the search over the bundled collections. Shared by architecture,
 * where an icon is a service, and flowchart, where it is a picture with its
 * name under it — the cloud diagrams drawn as flowcharts, and every one
 * imported from draw.io, are made of exactly these.
 */
function VendorIcons() {
  const [query, setQuery] = useState("");
  /** The icon under the pointer or the focus, named under the search. */
  const [shown, setShown] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [results, setResults] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    const q = query.trim();
    const t = setTimeout(() => {
      if (!alive) return;
      if (!q && !category) {
        setResults([]);
        return;
      }
      const fetch = q
        ? searchIcons(q)
        : (async () => {
            const cat = ICON_CATEGORIES.find((c) => c.label === category)!;
            const out: string[] = [];
            for (const collection of cat.collections ?? ICON_COLLECTIONS) {
              const prefixes = cat.byCollection?.[collection] ?? cat.prefixes;
              out.push(...(await iconsByPrefix(collection, prefixes, 48)));
              if (out.length >= 144) break;
            }
            return out.slice(0, 144);
          })();
      void fetch.then((r) => {
        if (alive) setResults(r);
      });
    }, 200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query, category]);

  const t = useT();
  const icons = query.trim() || category ? results : COMMON_ICONS;
  const favorites = useIconPrefs((s) => s.favorites);
  const recents = useIconPrefs((s) => s.recents);
  const carried = Object.keys(useGraphStore((s) => s.iconLibrary))
    .sort()
    .map((n) => `custom:${n}`);
  const pinned = [...favorites, ...recents.filter((r) => !favorites.includes(r))];
  const vendorOf = useIconPack((s) => s.vendors);

  // Six hundred imported icons in one strip is a wall, and Azure's next to
  // Amazon's is a wall you cannot read. Filed by whoever published them, in
  // the order the vendors are listed, with anything unattributed last.
  const byVendor = VENDORS.map((vendor) => ({
    vendor,
    icons: carried.filter((ref) => (vendorOf[plainName(ref)] ?? "other") === vendor),
  })).filter((section) => section.icons.length > 0);

  return (
    <>
      {/* Imported icons. They are in no bundled collection, so without a
          place of their own the only way back to one was to remember its
          name — and filed by vendor, because a pack is hundreds of them. */}
      {byVendor.map(({ vendor, icons }) => (
        <div key={vendor}>
          <div className="panel-title">
            {VENDOR_LABELS[vendor] || t("palette.sectionCarried")}
          </div>
          <div className="icon-grid pinned">
            {icons.map((name) => (
              <IconCell key={name} name={name} onShow={setShown} />
            ))}
          </div>
        </div>
      ))}
      {pinned.length > 0 && (
        <>
          <div className="panel-title">{t("palette.sectionPinned")}</div>
          <div className="icon-grid pinned">
            {pinned.map((name) => (
              <IconCell key={name} name={name} onShow={setShown} />
            ))}
          </div>
        </>
      )}
      <div className="panel-title">{t("palette.sectionVendor")}</div>
      <div className={`icon-search-wrap${query ? " has-query" : ""}`}>
        <svg className="icon-search-glass" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5 14 14" />
        </svg>
        <input
          className="icon-search"
          placeholder={t("palette.searchIcons")}
          aria-label={t("palette.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <button
            type="button"
            className="icon-search-clear"
            aria-label={t("palette.clearSearch")}
            title={t("palette.clearSearch")}
            onClick={() => setQuery("")}
          >
            <span aria-hidden="true">×</span>
          </button>
        )}
      </div>
      <div className="chip-row">
        {ICON_CATEGORIES.map((c) => (
          <button
            key={c.label}
            className={`chip${category === c.label && !query.trim() ? " active" : ""}`}
            onClick={() => {
              setQuery("");
              setCategory(category === c.label ? null : c.label);
            }}
          >
            {c.label}
          </button>
        ))}
      </div>
      {/* The name of the icon pointed at: the pictures alone do not say which
          of three blue clouds is which, and a tooltip takes a while. */}
      <div className="icon-readout-line" aria-hidden="true">
        {shown ?? "\u00a0"}
      </div>
      <div className="icon-grid">
        {icons.map((name) => (
          <IconCell key={name} name={name} onShow={setShown} />
        ))}
        {query.trim() && icons.length === 0 && (
          <div className="palette-hint">{t("palette.noIcons")}</div>
        )}
      </div>
      {/* Last, for the icon none of the bundled sets has. */}
      <div className="icon-import">
        <ImportIcon />
      </div>
    </>
  );
}

function ArchPalette() {
  const t = useT();
  return (
    <aside className="palette palette-arch" aria-label={t("palette.architecture")}>
      <div className="panel-title">{t("palette.sectionBase")}</div>
      <div className="palette-grid">
        {BUILTIN_ICON_NAMES.map((name) => (
          <div
            key={name}
            className="palette-item"
            title={name}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(
                "application/x-graph-node",
                JSON.stringify({ type: "service", icon: name } satisfies NodeSeed),
              );
            }}
          >
            <span className="palette-icon-slot">
              <IconView name={name} size={22} />
            </span>
            <span>{name}</span>
          </div>
        ))}
        <div
          className="palette-item"
          title="junction"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(
              "application/x-graph-node",
              JSON.stringify({ type: "junction" } satisfies NodeSeed),
            );
          }}
        >
          <span className="palette-icon-slot">
            <span className="junction-preview" />
          </span>
          <span>{t("item.junction")}</span>
        </div>
        <PaletteItem item={GROUP_ITEM} />
      </div>
      <VendorIcons />
    </aside>
  );
}

export function Palette() {
  const kind = useGraphStore((s) => s.kind);
  const unsupported = useGraphStore((s) => s.unsupported);
  const t = useT();

  if (unsupported) {
    // Offering shapes here would imply an editing path that does not exist.
    return (
      <aside className="palette" aria-label={t("palette.shapes")}>
        <div className="panel-title">{t("palette.sectionShapes")}</div>
        <div className="palette-hint">{t("unsupported.paletteHint")}</div>
      </aside>
    );
  }

  if (kind === "architecture") return <ArchPalette />;

  const base: Item[] =
    kind === "flowchart"
      ? SHAPES.map((shape) => ({
          labelKey: `shape.${shape}` as MessageKey,
          seed: { type: "shape", shape },
          preview: SHAPE_PREVIEW[shape],
        }))
      : kind === "state"
        ? STATE_ITEMS
        : kind === "er"
          ? ER_ITEMS
          : kind === "class"
            ? CLASS_ITEMS
            : kind === "c4"
              ? C4_ITEMS
              : SEQ_ITEMS;

  const groupLabel =
    kind === "flowchart"
      ? "item.subgraph"
      : kind === "state"
        ? "item.compositeState"
        : kind === "c4"
          ? "item.boundary"
          : kind === "class"
            ? "item.namespace"
            : null;
  const items: Item[] = groupLabel ? [...base, { ...GROUP_ITEM, labelKey: groupLabel }] : base;

  return (
    <aside
      className={`palette${kind === "flowchart" ? " palette-arch" : ""}`}
      aria-label={t("palette.shapes")}
    >
      <div className="panel-title">{t("palette.sectionShapes")}</div>
      <div className="palette-hint">{t("palette.hint")}</div>
      <div className="palette-grid">
        {items.map((item) => (
          <PaletteItem key={item.labelKey} item={item} />
        ))}
      </div>
      {kind === "flowchart" && (
        <div className="palette-divided">
          <VendorIcons />
        </div>
      )}
    </aside>
  );
}
