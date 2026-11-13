import js from "@eslint/js";
import globals from "globals";

export default [
  // user.js is a Firefox prefs file (Firefox's own parser), not JavaScript.
  { ignores: ["dist/", "coverage/", "node_modules/", ".venv/", "user.js"] },
  js.configs.recommended,
  {
    // Extension scripts: plain scripts sharing one global scope per page.
    files: ["extension/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: { ...globals.browser, ...globals.webextensions },
    },
  },
  {
    // Loaded after lib/model.js, which defines ZF.
    files: ["extension/background.js", "extension/sidebar/sidebar.js", "extension/options/options.js"],
    languageOptions: { globals: { ZF: "readonly" } },
  },
  {
    // Run inside Firefox's own UI by install.sh, through Marionette.
    files: ["firefox_setup.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        ...globals.browser,
        arguments: "readonly",
        AddonManager: "readonly",
        CustomizableUI: "readonly",
        gBrowser: "readonly",
        IOUtils: "readonly",
        PathUtils: "readonly",
        SessionStore: "readonly",
        SidebarController: "readonly",
      },
    },
  },
  {
    files: ["test/**/*.js", "scripts/**/*.mjs", "*.mjs"],
    languageOptions: { sourceType: "module", globals: globals.node },
  },
];
