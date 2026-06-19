const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const http = require('http');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 5000;

// Get frontend URL from environment variable
const frontendUrl = process.env.FRONTEND_URL || 'https://laborconnect-production.up.railway.app';

// ========== CORS ==========
app.use(cors({
    origin: true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'user-id']
}));

app.options('*', cors());

const io = new Server(server, {
    cors: {
        origin: true,
        credentials: true,
        methods: ['GET', 'POST']
    }
});

console.log('✅ CORS configured to allow all origins for testing');

// Increase payload limit
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}
app.use('/uploads', express.static(uploadDir));
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ========== FILE VALIDATION ==========
const allowedImageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const allowedVideoTypes = ['video/mp4', 'video/webm', 'video/quicktime'];
const allowedMimeTypes = [...allowedImageTypes, ...allowedVideoTypes];

const fileFilter = (req, file, cb) => {
    if (allowedMimeTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type'), false);
    }
};

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const safeName = `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
        cb(null, safeName);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: fileFilter
});

// ========== DATABASE CONNECTION ==========
const databaseUrl = process.env.DATABASE_URL;

let poolConfig;
if (databaseUrl) {
    poolConfig = {
        connectionString: databaseUrl,
        ssl: { rejectUnauthorized: false }
    };
    console.log('✅ Using DATABASE_URL for database connection');
} else {
    poolConfig = {
        user: process.env.DB_USER,
        host: process.env.DB_HOST,
        database: process.env.DB_NAME,
        password: process.env.DB_PASS,
        port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
        ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
    };
    console.log('✅ Using individual DB variables for database connection');
}

const pool = new Pool(poolConfig);

// ========== EMAIL CONFIGURATION - MAILJET API ==========
const Mailjet = require('node-mailjet');

const mailjet = Mailjet.apiConnect(
    process.env.MAILJET_API_KEY,
    process.env.MAILJET_SECRET_KEY
);

// ========== EMAIL QUEUE ==========
const emailQueue = [];
let activeProcesses = 0;
const MAX_CONCURRENT = 5;

async function processEmailQueue() {
    if (emailQueue.length === 0) return;
    if (activeProcesses >= MAX_CONCURRENT) return;

    const { to, subject, html, resolve, reject } = emailQueue.shift();
    activeProcesses++;

    try {
        const request = await mailjet.post('send', { version: 'v3.1' }).request({
            Messages: [{
                From: {
                    Email: 'noreply@laborconnect-production.up.railway.app',
                    Name: 'LaborConnect'
                },
                To: [{
                    Email: to
                }],
                Subject: subject,
                HTMLPart: html
            }]
        });
        console.log(`✅ Email sent to: ${to}`);
        resolve();
    } catch (err) {
        console.error(`❌ Email failed to: ${to}`, err.message);
        reject(err);
    } finally {
        activeProcesses--;
        processEmailQueue();
    }
}

for (let i = 0; i < MAX_CONCURRENT; i++) {
    setInterval(() => processEmailQueue(), 100);
}

function queueEmail(to, subject, html) {
    return new Promise((resolve, reject) => {
        emailQueue.push({ to, subject, html, resolve, reject });
        processEmailQueue();
    });
}

async function sendPasswordResetEmail(email, token) {
    const baseUrl = process.env.BASE_URL || 'http://localhost:5000';
    const url = `${baseUrl}/api/reset-password/${token}`;

    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 500px;">
            <h2 style="color: #0d6efd;">LaborConnect</h2>
            <h3>Password Reset Request</h3>
            <p>Click below to reset your password:</p>
            <a href="${url}" style="background:#dc3545;color:white;padding:12px 24px;text-decoration:none;border-radius:8px">Reset Password</a>
            <p>Link expires in 15 minutes.</p>
            <hr>
            <small>LaborConnect</small>
        </div>
    `;

    await queueEmail(email, 'LaborConnect - Reset Your Password', html);
}

pool.connect()
    .then(() => console.log('✅ PostgreSQL connected'))
    .catch(err => console.error('❌ DB error:', err));

