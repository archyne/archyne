import { create } from "zustand";

/** Recently used and favorite vendor icons, persisted per browser. */
interface IconPrefs {
  recents: string[];
  favorites: string[];
  recordRecent: (name: string) => void;
  toggleFavorite: (name: string) => void;
  /** Drop an icon that no longer exists from both lists. */
  forget: (name: string) => void;
}

const RECENTS_KEY = "graph:recent-icons";
const FAVS_KEY = "graph:fav-icons";

function load(key: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function save(key: string, value: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable — prefs are best-effort
  }
}

export const useIconPrefs = create<IconPrefs>((set, get) => ({
  recents: load(RECENTS_KEY),
  favorites: load(FAVS_KEY),

  recordRecent: (name) => {
    // Builtins are always visible in the Base section — track packs only.
    if (!name.includes(":")) return;
    const recents = [name, ...get().recents.filter((n) => n !== name)].slice(0, 12);
    set({ recents });
    save(RECENTS_KEY, recents);
  },

  toggleFavorite: (name) => {
    const has = get().favorites.includes(name);
    const favorites = has
      ? get().favorites.filter((n) => n !== name)
      : [name, ...get().favorites].slice(0, 24);
    set({ favorites });
    save(FAVS_KEY, favorites);
  },

  forget: (name) => {
    const recents = get().recents.filter((n) => n !== name);
    const favorites = get().favorites.filter((n) => n !== name);
    set({ recents, favorites });
    save(RECENTS_KEY, recents);
    save(FAVS_KEY, favorites);
  },
}));
