const express = require('express');
const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const router = express.Router();

// ── GET /sessions/log ─────────────────────────────────────────────────────────

router.get('/log', requireAuth, requireRole('admin', 'teacher'), (req, res) => {
  try {
    const { user } = req.session;
    let students;

    if (user.role === 'teacher') {
      students = db.prepare(
        "SELECT id, full_name, entry_level FROM student WHERE assigned_teacher_id = ? AND status = 'active' ORDER BY full_name"
      ).all(user.id);
    } else {
      students = db.prepare(
        "SELECT id, full_name, entry_level FROM student WHERE status = 'active' ORDER BY full_name"
      ).all();
    }

    const surahs = db.prepare('SELECT * FROM surah ORDER BY number').all();
    const selectedStudentId = req.query.student_id || null;

    let selectedStudent = null;
    let lastSession = null;
    if (selectedStudentId) {
      selectedStudent = db.prepare('SELECT * FROM student WHERE id = ?').get(selectedStudentId);
      lastSession = db.prepare(`
        SELECT sl.*, fs.name_en AS from_surah_name, ts.name_en AS to_surah_name
        FROM session_log sl
        LEFT JOIN surah fs ON fs.id = sl.from_surah_id
        LEFT JOIN surah ts ON ts.id = sl.to_surah_id
        WHERE sl.student_id = ?
        ORDER BY sl.session_date DESC, sl.id DESC
        LIMIT 1
      `).get(selectedStudentId);
    }

    res.render('sessions/log', {
      user,
      students,
      surahs,
      selectedStudent,
      lastSession,
      today: new Date().toISOString().split('T')[0],
      error: req.flash('error'),
      success: req.flash('success')
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { user: req.session.user, message: 'Could not load session form.' });
  }
});

// ── POST /sessions/log ────────────────────────────────────────────────────────

router.post('/log', requireAuth, requireRole('admin', 'teacher'), (req, res) => {
  const {
    student_id, session_date, type,
    from_surah_id, from_ayah, to_surah_id, to_ayah,
    qaida_from, qaida_to, recitation_grade, notes
  } = req.body;

  if (!student_id || !session_date || !type || !recitation_grade) {
    req.flash('error', 'Student, date, session type, and grade are required.');
    return res.redirect('/sessions/log');
  }

  try {
    const { user } = req.session;

    // If teacher, verify student belongs to them
    if (user.role === 'teacher') {
      const student = db.prepare('SELECT assigned_teacher_id FROM student WHERE id = ?').get(student_id);
      if (!student || student.assigned_teacher_id !== user.id) {
        req.flash('error', 'You can only log sessions for your own students.');
        return res.redirect('/sessions/log');
      }
    }

    const student = db.prepare('SELECT entry_level, full_name FROM student WHERE id = ?').get(student_id);

    db.prepare(`
      INSERT INTO session_log
        (student_id, teacher_id, session_date, type,
         from_surah_id, from_ayah, to_surah_id, to_ayah,
         qaida_from, qaida_to, recitation_grade, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      parseInt(student_id),
      user.id,
      session_date,
      type,
      student.entry_level === 'quran' ? (from_surah_id || null) : null,
      student.entry_level === 'quran' ? (from_ayah || null) : null,
      student.entry_level === 'quran' ? (to_surah_id || null) : null,
      student.entry_level === 'quran' ? (to_ayah || null) : null,
      student.entry_level === 'qaida' ? (qaida_from || null) : null,
      student.entry_level === 'qaida' ? (qaida_to || null) : null,
      recitation_grade,
      notes || null
    );

    req.flash('success', `Session logged for ${student.full_name}.`);
    res.redirect(`/sessions/log?student_id=${student_id}`);
  } catch (err) {
    console.error(err);
    req.flash('error', 'Could not save session. Please try again.');
    res.redirect('/sessions/log');
  }
});

// ── GET /sessions/:studentId ──────────────────────────────────────────────────

router.get('/:studentId', requireAuth, (req, res) => {
  try {
    const { user } = req.session;
    const student = db.prepare(`
      SELECT s.*, u.full_name AS teacher_name
      FROM student s JOIN user u ON u.id = s.assigned_teacher_id
      WHERE s.id = ?
    `).get(req.params.studentId);

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
    `).all(student.id);

    res.render('sessions/history', { user, student, sessions });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { user: req.session.user, message: 'Could not load session history.' });
  }
});

module.exports = router;
