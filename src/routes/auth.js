const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../db/database');
const router = express.Router();

// GET /login
router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('auth/login', {
    user: null,
    error: req.flash('error'),
    success: req.flash('success')
  });
});

// POST /login
router.post('/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    req.flash('error', 'Email and password are required.');
    return res.redirect('/login');
  }

  try {
    const staff = db.prepare(
      'SELECT * FROM user WHERE email = ? AND is_active = 1'
    ).get(email.trim().toLowerCase());

    if (!staff || !bcrypt.compareSync(password, staff.password_hash)) {
      req.flash('error', 'Invalid email or password.');
      return res.redirect('/login');
    }

    req.session.user = {
      id:        staff.id,
      full_name: staff.full_name,
      email:     staff.email,
      role:      staff.role
    };

    res.redirect('/');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Something went wrong. Please try again.');
    res.redirect('/login');
  }
});

// POST /logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