const createTables = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                firstName VARCHAR(100),
                lastName VARCHAR(100),
                username VARCHAR(100) UNIQUE,
                gender VARCHAR(20),
                name VARCHAR(200),
                email VARCHAR(200) UNIQUE,
                password VARCHAR(255),
                phone VARCHAR(50),
                userType VARCHAR(50),
                trade VARCHAR(100),
                photoURL TEXT,
                gallery JSONB DEFAULT '[]'::JSONB,
                is_verified BOOLEAN DEFAULT false,
                verification_token VARCHAR(255),
                token_expires TIMESTAMP,
                reset_token VARCHAR(255),
                reset_token_expiry TIMESTAMP,
                created_at TIMESTAMP DEFAULT NOW(),
                is_admin BOOLEAN DEFAULT false,
                is_suspended BOOLEAN DEFAULT false,
                suspension_reason TEXT,
                flagged_at TIMESTAMP
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS jobs (
                id SERIAL PRIMARY KEY,
                title VARCHAR(200),
                trade VARCHAR(100),
                description TEXT,
                location VARCHAR(200),
                postedBy VARCHAR(100),
                posterName VARCHAR(200),
                time TIMESTAMP DEFAULT NOW()
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                chatId VARCHAR(100),
                fromUser VARCHAR(100),
                toUser VARCHAR(100),
                text TEXT,
                type VARCHAR(50) DEFAULT 'text',
                payload TEXT,
                replyTo INTEGER,
                time TIMESTAMP DEFAULT NOW()
            )
        `);

        await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_for TEXT`);
        await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS read BOOLEAN DEFAULT false`);
        await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS replyTo INTEGER`);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS calls (
                id SERIAL PRIMARY KEY,
                caller_id VARCHAR(100) NOT NULL,
                receiver_id VARCHAR(100) NOT NULL,
                call_type VARCHAR(20) NOT NULL,
                call_status VARCHAR(20) NOT NULL,
                duration INTEGER DEFAULT 0,
                started_at TIMESTAMP DEFAULT NOW(),
                ended_at TIMESTAMP,
                chat_id VARCHAR(100)
            )
        `);

        console.log('✅ Tables ready');
    } catch (err) {
        console.error('Table error:', err);
    }
};
createTables();

// ========== REGISTER ==========
app.post('/api/register', async (req, res) => {
    try {
        const { firstName, lastName, username, gender, email, password, phone, userType, trade, photoURL } = req.body;

        const check = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (check.rows.length > 0) {
            return res.status(400).json({ message: 'Email already exists' });
        }

        const hashed = await bcrypt.hash(password, 8);
        const fullName = `${firstName} ${lastName}`;
        const verifyCode = Math.floor(100000 + Math.random() * 900000).toString();
        const codeExpire = new Date(Date.now() + 24 * 60 * 60 * 1000);

        await pool.query(`
            INSERT INTO users(firstName, lastName, username, gender, name, email, password, phone, userType, trade, photoURL, verification_token, token_expires, is_verified)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        `, [firstName, lastName, username, gender, fullName, email, hashed, phone, userType, trade, photoURL, verifyCode, codeExpire, false]);

        const verificationHtml = `
            <div style="font-family: Arial, sans-serif; max-width: 500px;">
                <h2 style="color: #0d6efd;">Welcome to LaborConnect!</h2>
                <p>Your verification code is: <strong>${verifyCode}</strong></p>
                <p>This code expires in 24 hours.</p>
            </div>
        `;

        queueEmail(email, 'LaborConnect - Your Verification Code', verificationHtml);

        res.json({ success: true, message: 'Registered! Check your email for verification code.' });

    } catch (err) {
        console.error('Register Error:', err);
        res.status(500).json({ message: 'Registration failed: ' + err.message });
    }
});

// ========== LOGIN ==========
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);

        if (result.rows.length === 0) {
            return res.status(400).json({ message: 'Account does not exist' });
        }

        const user = result.rows[0];
        const match = await bcrypt.compare(password, user.password);

        if (!match) {
            return res.status(400).json({ message: 'Incorrect email or password' });
        }

        if (!user.is_verified) {
            return res.status(400).json({
                message: 'Please verify your account first'
            });
        }

        res.json({
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                userType: user.userType
            }
        });

    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// ========== VERIFY CODE ==========
app.post('/api/verify-code', async (req, res) => {
    try {
        const { email, code } = req.body;
        const result = await pool.query(
            'SELECT * FROM users WHERE email = $1 AND verification_token = $2 AND token_expires > NOW()',
            [email, code]
        );

        if (result.rows.length === 0) return res.status(400).json({ message: 'Invalid or expired code' });

        await pool.query(
            'UPDATE users SET is_verified = true, verification_token = null, token_expires = null WHERE email = $1',
            [email]
        );

        res.json({
            success: true,
            message: 'Verified!',
            user: result.rows[0]
        });
    } catch (err) {
        console.error('Verify code error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// ========== GET ALL USERS ==========
app.get('/api/users', async (req, res) => {
    try {
        const { type } = req.query;
        let query = 'SELECT id, name, email, userType, trade, phone, photoURL FROM users';
        let params = [];

        if (type) {
            query += ' WHERE userType = $1';
            params.push(type);
        }

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json([]);
    }
});

// ========== GET USER BY ID ==========
app.get('/api/user/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
        res.json(result.rows[0] || null);
    } catch (err) {
        console.error('Get user error:', err);
        res.status(500).json(null);
    }
});

// ========== UPDATE USER PHOTO ==========
app.patch('/api/user/:id/photo', async (req, res) => {
    try {
        await pool.query('UPDATE users SET photoURL = $1 WHERE id = $2', [req.body.photoURL, req.params.id]);
        res.sendStatus(200);
    } catch (err) {
        console.error('Update photo error:', err);
        res.sendStatus(500);
    }
});

// ========== GALLERY ENDPOINTS ==========
app.post('/api/user/:id/gallery', async (req, res) => {
    try {
        if (Array.isArray(req.body)) {
            await pool.query('UPDATE users SET gallery = $1 WHERE id = $2', [JSON.stringify(req.body), req.params.id]);
        } else {
            await pool.query('UPDATE users SET gallery = gallery || $1 WHERE id = $2', [JSON.stringify([req.body]), req.params.id]);
        }
        res.sendStatus(200);
    } catch (err) {
        console.error('Add gallery error:', err);
        res.sendStatus(500);
    }
});

app.get('/api/user/:id/gallery', async (req, res) => {
    try {
        const result = await pool.query('SELECT gallery FROM users WHERE id = $1', [req.params.id]);
        res.json(result.rows[0]?.gallery || []);
    } catch (err) {
        console.error('Get gallery error:', err);
        res.json([]);
    }
});

app.delete('/api/user/:id/gallery/:mediaId', async (req, res) => {
    try {
        const userId = req.params.id;
        const idx = parseInt(req.params.mediaId, 10);
        if (isNaN(idx)) return res.sendStatus(400);
        const oneBased = idx + 1;

        const query = `
            UPDATE users SET gallery = (
                SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
                FROM jsonb_array_elements(gallery) WITH ORDINALITY arr(elem, ord)
                WHERE ord != $1
            ) WHERE id = $2 RETURNING gallery
        `;

        const result = await pool.query(query, [oneBased, userId]);
        if (result.rowCount === 0) return res.sendStatus(404);
        res.json(result.rows[0].gallery || []);
    } catch (err) {
        console.error('Gallery delete error:', err);
        res.sendStatus(500);
    }
});

// ========== UPDATE USER NAME ==========
app.patch('/api/user/:id/name', async (req, res) => {
    try {
        await pool.query('UPDATE users SET name = $1 WHERE id = $2', [req.body.name, req.params.id]);
        res.sendStatus(200);
    } catch (err) {
        console.error('Update name error:', err);
        res.sendStatus(500);
    }
});

// ========== UPDATE USER EMAIL ==========
app.patch('/api/user/:id/email', async (req, res) => {
    try {
        await pool.query('UPDATE users SET email = $1 WHERE id = $2', [req.body.email, req.params.id]);
        res.sendStatus(200);
    } catch (err) {
        console.error('Update email error:', err);
        res.sendStatus(500);
    }
});

// ========== UPDATE USER PASSWORD ==========
app.patch('/api/user/:id/password', async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        const userId = req.params.id;

        const userResult = await pool.query('SELECT password FROM users WHERE id = $1', [userId]);
        if (userResult.rows.length === 0) {
            return res.status(404).json({ message: 'User not found' });
        }

        if (currentPassword) {
            const isValid = await bcrypt.compare(currentPassword, userResult.rows[0].password);
            if (!isValid) {
                return res.status(401).json({ message: 'Current password is incorrect' });
            }
        }

        const hashed = await bcrypt.hash(newPassword, 10);
        await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashed, userId]);
        res.sendStatus(200);
    } catch (err) {
        console.error('Password change error:', err);
        res.sendStatus(500);
    }
});

// ========== DELETE USER ==========
app.delete('/api/user/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
        res.sendStatus(200);
    } catch (err) {
        console.error('Delete user error:', err);
        res.sendStatus(500);
    }
});

// ========== JOB ENDPOINTS ==========
app.post('/api/jobs', async (req, res) => {
    try {
        const { title, trade, description, location, postedBy, posterName } = req.body;
        const result = await pool.query(
            `INSERT INTO jobs (title, trade, description, location, postedBy, posterName) 
             VALUES ($1, $2, $3, $4, $5, $6) 
             RETURNING id`,
            [title, trade, description, location, postedBy, posterName]
        );
        res.status(201).json({ success: true, id: result.rows[0].id });
    } catch (err) {
        console.error('Create job error:', err);
        res.status(500).json({ message: 'Failed to create job' });
    }
});

app.get('/api/jobs', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM jobs ORDER BY time DESC');
        res.json(result.rows);
    } catch (err) {
        console.error('Get jobs error:', err);
        res.json([]);
    }
});

app.get('/api/jobs/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM jobs WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Job not found' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Get job error:', err);
        res.status(500).json({ message: 'Failed to get job' });
    }
});

app.patch('/api/jobs/:id', async (req, res) => {
    try {
        const jobId = req.params.id;
        const { title, trade, description, location } = req.body;
        const userId = req.headers['user-id'];

        const jobCheck = await pool.query('SELECT postedBy FROM jobs WHERE id = $1', [jobId]);
        if (jobCheck.rows.length === 0) {
            return res.status(404).json({ message: 'Job not found' });
        }

        if (String(jobCheck.rows[0].postedby) !== String(userId)) {
            return res.status(403).json({ message: 'You can only edit your own jobs' });
        }

        await pool.query(
            `UPDATE jobs SET 
                title = COALESCE($1, title),
                trade = COALESCE($2, trade),
                description = COALESCE($3, description),
                location = COALESCE($4, location)
             WHERE id = $5`,
            [title, trade, description, location, jobId]
        );

        res.json({ success: true, message: 'Job updated successfully' });
    } catch (err) {
        console.error('Update job error:', err);
        res.status(500).json({ message: 'Failed to update job' });
    }
});

app.delete('/api/jobs/:id', async (req, res) => {
    try {
        const jobId = req.params.id;
        const userId = req.headers['user-id'];

        const userCheck = await pool.query('SELECT is_admin FROM users WHERE id = $1', [userId]);
        const isAdmin = userCheck.rows[0]?.is_admin === true;

        if (!isAdmin) {
            const jobCheck = await pool.query('SELECT postedBy FROM jobs WHERE id = $1', [jobId]);
            if (jobCheck.rows.length === 0) {
                return res.status(404).json({ message: 'Job not found' });
            }
            if (String(jobCheck.rows[0].postedby) !== String(userId)) {
                return res.status(403).json({ message: 'You can only delete your own jobs' });
            }
        }

        await pool.query('DELETE FROM jobs WHERE id = $1', [jobId]);
        res.json({ success: true, message: 'Job deleted successfully' });
    } catch (err) {
        console.error('Delete job error:', err);
        res.status(500).json({ message: 'Failed to delete job' });
    }
});

// ========== UPLOAD FILE ==========
app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
        const host = req.get('host');
        const protocol = req.protocol;
        const fileUrl = `${protocol}://${host}/uploads/${req.file.filename}`;
        res.json({ url: fileUrl, name: req.file.originalname, type: req.file.mimetype });
    } catch (err) {
        console.error('Upload error:', err);
        res.status(500).json({ message: 'Upload failed' });
    }
});

