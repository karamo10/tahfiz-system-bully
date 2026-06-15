const express = require('express');
const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const router = express.Router();

// ── Helpers ──────────────────────────────────────────────────────────────────

function getAllSurahs() {
  return db.prepare('SELECT * FROM surah ORDER BY number').all();
}

function getAllTeachers() {
  return db.prepare("SELECT id, full_name FROM user WHERE role = 'teacher' AND is_active = 1 ORDER BY full_name").all();
}

// ── GET /students ─────────────────────────────────────────────────────────────

router.get('/', requireAuth, (req, res) => {
  try {
    const { user } = req.session;
    let students;

    if (user.role === 'teacher') {
      students = db.prepare(`
        SELECT s.*, u.full_name AS teacher_name
        FROM student s
        JOIN user u ON u.id = s.assigned_teacher_id
        WHERE s.assigned_teacher_id = ?
        ORDER BY s.full_name
      `).all(user.id);
    } else {
      students = db.prepare(`
        SELECT s.*, u.full_name AS teacher_name
        FROM student s
        JOIN user u ON u.id = s.assigned_teacher_id
        ORDER BY s.full_name
      `).all();
    }

    res.render('students/list', {
      user,
      students,
      error: req.flash('error'),
      success: req.flash('success')
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { user: req.session.user, message: 'Could not load students.' });
  }
});

// ── GET /students/register ────────────────────────────────────────────────────

router.get('/register', requireAuth, requireRole('admin', 'secretary'), (req, res) => {
  res.render('students/register', {
    user: req.session.user,
    teachers: getAllTeachers(),
    surahs: getAllSurahs(),
    error: req.flash('error'),
    success: req.flash('success')
  });
});

// ── POST /students/register ───────────────────────────────────────────────────

router.post('/register', requireAuth, requireRole('admin', 'secretary'), (req, res) => {
  const {
    full_name, date_of_birth, phone,
    guardian_name, guardian_phone,
    assigned_teacher_id, entry_level,
    qaida_level, entry_surah_id, entry_ayah, notes
  } = req.body;

  if (!full_name || !assigned_teacher_id || !entry_level) {
    req.flash('error', 'Full name, teacher, and entry level are required.');
    return res.redirect('/students/register');
  }

  try {
    db.prepare(`
      INSERT INTO student
        (full_name, date_of_birth, phone, guardian_name, guardian_phone,
         assigned_teacher_id, entry_level, qaida_level,
         entry_surah_id, entry_ayah, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      full_name.trim(),
      date_of_birth || null,
      phone || null,
      guardian_name || null,
      guardian_phone || null,
      parseInt(assigned_teacher_id),
      entry_level,
      entry_level === 'qaida' ? (qaida_level || 'qaida_1') : null,
      entry_level === 'quran' ? (entry_surah_id || null) : null,
      entry_level === 'quran' ? (entry_ayah || null) : null,
      notes || null
    );

    req.flash('success', `${full_name} has been registered successfully.`);
    res.redirect('/students');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Could not register student. Please try again.');
    res.redirect('/students/register');
  }
});

// ── GET /students/:id ─────────────────────────────────────────────────────────

router.get('/:id', requireAuth, (req, res) => {
  try {
    const { user } = req.session;
    const student = db.prepare(`
      SELECT s.*, u.full_name AS teacher_name,
             sr.name_en AS entry_surah_name, sr.name_ar AS entry_surah_ar
      FROM student s
      JOIN user u ON u.id = s.assigned_teacher_id
      LEFT JOIN surah sr ON sr.id = s.entry_surah_id
      WHERE s.id = ?
    `).get(req.params.id);

    if (!student) return res.status(404).render('error', { user, message: 'Student not found.' });

    if (user.role === 'teacher' && student.assigned_teacher_id !== user.id) {
      return res.status(403).render('error', { user, message: 'Access denied.' });
    }

    const sessions = db.prepare(`
      SELECT sl.*,
             fs.name_en AS from_surah_name, fs.name_ar AS from_surah_ar,
             ts.name_en AS to_surah_name,   ts.name_ar AS to_surah_ar,
             u.full_name AS teacher_name
      FROM session_log sl
      LEFT JOIN surah fs ON fs.id = sl.from_surah_id
      LEFT JOIN surah ts ON ts.id = sl.to_surah_id
      JOIN user u ON u.id = sl.teacher_id
      WHERE sl.student_id = ?
      ORDER BY sl.session_date DESC, sl.id DESC
      LIMIT 50
    `).all(student.id);

    const payments = db.prepare(`
      SELECT p.*, u.full_name AS recorded_by_name
      FROM payment p
      JOIN user u ON u.id = p.recorded_by
      WHERE p.student_id = ?
      ORDER BY p.year DESC, p.month DESC
    `).all(student.id);

    res.render('students/detail', {
      user,
      student,
      sessions,
      payments,
      error: req.flash('error'),
      success: req.flash('success')
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { user: req.session.user, message: 'Could not load student.' });
  }
});

// ── GET /students/:id/edit ────────────────────────────────────────────────────

router.get('/:id/edit', requireAuth, requireRole('admin', 'secretary'), (req, res) => {
  try {
    const student = db.prepare('SELECT * FROM student WHERE id = ?').get(req.params.id);
    if (!student) return res.status(404).render('error', { user: req.session.user, message: 'Student not found.' });

    res.render('students/edit', {
      user: req.session.user,
      student,
      teachers: getAllTeachers(),
      surahs: getAllSurahs(),
      error: req.flash('error'),
      success: req.flash('success')
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { user: req.session.user, message: 'Could not load student.' });
  }
});

// ── POST /students/:id/edit ───────────────────────────────────────────────────

router.post('/:id/edit', requireAuth, requireRole('admin', 'secretary'), (req, res) => {
  const {
    full_name, date_of_birth, phone,
    guardian_name, guardian_phone,
    assigned_teacher_id, status, notes
  } = req.body;

  if (!full_name) {
    req.flash('error', 'Full name is required.');
    return res.redirect(`/students/${req.params.id}/edit`);
  }

  try {
    db.prepare(`
      UPDATE student SET
        full_name = ?, date_of_birth = ?, phone = ?,
        guardian_name = ?, guardian_phone = ?,
        assigned_teacher_id = ?, status = ?, notes = ?
      WHERE id = ?
    `).run(
      full_name.trim(),
      date_of_birth || null,
      phone || null,
      guardian_name || null,
      guardian_phone || null,
      parseInt(assigned_teacher_id),
      status,
      notes || null,
      req.params.id
    );

    req.flash('success', 'Student updated successfully.');
    res.redirect(`/students/${req.params.id}`);
  } catch (err) {
    console.error(err);
    req.flash('error', 'Could not update student.');
    res.redirect(`/students/${req.params.id}/edit`);
  }
});

module.exports = router;
