require('dotenv').config();
const db = require('./database');
const bcrypt = require('bcrypt');
const fs = require('fs');
const path = require('path');

console.log('Running seed...');

// ── Schema ──────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS surah (
    id         INTEGER PRIMARY KEY,
    number     INTEGER NOT NULL UNIQUE,
    name_ar    TEXT    NOT NULL,
    name_en    TEXT    NOT NULL,
    ayah_count INTEGER NOT NULL,
    juz_start  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name     TEXT    NOT NULL,
    email         TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL CHECK (role IN ('admin', 'teacher', 'secretary')),
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS student (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name           TEXT    NOT NULL,
    date_of_birth       TEXT,
    phone               TEXT,
    guardian_name       TEXT,
    guardian_phone      TEXT,
    registration_date   TEXT    NOT NULL DEFAULT (date('now')),
    assigned_teacher_id INTEGER NOT NULL REFERENCES user(id),
    entry_level         TEXT    NOT NULL CHECK (entry_level IN ('qaida', 'quran')),
    qaida_level         TEXT,
    entry_surah_id      INTEGER REFERENCES surah(id),
    entry_ayah          INTEGER,
    status              TEXT    NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active', 'inactive', 'completed')),
    notes               TEXT,
    created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS session_log (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id       INTEGER NOT NULL REFERENCES student(id),
    teacher_id       INTEGER NOT NULL REFERENCES user(id),
    session_date     TEXT    NOT NULL DEFAULT (date('now')),
    type             TEXT    NOT NULL CHECK (type IN ('hifz', 'muraja')),
    from_surah_id    INTEGER REFERENCES surah(id),
    from_ayah        INTEGER,
    to_surah_id      INTEGER REFERENCES surah(id),
    to_ayah          INTEGER,
    qaida_from       TEXT,
    qaida_to         TEXT,
    recitation_grade TEXT    NOT NULL
                     CHECK (recitation_grade IN ('excellent', 'good', 'needs_work', 'repeat')),
    notes            TEXT,
    created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS payment (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id    INTEGER NOT NULL REFERENCES student(id),
    recorded_by   INTEGER NOT NULL REFERENCES user(id),
    month         INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
    year          INTEGER NOT NULL,
    amount_due    REAL    NOT NULL DEFAULT 0,
    amount_paid   REAL    NOT NULL DEFAULT 0,
    paid_date     TEXT,
    status        TEXT    NOT NULL DEFAULT 'unpaid'
                          CHECK (status IN ('unpaid', 'partial', 'paid')),
    notes         TEXT,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE (student_id, month, year)
  );

  CREATE INDEX IF NOT EXISTS idx_student_teacher  ON student(assigned_teacher_id);
  CREATE INDEX IF NOT EXISTS idx_session_student  ON session_log(student_id, session_date DESC);
  CREATE INDEX IF NOT EXISTS idx_session_teacher  ON session_log(teacher_id, session_date DESC);
  CREATE INDEX IF NOT EXISTS idx_payment_student  ON payment(student_id, year DESC, month DESC);
  CREATE INDEX IF NOT EXISTS idx_payment_status   ON payment(status);

  CREATE VIEW IF NOT EXISTS v_student_progress AS
  SELECT
    s.id              AS student_id,
    s.full_name       AS student_name,
    s.entry_level,
    s.status,
    u.full_name       AS teacher_name,
    sl.session_date   AS last_session_date,
    sl.type           AS last_session_type,
    sr.name_en        AS current_surah,
    sl.to_ayah        AS current_ayah,
    sl.recitation_grade AS last_grade
  FROM student s
  LEFT JOIN user u ON u.id = s.assigned_teacher_id
  LEFT JOIN session_log sl
    ON sl.id = (
      SELECT id FROM session_log
      WHERE student_id = s.id
      ORDER BY session_date DESC, id DESC
      LIMIT 1
    )
  LEFT JOIN surah sr ON sr.id = sl.to_surah_id;

  CREATE VIEW IF NOT EXISTS v_payment_summary AS
  SELECT
    s.id            AS student_id,
    s.full_name     AS student_name,
    p.month,
    p.year,
    p.amount_due,
    p.amount_paid,
    (p.amount_due - p.amount_paid) AS balance,
    p.status,
    p.paid_date
  FROM payment p
  JOIN student s ON s.id = p.student_id
  WHERE p.status != 'paid'
  ORDER BY p.year DESC, p.month DESC, balance DESC;
`);

// ── Surahs ───────────────────────────────────────────────────────────────────

const surahs = [
  [1,'الفاتحة','Al-Fatihah',7,1],[2,'البقرة','Al-Baqarah',286,1],
  [3,'آل عمران','Ali Imran',200,3],[4,'النساء','An-Nisa',176,4],
  [5,'المائدة','Al-Maidah',120,6],[6,'الأنعام','Al-Anam',165,7],
  [7,'الأعراف','Al-Araf',206,8],[8,'الأنفال','Al-Anfal',75,9],
  [9,'التوبة','At-Tawbah',129,10],[10,'يونس','Yunus',109,11],
  [11,'هود','Hud',123,11],[12,'يوسف','Yusuf',111,12],
  [13,'الرعد','Ar-Rad',43,13],[14,'إبراهيم','Ibrahim',52,13],
  [15,'الحجر','Al-Hijr',99,14],[16,'النحل','An-Nahl',128,14],
  [17,'الإسراء','Al-Isra',111,15],[18,'الكهف','Al-Kahf',110,15],
  [19,'مريم','Maryam',98,16],[20,'طه','Ta-Ha',135,16],
  [21,'الأنبياء','Al-Anbiya',112,17],[22,'الحج','Al-Hajj',78,17],
  [23,'المؤمنون','Al-Muminun',118,18],[24,'النور','An-Nur',64,18],
  [25,'الفرقان','Al-Furqan',77,18],[26,'الشعراء','Ash-Shuara',227,19],
  [27,'النمل','An-Naml',93,19],[28,'القصص','Al-Qasas',88,20],
  [29,'العنكبوت','Al-Ankabut',69,20],[30,'الروم','Ar-Rum',60,21],
  [31,'لقمان','Luqman',34,21],[32,'السجدة','As-Sajdah',30,21],
  [33,'الأحزاب','Al-Ahzab',73,21],[34,'سبأ','Saba',54,22],
  [35,'فاطر','Fatir',45,22],[36,'يس','Ya-Sin',83,22],
  [37,'الصافات','As-Saffat',182,23],[38,'ص','Sad',88,23],
  [39,'الزمر','Az-Zumar',75,23],[40,'غافر','Ghafir',85,24],
  [41,'فصلت','Fussilat',54,24],[42,'الشورى','Ash-Shura',53,25],
  [43,'الزخرف','Az-Zukhruf',89,25],[44,'الدخان','Ad-Dukhan',59,25],
  [45,'الجاثية','Al-Jathiyah',37,25],[46,'الأحقاف','Al-Ahqaf',35,26],
  [47,'محمد','Muhammad',38,26],[48,'الفتح','Al-Fath',29,26],
  [49,'الحجرات','Al-Hujurat',18,26],[50,'ق','Qaf',45,26],
  [51,'الذاريات','Adh-Dhariyat',60,26],[52,'الطور','At-Tur',49,27],
  [53,'النجم','An-Najm',62,27],[54,'القمر','Al-Qamar',55,27],
  [55,'الرحمن','Ar-Rahman',78,27],[56,'الواقعة','Al-Waqiah',96,27],
  [57,'الحديد','Al-Hadid',29,27],[58,'المجادلة','Al-Mujadila',22,28],
  [59,'الحشر','Al-Hashr',24,28],[60,'الممتحنة','Al-Mumtahanah',13,28],
  [61,'الصف','As-Saf',14,28],[62,'الجمعة','Al-Jumuah',11,28],
  [63,'المنافقون','Al-Munafiqun',11,28],[64,'التغابن','At-Taghabun',18,28],
  [65,'الطلاق','At-Talaq',12,28],[66,'التحريم','At-Tahrim',12,28],
  [67,'الملك','Al-Mulk',30,29],[68,'القلم','Al-Qalam',52,29],
  [69,'الحاقة','Al-Haqqah',52,29],[70,'المعارج','Al-Maarij',44,29],
  [71,'نوح','Nuh',28,29],[72,'الجن','Al-Jinn',28,29],
  [73,'المزمل','Al-Muzzammil',20,29],[74,'المدثر','Al-Muddaththir',56,29],
  [75,'القيامة','Al-Qiyamah',40,29],[76,'الإنسان','Al-Insan',31,29],
  [77,'المرسلات','Al-Mursalat',50,29],[78,'النبأ','An-Naba',40,30],
  [79,'النازعات','An-Naziat',46,30],[80,'عبس','Abasa',42,30],
  [81,'التكوير','At-Takwir',29,30],[82,'الإنفطار','Al-Infitar',19,30],
  [83,'المطففين','Al-Mutaffifin',36,30],[84,'الإنشقاق','Al-Inshiqaq',25,30],
  [85,'البروج','Al-Buruj',22,30],[86,'الطارق','At-Tariq',17,30],
  [87,'الأعلى','Al-Ala',19,30],[88,'الغاشية','Al-Ghashiyah',26,30],
  [89,'الفجر','Al-Fajr',30,30],[90,'البلد','Al-Balad',20,30],
  [91,'الشمس','Ash-Shams',15,30],[92,'الليل','Al-Layl',21,30],
  [93,'الضحى','Ad-Duha',11,30],[94,'الشرح','Ash-Sharh',8,30],
  [95,'التين','At-Tin',8,30],[96,'العلق','Al-Alaq',19,30],
  [97,'القدر','Al-Qadr',5,30],[98,'البينة','Al-Bayyinah',8,30],
  [99,'الزلزلة','Az-Zalzalah',8,30],[100,'العاديات','Al-Adiyat',11,30],
  [101,'القارعة','Al-Qariah',11,30],[102,'التكاثر','At-Takathur',8,30],
  [103,'العصر','Al-Asr',3,30],[104,'الهمزة','Al-Humazah',9,30],
  [105,'الفيل','Al-Fil',5,30],[106,'قريش','Quraysh',4,30],
  [107,'الماعون','Al-Maun',7,30],[108,'الكوثر','Al-Kawthar',3,30],
  [109,'الكافرون','Al-Kafirun',6,30],[110,'النصر','An-Nasr',3,30],
  [111,'المسد','Al-Masad',5,30],[112,'الإخلاص','Al-Ikhlas',4,30],
  [113,'الفلق','Al-Falaq',5,30],[114,'الناس','An-Nas',6,30]
];

const insertSurah = db.prepare(
  'INSERT OR IGNORE INTO surah (number, name_ar, name_en, ayah_count, juz_start) VALUES (?, ?, ?, ?, ?)'
);
const insertManySurahs = db.transaction((rows) => {
  for (const row of rows) insertSurah.run(...row);
});
insertManySurahs(surahs);
console.log('✓ Surahs seeded');

// ── Default admin ────────────────────────────────────────────────────────────

const existingAdmin = db.prepare("SELECT id FROM user WHERE email = ?").get('admin@tahfiz.gm');
if (!existingAdmin) {
  const hash = bcrypt.hashSync('admin1234', 12);
  db.prepare(
    "INSERT INTO user (full_name, email, password_hash, role) VALUES (?, ?, ?, ?)"
  ).run('Administrator', 'admin@tahfiz.gm', hash, 'admin');
  console.log('✓ Default admin created');
  console.log('  Email:    admin@tahfiz.gm');
  console.log('  Password: admin1234');
  console.log('  ⚠️  Change this password immediately after first login.');
} else {
  console.log('✓ Admin already exists, skipping');
}

// ── Sessions dir ─────────────────────────────────────────────────────────────

const sessDir = path.resolve(process.env.SESSION_DIR || './sessions');
if (!fs.existsSync(sessDir)) {
  fs.mkdirSync(sessDir, { recursive: true });
  console.log('✓ Sessions directory created');
}

console.log('\nDatabase ready at', db.name);
process.exit(0);
