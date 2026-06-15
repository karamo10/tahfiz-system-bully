# CLAUDE.md — Tahfiz Management System

This file documents every architectural decision for the Tahfiz Management System.
Read this before touching any file. If you change something that contradicts this
document, update this document first and explain why.

---

## What this system is

A locally-hosted web application for managing a Quranic memorisation (tahfiz) school.
It tracks student registration, session-by-session memorisation and recitation progress,
and monthly fee payments. It runs on a single machine on-site with no internet required.
Updates are pushed by the maintainer (Kamariana) periodically.

---

## Tech stack

| Layer       | Choice                  | Reason                                              |
|-------------|-------------------------|-----------------------------------------------------|
| Runtime     | Node.js + Express       | Mirrors existing Baraka API patterns                |
| Database    | SQLite via better-sqlite3 | Single file, no server, easy backup, offline-first |
| ORM         | None — raw SQL          | Simpler to maintain, better-sqlite3 is synchronous  |
| Auth        | express-session + bcrypt | Session-based, no JWT complexity needed            |
| Sessions    | session-file-store      | Survives server restarts, no Redis needed           |
| Templates   | EJS                     | Server-rendered HTML, minimal JS                    |
| Styles      | Plain CSS               | BEM naming + CSS custom properties (no Sass build) |
| Frontend JS | Vanilla JS only         | No framework, no bundler                            |

---

## Project structure

```
tahfiz/
├── src/
│   ├── db/
│   │   ├── database.js          # opens connection, sets pragmas
│   │   └── seed.js              # runs schema SQL + seeds surahs
│   ├── middleware/
│   │   └── auth.js              # requireAuth, requireRole
│   ├── routes/
│   │   ├── auth.js              # GET/POST /login, POST /logout
│   │   ├── students.js          # CRUD for students
│   │   ├── sessions.js          # log session, view history
│   │   └── payments.js          # record payment, overview
│   ├── views/
│   │   ├── layout/
│   │   │   └── base.ejs         # base HTML shell with nav
│   │   ├── auth/
│   │   │   └── login.ejs
│   │   ├── dashboard.ejs
│   │   ├── students/
│   │   │   ├── list.ejs
│   │   │   ├── register.ejs
│   │   │   └── detail.ejs
│   │   ├── sessions/
│   │   │   ├── log.ejs
│   │   │   └── history.ejs
│   │   └── payments/
│   │       ├── entry.ejs
│   │       └── overview.ejs
│   └── app.js                   # express setup, mounts all routes
├── public/
│   ├── css/
│   │   └── main.css             # all styles in one file
│   └── js/
│       └── main.js              # minimal vanilla JS
├── data/
│   └── tahfiz.db                # SQLite database file (gitignored)
├── sessions/                    # session-file-store files (gitignored)
├── tahfiz_schema.sql            # source of truth for DB schema
├── .env                         # secrets (gitignored)
├── .env.example                 # committed, no secrets
├── .gitignore
├── package.json
└── CLAUDE.md                    # this file
```

---

## Database

### Engine
SQLite. Database file lives at `data/tahfiz.db`.
The path is set via `DB_PATH` in `.env`, defaulting to `./data/tahfiz.db`.

### Connection
Opened once in `src/db/database.js` and exported as a singleton.
Every module that needs the DB imports from there — never open a second connection.

```js
// src/db/database.js
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || './data/tahfiz.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
module.exports = db;
```

### Pragmas — run on every connection open
- `journal_mode = WAL` — better concurrent reads
- `foreign_keys = ON` — SQLite does NOT enforce FK constraints by default

### Schema source of truth
`tahfiz_schema.sql` is the canonical schema. Run `node src/db/seed.js` to
initialise a fresh database. Never hand-edit `tahfiz.db` directly.

### Tables

