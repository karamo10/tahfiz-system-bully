const express = require('express');
const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const router = express.Router();

const MONTHS = [
  '', 'January','February','March','April','May','June',
  'July','August','September','October','November','December'
];

// ── GET /payments ─────────────────────────────────────────────────────────────

router.get('/', requireAuth, requireRole('admin', 'secretary'), (req, res) => {
  try {
    const now = new Date();
    const year  = parseInt(req.query.year  || now.getFullYear());
    const month = parseInt(req.query.month || (now.getMonth() + 1));

    const payments = db.prepare(`
      SELECT p.*, s.full_name AS student_name, u.full_name AS teacher_name
      FROM payment p
      JOIN student s ON s.id = p.student_id
      JOIN user u ON u.id = s.assigned_teacher_id
      WHERE p.year = ? AND p.month = ?
      ORDER BY p.status, s.full_name
    `).all(year, month);

    // Students with no payment record this month
    const allActive = db.prepare("SELECT id, full_name FROM student WHERE status = 'active' ORDER BY full_name").all();
    const paidIds = new Set(payments.map(p => p.student_id));
    const noRecord = allActive.filter(s => !paidIds.has(s.id));

    const totals = {
      due:  payments.reduce((sum, p) => sum + p.amount_due,  0),
      paid: payments.reduce((sum, p) => sum + p.amount_paid, 0)
    };
    totals.outstanding = totals.due - totals.paid;

    res.render('payments/overview', {
      user: req.session.user,
      payments,
      noRecord,
      totals,
      months: MONTHS,
      selectedMonth: month,
      selectedYear: year,
      error: req.flash('error'),
      success: req.flash('success')
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { user: req.session.user, message: 'Could not load payments.' });
  }
});

// ── GET /payments/entry ───────────────────────────────────────────────────────

router.get('/entry', requireAuth, requireRole('admin', 'secretary'), (req, res) => {
  try {
    const students = db.prepare(
      "SELECT id, full_name FROM student WHERE status = 'active' ORDER BY full_name"
    ).all();

    const now = new Date();
    const preselect = req.query.student_id || null;

    res.render('payments/entry', {
      user: req.session.user,
      students,
      months: MONTHS,
      currentMonth: now.getMonth() + 1,
      currentYear: now.getFullYear(),
      preselect,
      existing: null,
      error: req.flash('error'),
      success: req.flash('success')
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { user: req.session.user, message: 'Could not load payment form.' });
  }
});

// ── GET /payments/lookup — AJAX: get existing record for student+month+year ───

router.get('/lookup', requireAuth, requireRole('admin', 'secretary'), (req, res) => {
  const { student_id, month, year } = req.query;
  if (!student_id || !month || !year) return res.json(null);
  const record = db.prepare(
    'SELECT * FROM payment WHERE student_id = ? AND month = ? AND year = ?'
  ).get(parseInt(student_id), parseInt(month), parseInt(year));
  res.json(record || null);
});

// ── POST /payments/entry ──────────────────────────────────────────────────────

router.post('/entry', requireAuth, requireRole('admin', 'secretary'), (req, res) => {
  const { student_id, month, year, amount_due, amount_paid, paid_date, notes } = req.body;

  if (!student_id || !month || !year || amount_due === undefined) {
    req.flash('error', 'Student, month, year, and amount due are required.');
    return res.redirect('/payments/entry');
  }

  try {
    const due  = parseFloat(amount_due)  || 0;
    const paid = parseFloat(amount_paid) || 0;
    const status = paid >= due ? 'paid' : paid > 0 ? 'partial' : 'unpaid';

    db.prepare(`
      INSERT INTO payment (student_id, recorded_by, month, year, amount_due, amount_paid, paid_date, status, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(student_id, month, year) DO UPDATE SET
        amount_due  = excluded.amount_due,
        amount_paid = excluded.amount_paid,
        paid_date   = excluded.paid_date,
        status      = excluded.status,
        recorded_by = excluded.recorded_by,
        notes       = excluded.notes
    `).run(
      parseInt(student_id),
      req.session.user.id,
      parseInt(month),
      parseInt(year),
      due,
      paid,
      paid_date || null,
      status,
      notes || null
    );

    const student = db.prepare('SELECT full_name FROM student WHERE id = ?').get(student_id);
    req.flash('success', `Payment recorded for ${student.full_name} — ${MONTHS[parseInt(month)]} ${year}.`);
    res.redirect(`/payments?month=${month}&year=${year}`);
  } catch (err) {
    console.error(err);
    req.flash('error', 'Could not save payment. Please try again.');
    res.redirect('/payments/entry');
  }
});

// ── GET /payments/:studentId ──────────────────────────────────────────────────

router.get('/:studentId', requireAuth, requireRole('admin', 'secretary'), (req, res) => {
  try {
    const student = db.prepare('SELECT * FROM student WHERE id = ?').get(req.params.studentId);
    if (!student) return res.status(404).render('error', { user: req.session.user, message: 'Student not found.' });

    const payments = db.prepare(`
      SELECT p.*, u.full_name AS recorded_by_name
      FROM payment p
      JOIN user u ON u.id = p.recorded_by
      WHERE p.student_id = ?
      ORDER BY p.year DESC, p.month DESC
    `).all(student.id);

    const totals = {
      due:  payments.reduce((sum, p) => sum + p.amount_due,  0),
      paid: payments.reduce((sum, p) => sum + p.amount_paid, 0)
    };
    totals.outstanding = totals.due - totals.paid;

    res.render('payments/student', {
      user: req.session.user,
      student,
      payments,
      totals,
      months: MONTHS
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { user: req.session.user, message: 'Could not load payment history.' });
  }
});

module.exports = router;
