/**
 * Whether a file is one the person told VS Code to open on Archyne's canvas
 * (`workbench.editorAssociations`), read the way VS Code reads that setting:
 * a pattern with no slash is matched against the file's name, one with a
 * slash against its whole path; `*`, `**`, `?` and `{a,b}` as in a glob.
 *
 * Pure, so it is tested apart from VS Code (association.test.ts); the part
 * that uses it is `reopenAssociated` in extension.ts.
 */

function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` is any number of folders, none included.
        out += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += glob[i + 2] === "/" ? 2 : 1;
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end < 0) out += "\\{";
      else {
        out += `(?:${glob
          .slice(i + 1, end)
          .split(",")
          .map((p) => p.replace(/[.+^$()|[\]\\]/g, "\\$&"))
          .join("|")})`;
        i = end;
      }
    } else out += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, "i");
}

/** The patterns in an `editorAssociations` value that name this editor. */
export function patternsFor(associations: unknown, viewType: string): string[] {
  if (Array.isArray(associations)) {
    // The older form: [{ viewType, filenamePattern }].
    return associations
      .filter((a) => a?.viewType === viewType && typeof a.filenamePattern === "string")
      .map((a) => a.filenamePattern as string);
  }
  if (associations && typeof associations === "object") {
    return Object.entries(associations as Record<string, unknown>)
      .filter(([, id]) => id === viewType)
      .map(([pattern]) => pattern);
  }
  return [];
}

/** Whether a file at `path` (forward slashes) matches one of the patterns. */
export function associated(path: string, patterns: string[]): boolean {
  const normal = path.replace(/\\/g, "/");
  const name = normal.slice(normal.lastIndexOf("/") + 1);
  return patterns.some((p) =>
    globToRegExp(p.replace(/\\/g, "/")).test(p.includes("/") ? normal : name),
  );
}