// ========== CONTACT FORM ==========
app.post('/api/contact', async (req, res) => {
    try {
        const { name, email, subject, message } = req.body;

        if (!name || !email || !subject || !message) {
            return res.status(400).json({ message: 'All fields are required' });
        }

        const adminHtml = `
            <div style="font-family: Arial, sans-serif; max-width: 500px;">
                <h2 style="color: #0d6efd;">New Contact Form Submission</h2>
                <p><strong>Name:</strong> ${name}</p>
                <p><strong>Email:</strong> ${email}</p>
                <p><strong>Subject:</strong> ${subject}</p>
                <p><strong>Message:</strong></p>
                <p>${message}</p>
            </div>
        `;

        const userHtml = `
            <div style="font-family: Arial, sans-serif; max-width: 500px;">
                <h2 style="color: #0d6efd;">Thank you for contacting LaborConnect!</h2>
                <p>We will get back to you within 24 hours.</p>
            </div>
        `;

        await queueEmail(process.env.ADMIN_EMAIL || 'admin@laborconnect.com', `Contact Form: ${subject}`, adminHtml);
        await queueEmail(email, 'Thank you for contacting LaborConnect', userHtml);

        res.json({ success: true, message: 'Message sent successfully!' });
    } catch (err) {
        console.error('Contact form error:', err);
        res.status(500).json({ message: 'Failed to send message' });
    }
});

