require('dotenv').config();
const express      = require('express');
const session      = require('express-session');
const FileStore    = require('session-file-store')(session);
const flash        = require('connect-flash');
const path         = require('path');
const fs           = require('fs');
const db           = require('./db/database');
const translations = require('./i18n/translations');

const authRoutes     = require('./routes/auth');
const studentRoutes  = require('./routes/students');
const sessionRoutes  = require('./routes/sessions');
const paymentRoutes  = require('./routes/payments');
const { requireAuth, requireRole } = require('./middleware/auth');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Sessions dir ──────────────────────────────────────────────────────────────

const sessDir = path.resolve(process.env.SESSION_DIR || './sessions');
if (!fs.existsSync(sessDir)) fs.mkdirSync(sessDir, { recursive: true });

// ── View engine ───────────────────────────────────────────────────────────────

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, '../public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  store:             new FileStore({ path: sessDir, ttl: 86400 * 7, retries: 1 }),
  secret:            process.env.SESSION_SECRET || 'tahfiz_dev_secret',
  resave:            false,
  saveUninitialized: false,
  cookie: {
    maxAge:   86400 * 7 * 1000, // 7 days
    httpOnly: true,
    sameSite: 'strict'
  }
}));

app.use(flash());

// ── Locals available in all templates ────────────────────────────────────────

app.use((req, res, next) => {
  res.locals.user       = req.session.user || null;
  res.locals.error      = req.flash('error');
  res.locals.success    = req.flash('success');
  res.locals.activePage = req.path.split('/')[1] || 'dashboard';
  const lang            = req.session.lang || 'en';
  res.locals.lang       = lang;
  res.locals.t          = translations[lang];
  next();
});

// ── Routes ────────────────────────────────────────────────────────────────────

app.use('/', authRoutes);
app.use('/students', studentRoutes);
app.use('/sessions', sessionRoutes);
app.use('/payments', paymentRoutes);

// ── Dashboard ─────────────────────────────────────────────────────────────────

