import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: ["data/**", "node_modules/**"],
  },
  js.configs.recommended,
  {
    files: ["src/**/*.js", "scripts/**/*.mjs", "test/**/*.js", "eslint.config.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_|^(req|res|u|e|err|ctx)$",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["public/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: {
        ...globals.browser,
        // Defined in layout.js, used across page scripts.
        mpFlashSaved: "readonly",
        mpOpenEditor: "readonly",
        mpCloseEditor: "readonly",
        initSidebar: "readonly",
        rprofRow: "readonly",
      },
    },
    rules: {
      // Browser page scripts expose top-level functions for inline handlers.
      "no-unused-vars": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    // layout.js defines the shared globals — allowed to declare them itself.
    files: ["public/layout.js"],
    rules: {
      "no-redeclare": "off",
    },
  },
];