// ========== MESSAGES ENDPOINTS ==========
app.get('/api/messages/:chatId', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM messages WHERE chatId = $1 ORDER BY time ASC', [req.params.chatId]);
        res.json(result.rows);
    } catch (err) {
        console.error('Get messages error:', err);
        res.json([]);
    }
});

app.patch('/api/messages/:id', async (req, res) => {
    try {
        const { text, payload } = req.body;
        await pool.query('UPDATE messages SET text = $1, payload = $2 WHERE id = $3', [text, payload || null, req.params.id]);
        res.sendStatus(200);
    } catch (err) {
        console.error('Update message error:', err);
        res.sendStatus(500);
    }
});

app.delete('/api/messages/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM messages WHERE id = $1', [req.params.id]);
        res.sendStatus(200);
    } catch (err) {
        console.error('Delete message error:', err);
        res.sendStatus(500);
    }
});

// ========== CONVERSATIONS ==========
app.get('/api/conversations/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;

        const result = await pool.query(`
            SELECT DISTINCT 
                CASE 
                    WHEN fromUser = $1 THEN toUser 
                    ELSE fromUser 
                END as other_user_id,
                MAX(time) as last_message_time
            FROM messages 
            WHERE fromUser = $1 OR toUser = $1
            GROUP BY other_user_id
            ORDER BY last_message_time DESC
        `, [userId]);

        const conversations = [];

        for (const row of result.rows) {
            if (!row.other_user_id) continue;

            const userResult = await pool.query(
                'SELECT id, name, userType, photoURL FROM users WHERE id = $1',
                [row.other_user_id]
            );

            if (userResult.rows.length === 0) continue;

            const user = userResult.rows[0];

            const lastMsgResult = await pool.query(`
                SELECT text, type, time, fromUser
                FROM messages 
                WHERE (fromUser = $1 AND toUser = $2) OR (fromUser = $2 AND toUser = $1)
                ORDER BY time DESC 
                LIMIT 1
            `, [userId, row.other_user_id]);

            const unreadResult = await pool.query(`
                SELECT COUNT(*) as unread
                FROM messages 
                WHERE toUser = $1 AND fromUser = $2 AND (read IS NULL OR read = false)
            `, [userId, row.other_user_id]);

            conversations.push({
                userId: user.id,
                userName: user.name,
                userType: user.usertype,
                photoURL: user.photourl,
                lastMessage: lastMsgResult.rows[0]?.text || 'No messages',
                lastMessageTime: lastMsgResult.rows[0]?.time,
                lastMessageType: lastMsgResult.rows[0]?.type || 'text',
                unreadCount: parseInt(unreadResult.rows[0]?.unread || 0)
            });
        }

        res.json(conversations);
    } catch (err) {
        console.error('Conversations error:', err);
        res.status(500).json([]);
    }
});