app.get('/', requireAuth, (req, res) => {
  try {
    const { user } = req.session;
    const now = new Date();
    const thisMonth = now.getMonth() + 1;
    const thisYear  = now.getFullYear();

    // Stats vary by role
    let stats = {};

    if (user.role === 'admin' || user.role === 'secretary') {
      stats.totalStudents  = db.prepare("SELECT COUNT(*) AS n FROM student WHERE status = 'active'").get().n;
      stats.totalTeachers  = db.prepare("SELECT COUNT(*) AS n FROM user WHERE role = 'teacher' AND is_active = 1").get().n;
      stats.sessionsToday  = db.prepare("SELECT COUNT(*) AS n FROM session_log WHERE session_date = date('now')").get().n;

      const payStats = db.prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS paid,
          SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) AS partial,
          SUM(CASE WHEN status = 'unpaid' THEN 1 ELSE 0 END) AS unpaid,
          SUM(amount_due - amount_paid) AS outstanding
        FROM payment
        WHERE month = ? AND year = ?
      `).get(thisMonth, thisYear);
      stats.payments = payStats;

      // Recent sessions
      stats.recentSessions = db.prepare(`
        SELECT sl.session_date, sl.type, sl.recitation_grade,
               s.full_name AS student_name,
               u.full_name AS teacher_name,
               ts.name_en  AS to_surah_name,
               sl.to_ayah,  sl.qaida_to
        FROM session_log sl
        JOIN student s ON s.id = sl.student_id
        JOIN user u    ON u.id = sl.teacher_id
        LEFT JOIN surah ts ON ts.id = sl.to_surah_id
        ORDER BY sl.session_date DESC, sl.id DESC
        LIMIT 8
      `).all();

      // Students with no session this week
      stats.noSessionThisWeek = db.prepare(`
        SELECT s.full_name, u.full_name AS teacher_name
        FROM student s
        JOIN user u ON u.id = s.assigned_teacher_id
        WHERE s.status = 'active'
          AND s.id NOT IN (
            SELECT DISTINCT student_id FROM session_log
            WHERE session_date >= date('now', '-7 days')
          )
        ORDER BY s.full_name
        LIMIT 10
      `).all();

    } else if (user.role === 'teacher') {
      stats.myStudents    = db.prepare("SELECT COUNT(*) AS n FROM student WHERE assigned_teacher_id = ? AND status = 'active'").get(user.id).n;
      stats.sessionsToday = db.prepare("SELECT COUNT(*) AS n FROM session_log WHERE teacher_id = ? AND session_date = date('now')").get(user.id).n;

      stats.recentSessions = db.prepare(`
        SELECT sl.session_date, sl.type, sl.recitation_grade,
               s.full_name AS student_name,
               ts.name_en  AS to_surah_name,
               sl.to_ayah, sl.qaida_to
        FROM session_log sl
        JOIN student s ON s.id = sl.student_id
        LEFT JOIN surah ts ON ts.id = sl.to_surah_id
        WHERE sl.teacher_id = ?
        ORDER BY sl.session_date DESC, sl.id DESC
        LIMIT 8
      `).all(user.id);

      stats.myStudentList = db.prepare(`
        SELECT s.id, s.full_name, s.entry_level, s.status,
               sl.session_date AS last_session, ts.name_en AS last_surah, sl.to_ayah AS last_ayah
        FROM student s
        LEFT JOIN session_log sl ON sl.id = (
          SELECT id FROM session_log WHERE student_id = s.id ORDER BY session_date DESC, id DESC LIMIT 1
        )
        LEFT JOIN surah ts ON ts.id = sl.to_surah_id
        WHERE s.assigned_teacher_id = ? AND s.status = 'active'
        ORDER BY s.full_name
      `).all(user.id);
    }

    res.render('dashboard', {
      user,
      stats,
      thisMonth,
      thisYear,
      monthName: ['','January','February','March','April','May','June',
                  'July','August','September','October','November','December'][thisMonth]
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { user: req.session.user, message: 'Could not load dashboard.' });
  }
});

// ── Users (admin only) ────────────────────────────────────────────────────────

app.get('/users', requireAuth, requireRole('admin'), (req, res) => {
  const users = db.prepare('SELECT id, full_name, email, role, is_active, created_at FROM user ORDER BY role, full_name').all();
  res.render('users/list', { user: req.session.user, users });
});

app.get('/users/new', requireAuth, requireRole('admin'), (req, res) => {
  res.render('users/form', { user: req.session.user, editing: null, error: req.flash('error') });
});

app.post('/users/new', requireAuth, requireRole('admin'), (req, res) => {
  const { full_name, email, password, role } = req.body;
  if (!full_name || !email || !password || !role) {
    req.flash('error', 'All fields are required.');
    return res.redirect('/users/new');
  }
  try {
    const hash = require('bcrypt').hashSync(password, 12);
    db.prepare('INSERT INTO user (full_name, email, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(full_name.trim(), email.trim().toLowerCase(), hash, role);
    req.flash('success', `${full_name} added successfully.`);
    res.redirect('/users');
  } catch (err) {
    console.error(err);
    req.flash('error', err.message.includes('UNIQUE') ? 'That email is already registered.' : 'Could not create user.');
    res.redirect('/users/new');
  }
});

app.post('/users/:id/toggle', requireAuth, requireRole('admin'), (req, res) => {
  const target = db.prepare('SELECT * FROM user WHERE id = ?').get(req.params.id);
  if (!target) return res.redirect('/users');
  if (target.id === req.session.user.id) {
    req.flash('error', 'You cannot deactivate your own account.');
    return res.redirect('/users');
  }
  db.prepare('UPDATE user SET is_active = ? WHERE id = ?').run(target.is_active ? 0 : 1, target.id);
  req.flash('success', `${target.full_name} has been ${target.is_active ? 'deactivated' : 'activated'}.`);
  res.redirect('/users');
});

// ── Language toggle ───────────────────────────────────────────────────────────

app.post('/lang', (req, res) => {
  const current = req.session.lang || 'en';
  req.session.lang = current === 'en' ? 'ar' : 'en';
  req.session.save(() => {
    res.redirect(req.get('Referer') || '/');
  });
});

// ── 404 ───────────────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).render('error', { user: req.session.user || null, message: 'Page not found.' });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\nTahfiz Management System`);
  console.log(`Running at http://localhost:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}\n`);
});
