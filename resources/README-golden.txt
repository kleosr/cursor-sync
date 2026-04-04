golden-chat-store.template.db is generated from golden-store-template.sql.

Regenerate (Python):
  python -c "import sqlite3, pathlib; p=pathlib.Path('resources/golden-chat-store.template.db'); p.unlink(missing_ok=True); c=sqlite3.connect(p); c.executescript(open('resources/golden-store-template.sql',encoding='utf-8').read()); c.close()"

Or: node scripts/create-golden-store-template.mjs (requires sqlite3 on PATH).

Bump PRAGMA user_version in the SQL file and GOLDEN_STORE_TEMPLATE_VERSION in src/store-template-hydrate.ts when the layout changes.