app.get('/api/messages/user/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const result = await pool.query(
            'SELECT * FROM messages WHERE fromUser = $1 OR toUser = $1 ORDER BY time DESC',
            [userId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Messages error:', err);
        res.json([]);
    }
});

app.post('/api/messages/read', async (req, res) => {
    try {
        const { userId, otherUserId } = req.body;
        await pool.query(
            'UPDATE messages SET read = true WHERE toUser = $1 AND fromUser = $2 AND (read IS NULL OR read = false)',
            [userId, otherUserId]
        );
        res.sendStatus(200);
    } catch (err) {
        console.error('Mark read error:', err);
        res.sendStatus(500);
    }
});

// ========== FORGOT PASSWORD ==========
app.post('/api/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ message: "Email is required" });
        }

        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);

        if (result.rows.length === 0) {
            return res.status(400).json({ message: "Email not found" });
        }

        const crypto = require('crypto');
        const resetToken = crypto.randomBytes(32).toString('hex');
        const expiry = new Date(Date.now() + 15 * 60 * 1000);

        await pool.query(
            'UPDATE users SET reset_token = $1, reset_token_expiry = $2 WHERE email = $3',
            [resetToken, expiry, email]
        );

        sendPasswordResetEmail(email, resetToken);

        res.json({ message: "Password reset link sent to your email" });

    } catch (err) {
        console.error('Forgot password error:', err);
        res.status(500).json({ message: "Server error" });
    }
});