| Table        | Purpose                                              |
|--------------|------------------------------------------------------|
| surah        | Static reference — 114 surahs, seeded once           |
| user         | All staff: admin, teacher, secretary                 |
| student      | Registration + placement assessment result           |
| session_log  | Every teaching session (hifz or muraja)              |
| payment      | Monthly fee record per student                       |

### Key constraints
- `payment` has `UNIQUE (student_id, month, year)` — one record per student per month.
  Use `INSERT OR REPLACE` when updating.
- `student.entry_level` is either `'qaida'` or `'quran'`.
  If `'qaida'`: `qaida_level` is filled, surah/ayah fields are NULL.
  If `'quran'`: `entry_surah_id` + `entry_ayah` are filled, `qaida_level` is NULL.
- `session_log` references `surah` twice: `from_surah_id` and `to_surah_id`.

### Views (pre-built queries)
- `v_student_progress` — each student's last session and current position
- `v_payment_summary` — all unpaid/partial payment records with balance

---

## Authentication

### Mechanism
`express-session` with `session-file-store` for persistence across restarts.
Sessions are stored in the `sessions/` directory.

### Passwords
Hashed with `bcrypt`, cost factor 12.
Never store or log plaintext passwords.

### Middleware

```js
// requireAuth — any logged-in user
function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

// requireRole — specific role(s) only
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.session.user?.role)) {
      return res.status(403).render('error', { message: 'Access denied' });
    }
    next();
  };
}
```

### Session object shape
```js
req.session.user = {
  id:        1,
  full_name: 'Ustaz Lamin',
  email:     'lamin@tahfiz.gm',
  role:      'teacher'   // 'admin' | 'teacher' | 'secretary'
};
```

---

## Role permissions

| Action                  | secretary | teacher        | admin |
|-------------------------|-----------|----------------|-------|
| Register student        | ✓         | —              | ✓     |
| View student list       | ✓ (all)   | ✓ (own only)   | ✓     |
| View student detail     | ✓         | ✓ (own only)   | ✓     |
| Log session             | —         | ✓              | ✓     |
| View session history    | —         | ✓ (own only)   | ✓     |
| Record payment          | ✓         | —              | ✓     |
| View payment overview   | —         | —              | ✓     |
| Manage users            | —         | —              | ✓     |

"Own only" means: teacher sees students assigned to them via `student.assigned_teacher_id`.

---

## Routes

### Auth
```
GET  /login           → login form
POST /login           → authenticate, set session, redirect to /
POST /logout          → destroy session, redirect to /login
```

### Students
```
GET  /students               → list (filtered by role)
GET  /students/register      → registration form
POST /students/register      → create student record
GET  /students/:id           → student detail + session history
GET  /students/:id/edit      → edit form (admin/secretary only)
POST /students/:id/edit      → update student
```

### Sessions
```
GET  /sessions/log           → log session form (teacher selects their student)
POST /sessions/log           → create session_log record
GET  /sessions/:studentId    → full session history for a student
```

### Payments
```
GET  /payments               → payment overview (admin only)
GET  /payments/entry         → payment entry form (secretary/admin)
POST /payments/entry         → upsert payment record
GET  /payments/:studentId    → payment history for one student
```

### Dashboard
```
GET  /                       → dashboard (content varies by role)
```

---

## Localisation

| Setting       | Value                         |
|---------------|-------------------------------|
| Currency      | GMD (Gambian Dalasi)          |
| Currency symbol | D (e.g. D 500)              |
| Date format   | DD/MM/YYYY                    |
| Locale        | en-GM                         |
| Week start    | Saturday (school runs Sat–Thu) |

All dates stored in SQLite as ISO strings (`YYYY-MM-DD`).
Format for display only at the template layer — never store formatted dates.

---

## CSS conventions

Plain CSS. No Sass, no build step. One file: `public/css/main.css`.
Follow BEM naming exactly as in the K12MIS/Suuq Dart Sass system:

```css
/* Block */
.student-card { }

/* Element */
.student-card__name { }
.student-card__grade { }

/* Modifier */
.student-card--inactive { }
.payment-badge--unpaid { }
.payment-badge--partial { }
.payment-badge--paid { }
```

### CSS custom properties (design tokens)

```css
:root {
  /* Colours */
  --color-primary:        #1D6A4A;   /* deep green — Islamic feel */
  --color-primary-light:  #E8F5F0;
  --color-primary-dark:   #134D35;
  --color-accent:         #C49A28;   /* gold */
  --color-danger:         #C0392B;
  --color-warning:        #E67E22;
  --color-success:        #27AE60;
  --color-text-primary:   #1A1A1A;
  --color-text-secondary: #5C5C5C;
  --color-text-muted:     #9A9A9A;
  --color-border:         #D8D8D8;
  --color-bg:             #F9F9F7;
  --color-surface:        #FFFFFF;

  /* Spacing */
  --spacing-xs:   4px;
  --spacing-sm:   8px;
  --spacing-md:   16px;
  --spacing-lg:   24px;
  --spacing-xl:   40px;

  /* Typography */
  --font-sans:    'Segoe UI', system-ui, sans-serif;
  --font-mono:    'Courier New', monospace;
  --text-sm:      13px;
  --text-base:    15px;
  --text-lg:      18px;
  --text-xl:      22px;

  /* Radius */
  --radius-sm:    4px;
  --radius-md:    8px;
  --radius-lg:    12px;

  /* Shadows */
  --shadow-sm:    0 1px 3px rgba(0,0,0,0.08);
  --shadow-md:    0 4px 12px rgba(0,0,0,0.10);
}
```

---

## Environment variables

Defined in `.env` (never committed). Copy `.env.example` to `.env` to start.

```
PORT=3000
DB_PATH=./data/tahfiz.db
SESSION_SECRET=replace_with_long_random_string
SESSION_DIR=./sessions
NODE_ENV=development
```

---

## Error handling

All route handlers use a standard try/catch pattern:

```js
router.post('/students/register', requireAuth, requireRole('admin', 'secretary'), (req, res) => {
  try {
    // synchronous better-sqlite3 calls — no async needed
    const stmt = db.prepare(`INSERT INTO student (...) VALUES (...)`);
    stmt.run(...);
    res.redirect('/students');
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Something went wrong.' });
  }
});
```

Note: `better-sqlite3` is synchronous — no `async/await`, no `.then()`.
This is intentional. Do not switch to `sqlite3` (async) or introduce Promises here.

---

## Backup strategy

The entire database is a single file: `data/tahfiz.db`.
To back up: copy this file to a USB drive or Google Drive.
Recommended: weekly backup minimum, monthly archival copy.

A future improvement (Phase 2) can automate this with a scheduled script.

---

## What is NOT in Phase 1

Do not build these until Phase 1 is stable and in use:

- SMS or email notifications
- Automated backup script
- PDF report generation
- Mobile app
- Cloud sync
- Parent portal
- Attendance tracking (separate from session logging)
- Quran audio integration

---

## Phase 2 ideas (for reference only)

- PDF progress reports per student (monthly)
- Automated weekly backup to Google Drive
- Dashboard charts (memorisation progress over time)
- Bulk payment entry for a whole class
- Electron wrapper for true desktop packaging

---

## Developer handoff notes

- The maintainer is **Kamariana** (web developer, University of The Gambia).
  All questions about architecture decisions go through them first.
- Do not upgrade `better-sqlite3` without testing — the synchronous API is a feature, not a bug.
- Do not introduce an ORM. Raw SQL is intentional.
- Do not add a frontend framework. EJS + vanilla JS is intentional.
- The `sessions/` and `data/` directories must exist before starting the server.
  `node src/db/seed.js` creates them.
- Always test role-based access after any route change.
- The `surah` table is read-only after seeding. Never write to it in application code.
