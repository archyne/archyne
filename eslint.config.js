import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import jsxA11y from "eslint-plugin-jsx-a11y";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "dist-host/**",
      // The VS Code that tests/e2e-vscode-ai.mts downloads: thousands of
      // minified files, enough to run the linter out of memory.
      ".vscode-test/**",
      "release/**",
      "build/**",
      "node_modules/**",
      "public/embed-demo.html",
      "rendertest.html",
      // Generated into the extension: its compiler output, and the copy of
      // the built app it packages.
      "extensions/*/out/**",
      "extensions/*/media/**",
    ],
  },

  // Browser app.
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      jsxA11y.flatConfigs.recommended,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { "react-refresh": reactRefresh },
    rules: {
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      // Errors, not warnings: the debt these flagged has been paid down
      // (tracked in the accessibility work) and the two remaining `autoFocus` uses
      // are user-initiated inline editors with an explicit, justified
      // disable comment. New violations should fail the build.
      "jsx-a11y/no-static-element-interactions": "error",
      "jsx-a11y/click-events-have-key-events": "error",
      "jsx-a11y/no-autofocus": "error",
      // A scrolling pane has to be a tabstop or a keyboard user cannot read
      // past the fold — WCAG 2.1.1, and what axe reports as
      // `scrollable-region-focusable`. The rule's default allows that only on
      // a `tabpanel`; a named `group` or `region` is the same case.
      "jsx-a11y/no-noninteractive-tabindex": [
        "error",
        { tags: [], roles: ["tabpanel", "group", "region"], allowExpressionValues: true },
      ],
      // The codebase leans on `_`-prefixed throwaways in destructuring and
      // event handlers; keep that idiom lint-clean.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },

  // Node-side code: MCP server, browser-driven tests, tooling.
  {
    files: ["mcp/**/*.ts", "tests/**/*.mts", "scripts/**/*.mjs", "*.config.{ts,js}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },

  // VS Code extension host: Node, but a separate TypeScript project with its
  // own dependencies, so it is listed rather than folded into the block above.
  {
    files: ["extensions/*/src/**/*.ts", "extensions/*/scripts/**/*.mjs"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },

  // Electron main process (CommonJS).
  {
    files: ["desktop/**/*.cjs"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: globals.node,
    },
  },

  // Must stay last: turns off everything Prettier owns.
  prettier,
);