app.get('/api/reset-password/:token', async (req, res) => {
    try {
        const token = req.params.token;
        const result = await pool.query(
            'SELECT * FROM users WHERE reset_token = $1 AND reset_token_expiry > NOW()',
            [token]
        );

        if (result.rows.length === 0) {
            return res.send(`<h3>Invalid or expired reset link</h3>`);
        }

        res.send(`
            <form method="POST" action="/api/reset-password/${token}">
                <h3>Enter New Password</h3>
                <input type="password" name="password" required minlength="6" placeholder="New password">
                <button type="submit">Reset Password</button>
            </form>
        `);
    } catch (err) {
        console.error('Reset password GET error:', err);
        res.send('<h3>Error</h3>');
    }
});

app.post('/api/reset-password/:token', async (req, res) => {
    try {
        const token = req.params.token;
        const { password } = req.body;
        const hashed = await bcrypt.hash(password, 10);

        const result = await pool.query(
            'UPDATE users SET password = $1, reset_token = null, reset_token_expiry = null WHERE reset_token = $2 AND reset_token_expiry > NOW()',
            [hashed, token]
        );

        if (result.rowCount === 0) {
            return res.send('<h3>Invalid or expired token</h3>');
        }

        res.send(`
            <h3>Password Reset Successful!</h3>
            <a href="${process.env.FRONTEND_URL || 'http://localhost:5500'}/login.html">Login Now</a>
        `);
    } catch (err) {
        console.error('Reset password POST error:', err);
        res.send('<h3>Error resetting password</h3>');
    }
});

// ========== RESEND VERIFICATION ==========
app.post('/api/resend-verification', async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ message: 'Email is required' });
        }

        const result = await pool.query(
            'SELECT * FROM users WHERE email = $1 AND is_verified = false',
            [email]
        );

        if (result.rows.length === 0) {
            return res.status(400).json({
                message: 'Account already verified or does not exist'
            });
        }

        const verifyCode = Math.floor(100000 + Math.random() * 900000).toString();
        const codeExpire = new Date(Date.now() + 24 * 60 * 60 * 1000);

        await pool.query(
            'UPDATE users SET verification_token = $1, token_expires = $2 WHERE email = $3',
            [verifyCode, codeExpire, email]
        );

        const verificationHtml = `
            <div style="font-family: Arial, sans-serif; max-width: 500px;">
                <h2 style="color: #0d6efd;">LaborConnect</h2>
                <p>Your new verification code is: <strong>${verifyCode}</strong></p>
                <p>This code expires in 24 hours.</p>
            </div>
        `;

        queueEmail(email, 'LaborConnect - Your New Verification Code', verificationHtml);

        res.json({
            success: true,
            message: 'New verification code sent to your email!'
        });

    } catch (err) {
        console.error('Resend error:', err);
        res.status(500).json({ message: 'Failed to resend code. Please try again.' });
    }
});

