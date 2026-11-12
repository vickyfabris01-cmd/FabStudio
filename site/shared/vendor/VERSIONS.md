# Vendored libraries (self-hosted so the app starts offline)

| File | Package | Version | Source |
|---|---|---|---|
| supabase.js | @supabase/supabase-js | 2.118.0 | dist/umd/supabase.js |
| dexie.min.js | dexie | 4.4.7 | dist/dexie.min.js |

To upgrade: `npm i <package>@<version>`, copy the file named above over the old one,
and test sign-in, offline writing and sync before deploying.