// ========== CALL LOGS ==========
app.post('/api/calls', async (req, res) => {
    try {
        const { callerId, receiverId, callType, callStatus, duration, chatId } = req.body;

        const result = await pool.query(
            `INSERT INTO calls (caller_id, receiver_id, call_type, call_status, duration, chat_id, started_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())
             RETURNING id`,
            [callerId, receiverId, callType, callStatus, duration, chatId]
        );

        res.json({ success: true, id: result.rows[0].id });
    } catch (err) {
        console.error('Save call error:', err);
        res.status(500).json({ error: 'Failed to save call record' });
    }
});

app.put('/api/calls/:id', async (req, res) => {
    try {
        const { duration, endedAt, callStatus } = req.body;
        const callId = req.params.id;

        let query = 'UPDATE calls SET ';
        const updates = [];
        const values = [];
        let paramCount = 1;

        if (duration !== undefined) {
            updates.push(`duration = $${paramCount++}`);
            values.push(duration);
        }
        if (endedAt !== undefined) {
            updates.push(`ended_at = $${paramCount++}`);
            values.push(endedAt);
        }
        if (callStatus !== undefined) {
            updates.push(`call_status = $${paramCount++}`);
            values.push(callStatus);
        }

        if (updates.length === 0) {
            return res.json({ success: true });
        }

        query += updates.join(', ') + ` WHERE id = $${paramCount}`;
        values.push(callId);

        await pool.query(query, values);
        res.json({ success: true });
    } catch (err) {
        console.error('Update call error:', err);
        res.status(500).json({ error: 'Failed to update call record' });
    }
});

app.get('/api/calls/user/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;

        const result = await pool.query(
            `SELECT c.*, 
                u1.name as caller_name, u1.photoURL as caller_photo,
                u2.name as receiver_name, u2.photoURL as receiver_photo
             FROM calls c
             LEFT JOIN users u1 ON c.caller_id = u1.id::text             LEFT JOIN users u2 ON c.receiver_id = u2.id::text
             WHERE c.caller_id = $1 OR c.receiver_id = $1
             ORDER BY c.started_at DESC
             LIMIT 100`,
            [userId]
        );

        res.json(result.rows);
    } catch (err) {
        console.error('Get calls error:', err);
        res.status(500).json([]);
    }
});

// ========== SOCKET.IO ==========
const userSockets = new Map();

function emitToUserSockets(userId, event, data) {
    const socketId = userSockets.get(String(userId));
    if (socketId) {
        io.to(socketId).emit(event, data);
        return true;
    }
    return false;
}

function removeUserSocket(socketId) {
    for (const [userId, storedSocketId] of userSockets.entries()) {
        if (storedSocketId === socketId) {
            userSockets.delete(userId);
            return userId;
        }
    }
    return null;
}

io.on('connection', (socket) => {
    console.log('🔌 New client connected:', socket.id);

    socket.on('register-user', (userId) => {
        userSockets.set(String(userId), socket.id);
        console.log(`👤 User ${userId} registered`);
    });

    socket.on('join-chat', (chatId) => {
        console.log(`📢 Client joined chat room: ${chatId}`);
        socket.join(chatId);
    });

    socket.on('send-message', async (msg) => {
        console.log(`📤 Message received:`, msg);
        try {
            const result = await pool.query(
                `INSERT INTO messages (chatId, fromUser, toUser, text, type, payload, replyTo) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, time`,
                [msg.chatId, msg.from, msg.to, msg.text, msg.type || 'text', msg.payload || null, msg.replyTo || null]
            );
            if (result.rows[0]) {
                msg.id = result.rows[0].id;
                msg.time = result.rows[0].time;
            }
        } catch (err) {
            console.error('❌ Error saving message:', err);
        }
        io.to(msg.chatId).emit('new-message', msg);
        emitToUserSockets(msg.to, 'chat-notification', {
            chatId: msg.chatId,
            from: msg.from,
            to: msg.to,
            text: msg.text,
            type: msg.type || 'text',
            title: 'New message',
            body: msg.text
        });
    });

    socket.on('edit-message', async (payload) => {
        try {
            await pool.query('UPDATE messages SET text = $1 WHERE id = $2', [payload.text, payload.id]);
            io.to(payload.chatId).emit('message-updated', payload);
        } catch (err) {
            console.error('❌ Error editing message:', err);
        }
    });

    socket.on('delete-message', async (payload) => {
        try {
            if (payload.deleteForEveryone) {
                await pool.query('DELETE FROM messages WHERE id = $1', [payload.id]);
                io.to(payload.chatId).emit('message-deleted-for-everyone', { id: payload.id, chatId: payload.chatId });
            } else {
                const result = await pool.query('SELECT deleted_for FROM messages WHERE id = $1', [payload.id]);
                let deletedFor = result.rows[0]?.deleted_for || '';
                let deletedList = deletedFor ? deletedFor.split(',') : [];
                if (!deletedList.includes(String(payload.userId))) {
                    deletedList.push(String(payload.userId));
                }
                await pool.query('UPDATE messages SET deleted_for = $1 WHERE id = $2', [deletedList.join(','), payload.id]);
                io.to(payload.chatId).emit('message-deleted-for-user', { id: payload.id, userId: payload.userId });
            }
        } catch (err) {
            console.error('❌ Error deleting message:', err);
        }
    });

    socket.on('start-call', async (data) => {
        const { to, from, callType, chatId, sdp } = data;
        console.log(`📞 Starting call from ${from} to ${to}`);

        const result = await pool.query(
            `INSERT INTO calls (caller_id, receiver_id, call_type, call_status, chat_id, started_at)
             VALUES ($1, $2, $3, 'ringing', $4, NOW())
             RETURNING id`,
            [from, to, callType, chatId]
        );

        const callId = result.rows[0].id;

        emitToUserSockets(to, 'incoming-call', {
            from: from,
            callType: callType,
            callId: callId,
            chatId: chatId,
            sdp: sdp
        });

        io.to(chatId).emit('call-offer', { from, callType, callId, sdp });
        socket.emit('call-initiated', { callId });
    });

    socket.on('accept-call', async (data) => {
        const { to, from, callId, chatId } = data;
        console.log(`📞 Call accepted: ${callId}`);

        await pool.query(`UPDATE calls SET call_status = 'answered' WHERE id = $1`, [callId]);

        emitToUserSockets(to, 'call-accepted', { callId, from });
        io.to(chatId).emit('call-accepted', { callId });
    });

    socket.on('decline-call', async (data) => {
        const { to, callId, chatId } = data;
        console.log(`📞 Call declined: ${callId}`);

        await pool.query(`UPDATE calls SET call_status = 'missed', ended_at = NOW() WHERE id = $1`, [callId]);

        emitToUserSockets(to, 'call-declined', { callId });
        io.to(chatId).emit('call-ended', { callId });
    });

    socket.on('end-call', async (data) => {
        const { callId, duration, chatId } = data;
        console.log(`📞 Call ended: ${callId}, duration: ${duration}s`);

        if (callId) {
            await pool.query(
                `UPDATE calls SET call_status = 'ended', ended_at = NOW(), duration = $1 WHERE id = $2`,
                [duration || 0, callId]
            );
        }

        io.to(chatId).emit('call-ended', { callId });
    });

    socket.on('signal', (data) => {
        const targetSocketId = userSockets.get(String(data.to));
        if (targetSocketId) {
            io.to(targetSocketId).emit('signal', data);
        }
    });

    socket.on('disconnect', () => {
        const userId = removeUserSocket(socket.id);
        if (userId) {
            console.log(`👤 User ${userId} disconnected`);
        }
    });
});

// ========== START SERVER ==========
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));