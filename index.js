const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const multer = require('multer');
const sharp = require('sharp');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));


// Supabase configuration
const supabaseUrl = process.env.SUPABASE_URL || 'https://bzlqrlqhmilhfcjnjwnc.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ6bHFybHFobWlsaGZjam5qd25jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc5MzUxOTgsImV4cCI6MjA3MzUxMTE5OH0.wN_kbuhDUo26Ec26q8mbXWD6s9vexW_GIpKXLggWeCE';
const supabase = createClient(supabaseUrl, supabaseKey);

// Nodemailer configuration
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER || 'isacon2020nagpur@gmail.com',
    pass: process.env.EMAIL_PASS || 'bcsa hwxm chmb epvx',
  },
});

// JWT configuration
const JWT_SECRET = process.env.JWT_SECRET || 'isanagpur';

// Multer configuration for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/pdf',
      'text/plain',
      'application/msword',
      'image/jpeg',
      'image/png',
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF, TXT, Word, JPG, PNG allowed.'));
    }
  },
});

// Ensure upload directories exist
const ensureDir = async (dir) => {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    console.error('Error creating directory:', err);
  }
};
ensureDir(path.join(__dirname, 'uploads/profiles'));
ensureDir(path.join(__dirname, 'uploads/research'));
ensureDir(path.join(__dirname, 'uploads/cases'));
ensureDir(path.join(__dirname, 'uploads/chats'));

// Generate OTP (4 digits as per schema)
const generateOTP = () => Math.floor(1000 + Math.random() * 9000).toString();

// Socket.IO connection handling
const onlineUsers = new Map();
io.on('connection', (socket) => {
  socket.on('user-online', async (userId) => {
    onlineUsers.set(userId, socket.id);
    await supabase.from('profiles').update({ online: true }).eq('id', userId);
    io.emit('user-status', { userId, online: true });
  });

  socket.on('typing', ({ senderId, receiverId }) => {
    const receiverSocket = onlineUsers.get(receiverId);
    if (receiverSocket) {
      io.to(receiverSocket).emit('typing', { senderId });
    }
  });

  socket.on('stop-typing', ({ senderId, receiverId }) => {
    const receiverSocket = onlineUsers.get(receiverId);
    if (receiverSocket) {
      io.to(receiverSocket).emit('stop-typing', { senderId });
    }
  });

  socket.on('disconnect', async () => {
    for (const [userId, socketId] of onlineUsers.entries()) {
      if (socketId === socket.id) {
        await supabase.from('profiles').update({ online: false }).eq('id', userId);
        io.emit('user-status', { userId, online: false });
        onlineUsers.delete(userId);
        break;
      }
    }
  });
});

// Middleware to verify JWT
const authenticateJWT = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', decoded.userId)
      .single();
    if (error || !data) return res.status(401).json({ error: 'Invalid token' });
    req.user = data;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Registration
app.post('/register', async (req, res) => {
  const { name, email, isa_number, member_isa_nagpur, contact_number } = req.body;

  if (!name || !email || !isa_number || !contact_number) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (!/^[A-Z]\d{4}$/.test(isa_number)) {
    return res.status(400).json({ error: 'Invalid ISA Number format (e.g., A1234)' });
  }

  const { data: existingUser } = await supabase
    .from('profiles')
    .select('id')
    .eq('email', email)
    .single();

  if (existingUser) {
    return res.status(400).json({ error: 'Email already registered' });
  }

  const otp = generateOTP();
  const userId = uuidv4();

  const { error } = await supabase.from('profiles').insert({
    id: userId,
    name,
    email,
    isa_number,
    member_isa_nagpur,
    contact_number,
    user_type: 'user',
    email_otp: otp,
    verified_email: false,
    approved: false,
    created_at: new Date().toISOString(),
    online: false,
    no_of_research_papers: 0,
    no_of_case_discussions: 0,
    no_of_messages_sent: 0,
    no_of_comments_posted: 0,
    login_logs: [],
    edited_logs: [],
  });

  if (error) {
    return res.status(500).json({ error: 'Registration failed: ' + error.message });
  }

  // Send OTP email
  await transporter.sendMail({
    to: email,
    subject: 'Your OTP for Registration',
    text: `Your OTP for registration is: ${otp}

This OTP is valid for 10 minutes. Please do not share it with anyone.

Best Regards,
ISA Nagpur Team`,
  html: `
    <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6; max-width: 600px; margin: auto; border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; background: #ffffff;">
      
      <!-- Logo with white background -->
      <div style="text-align: center; margin-bottom: 20px;">
        <div style="display: inline-block; background: #ffffff; padding: 5px; border-radius: 8px;">
          <img src="https://www.isanagpur.org/wp-content/uploads/2021/06/isa-icon.png.webp" 
               alt="ISA Nagpur Logo" 
               style="width: 80px; height: auto; display: block;" />
        </div>
      </div>

      <!-- Title -->
      <h2 style="color: #2E86C1; text-align: center;">🔑 Your OTP for Registration</h2>
      
      <!-- Body -->
      <p>Dear User,</p>
      <p>Please use the following OTP to complete your registration:</p>

      <!-- OTP Box -->
      <div style="font-size: 24px; font-weight: bold; margin: 20px auto; padding: 12px 20px; border: 2px dashed #2E86C1; display: inline-block; background: #f9f9f9; border-radius: 6px; text-align: center;">
        ${otp}
      </div>

      <p>This OTP is valid for <strong>10 minutes</strong>. Do not share it with anyone.</p>

      <!-- Footer -->
      <p style="margin-top: 30px;">Best Regards,<br/><strong>ISA Nagpur Team</strong></p>
      <p style="text-align: center; font-size: 12px; color: #888; margin-top: 20px;">
        © ${new Date().getFullYear()} ISA Nagpur. All rights reserved.
      </p>
    </div>
  `
});

  res.json({ message: 'OTP sent to email', userId, name });
});



//  Verify OTP for Registration (using email)
app.post('/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;

    // Find user by email + OTP
    const { data: user, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('email', email)
      .eq('email_otp', otp)
      .single();

    if (error || !user) {
      return res.status(400).json({ error: 'Invalid or expired OTP' });
    }

    // Mark user as verified & clear OTP
    await supabase
      .from('profiles')
      .update({ verified_email: true, email_otp: null })
      .eq('email', email);

    // Send confirmation email
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: '✅ Registration Successful',
      text: `Hi ${user.name},

Your email has been verified successfully. Please wait for admin approval.

Thank you!
ISA Nagpur Team`,
  html: `
    <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6; max-width: 600px; margin: auto; border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; background: #ffffff;">
      
      <!-- Logo with white background -->
      <div style="text-align: center; margin-bottom: 20px;">
        <div style="display: inline-block; background: #ffffff; padding: 5px; border-radius: 8px;">
          <img src="https://www.isanagpur.org/wp-content/uploads/2021/06/isa-icon.png.webp" 
               alt="ISA Nagpur Logo" 
               style="width: 80px; height: auto; display: block;" />
        </div>
      </div>

      <!-- Title -->
      <h2 style="color: #2E86C1; text-align: center;">✅ Email Verified Successfully</h2>
      
      <!-- Body -->
      <p>Hi <strong>${user.name}</strong>,</p>
      <p>Your email has been <strong style="color: green;">verified successfully</strong>. Please wait for admin approval before you can access your account.</p>

      <!-- Info Box -->
      <div style="margin: 20px 0; padding: 15px; border-left: 4px solid #2E86C1; background: #f4f9ff; border-radius: 4px;">
        Thank you for registering with <strong>ISA Nagpur</strong>!<br/>
        We will notify you once your account is approved by the admin.
      </div>

      <!-- Footer -->
      <p style="margin-top: 30px;">Best Regards,<br/><strong>ISA Nagpur Team</strong></p>
      <p style="text-align: center; font-size: 12px; color: #888; margin-top: 20px;">
        © ${new Date().getFullYear()} ISA Nagpur. All rights reserved.
      </p>
    </div>
  `
});

    res.json({
      message: 'Registration successful, waiting for admin approval',
      email,
      name: user.name,
    });
  } catch (err) {
    console.error('Verify OTP Error:', err);
    res.status(500).json({ error: 'Server error while verifying OTP' });
  }
});

//  Resend OTP (using email)
app.post('/resend-otp', async (req, res) => {
  try {
    const { email } = req.body;

    // Find user
    const { data: user, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('email', email)
      .single();

    if (error || !user) {
      return res.status(400).json({ error: 'User not found' });
    }

    // Generate new OTP
    const otp = generateOTP();
    await supabase
      .from('profiles')
      .update({ email_otp: otp })
      .eq('email', email);

    // Send OTP via email
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: '🔑 Your OTP for Registration',
      text: `Hi ${user.name},\n\nYour OTP is: ${otp}\n\nIt is valid for 10 minutes.`,
    });

    res.json({ message: 'OTP resent successfully' });
  } catch (err) {
    console.error('Resend OTP Error:', err);
    res.status(500).json({ error: 'Server error while resending OTP' });
  }
});
// Admin Approve User
app.post('/approve-user', authenticateJWT, async (req, res) => {
  if (req.user.user_type !== 'admin' && req.user.user_type !== 'superadmin') {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const { email } = req.body;
  const { data: user, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('email', email)
    .single();

  if (error || !user) {
    return res.status(400).json({ error: 'User not found' });
  }

  if (!user.verified_email) {
    return res.status(400).json({ error: 'User email not verified' });
  }

  await supabase
    .from('profiles')
    .update({
      approved: true,
      approved_by: req.user.id,
      approved_at: new Date().toISOString(),
    })
    .eq('email', email);

  await transporter.sendMail({
    to: user.email,
    subject: 'Account Approved',
    text: 'You are approved by admin, you can now login.',
  html: `
    <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6; max-width: 600px; margin: auto; border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; background: #ffffff;">
      
      <!-- Logo with white background -->
      <div style="text-align: center; margin-bottom: 20px;">
        <div style="display: inline-block; background: #ffffff; padding: 5px; border-radius: 8px;">
          <img src="https://www.isanagpur.org/wp-content/uploads/2021/06/isa-icon.png.webp" 
               alt="ISA Nagpur Logo" 
               style="width: 80px; height: auto; display: block;" />
        </div>
      </div>

      <!-- Title -->
      <h2 style="color: #2E86C1; text-align: center;">✅ Account Approved</h2>
      
      <!-- Body -->
      <p>Dear User,</p>
      <p>Your account has been <strong style="color: green;">approved by the admin</strong>. You can now log in and access your account.</p>

      <!-- Login Button -->
      <div style="text-align: center; margin: 25px 0;">
        <a href="https://academicia.isanagpur.org" 
           style="background-color: #2E86C1; color: #fff; padding: 12px 25px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
           Login Now
        </a>
      </div>

      <!-- Footer -->
      <p style="margin-top: 30px;">Best Regards,<br/><strong>ISA Nagpur Team</strong></p>
      <p style="text-align: center; font-size: 12px; color: #888; margin-top: 20px;">
        © ${new Date().getFullYear()} ISA Nagpur. All rights reserved.
      </p>
    </div>
  `
});

  res.json({ message: 'User approved successfully' });
});

// Login
app.post('/login', async (req, res) => {
  const { email } = req.body;

  const { data: user, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('email', email)
    .single();

  if (error || !user) {
    return res.status(400).json({ error: 'User not found' });
  }

  if (!user.approved && user.user_type === 'user') {
    return res.status(403).json({ error: 'User not approved' });
  }

  const otp = generateOTP();
  await supabase
    .from('profiles')
    .update({ email_otp: otp })
    .eq('email', email);

  await transporter.sendMail({
    to: email,
    subject: 'Your OTP for Login',
    text: `Your OTP is ${otp}. This OTP is valid for 10 minutes. Please do not share it with anyone.

Best Regards,
ISA Nagpur Team`,
  html: `
    <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6; max-width: 600px; margin: auto; border: 1px solid #e0e0e0; border-radius: 8px; padding: 20px; background: #ffffff;">
      
      <div style="text-align: center; margin-bottom: 20px;">
        <div style="display: inline-block; background: #ffffff; padding: 5px; border-radius: 8px;">
          <img src="https://www.isanagpur.org/wp-content/uploads/2021/06/isa-icon.png.webp" 
               alt="ISA Nagpur Logo" 
               style="width: 80px; height: auto; display: block;" />
        </div>
      </div>

      <!-- Title -->
      <h2 style="color: #2E86C1; text-align: center;">🔑 Your OTP for Login</h2>
      
      <!-- Body -->
      <p>Dear User,</p>
      <p>Please use the following OTP to log in to your account:</p>

      <!-- OTP Box -->
      <div style="font-size: 24px; font-weight: bold; margin: 20px auto; padding: 12px 20px; border: 2px dashed #2E86C1; display: inline-block; background: #f9f9f9; border-radius: 6px; text-align: center;">
        ${otp}
      </div>

      <p>This OTP is valid for <strong>10 minutes</strong>. Do not share it with anyone.</p>

      <!-- Footer -->
      <p style="margin-top: 30px;">Best Regards,<br/><strong>ISA Nagpur Team</strong></p>
      <p style="text-align: center; font-size: 12px; color: #888; margin-top: 20px;">
        © ${new Date().getFullYear()} ISA Nagpur. All rights reserved.
      </p>
    </div>
  `
    
  });

  res.json({ message: 'OTP sent to email', email });
});

// Verify Login OTP
app.post('/verify-login-otp', async (req, res) => {
  const { email, otp } = req.body;

  const { data: user, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('email', email)
    .eq('email_otp', otp)
    .single();

  if (error || !user) {
    return res.status(400).json({ error: 'Invalid OTP' });
  }

  if (!user.approved && user.user_type === 'user') {
    return res.status(403).json({ error: 'User not approved' });
  }

  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '1d' });
  await supabase
    .from('profiles')
    .update({
      online: true,
      email_otp: null,
      login_logs: [...(user.login_logs || []), { type: 'login', timestamp: new Date().toISOString() }],
    })
    .eq('email', email);

  res.json({
    userId: user.id,
    name: user.name,
    email: user.email,
    user_type: user.user_type,
    token,
    online: true,
  });
});

// Update Profile
app.put('/profile', authenticateJWT, upload.single('image'), async (req, res) => {
  const {
    name, gender, date_of_birth, contact_number, specialization, years_of_experience,
    medical_registration_number, isa_number, clinic_hospital_name, city, state, country,
    qualifications, member_isa_nagpur,
  } = req.body;

  const updates = {
    name,
    gender,
    date_of_birth,
    contact_number,
    specialization: specialization ? JSON.parse(specialization) : undefined,
    years_of_experience: years_of_experience ? parseInt(years_of_experience) : undefined,
    medical_registration_number,
    isa_number,
    clinic_hospital_name,
    city,
    state,
    country,
    qualifications: qualifications ? JSON.parse(qualifications) : undefined,
    member_isa_nagpur,
    edited_logs: [...(req.user.edited_logs || []), { timestamp: new Date().toISOString(), updated_by: req.user.id }],
  };

  if (req.file) {
    const filename = `${req.user.id}_${Date.now()}.png`;
    const filepath = path.join(__dirname, 'uploads/profiles', filename);
    await sharp(req.file.buffer).png().toFile(filepath);
    updates.image = filename;
  }

  const { data, error } = await supabase
    .from('profiles')
    .update(updates)
    .eq('id', req.user.id)
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: 'Profile update failed: ' + error.message });
  }

  res.json(data);
});

// Get Profile
app.get('/profile/:id', authenticateJWT, async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'Profile not found' });
  }

  res.json(data);
});


app.get("/user/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from("profiles") // 👈 replace with your actual table name
      .select(
        `
        id,
        name,
        email,
        no_of_research_papers,
        no_of_case_discussions,
        no_of_messages_sent
      `
      )
      .eq("id", id)
      .single();

    if (error) {
      console.error("Error fetching user:", error);
      return res.status(400).json({ error: error.message });
    }

    if (!data) {
      return res.status(404).json({ error: "User not found" });
    }

    const response = {
      ...data,
      no_of_research_papers: data.no_of_research_papers ?? 0,
      no_of_case_discussions: data.no_of_case_discussions ?? 0,
      no_of_messages_sent: data.no_of_messages_sent ?? 0,
    };

    res.json(response);
  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get All Profiles
app.get('/profiles', authenticateJWT, async (req, res) => {
  if (req.user.user_type !== 'admin' && req.user.user_type !== 'superadmin') {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const { data, error } = await supabase.from('profiles').select('*');
  if (error) {
    return res.status(500).json({ error: 'Failed to fetch profiles: ' + error.message });
  }

  res.json(data);
});

// Delete Profile
app.delete('/profile/:id', authenticateJWT, async (req, res) => {
  if (req.user.user_type !== 'superadmin') {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const { id } = req.params;
  const { data: profile } = await supabase
    .from('profiles')
    .select('image')
    .eq('id', id)
    .single();

  if (profile?.image) {
    await fs.unlink(path.join(__dirname, 'uploads/profiles', profile.image)).catch(() => {});
  }

  const { error } = await supabase.from('profiles').delete().eq('id', id);
  if (error) {
    return res.status(500).json({ error: 'Profile deletion failed: ' + error.message });
  }

  res.json({ message: 'Profile deleted successfully' });
});

//display profilesdirectory with limited access

app.get('/directory', authenticateJWT, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select(`
        id,
        name,
        email,
        contact_number,
        city,
        state,
        country,
        years_of_experience,
        clinic_hospital_name,
        medical_registration_number,
        isa_number,
        gender,
        qualifications,
        specialization,
        verified_email,
        online,
        image
      `);

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch profiles: ' + error.message });
    }

    return res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Unexpected error: ' + err.message });
  }
});





// Send a message (FormData: supports text + file)
app.post('/chat', authenticateJWT, upload.single('file'), async (req, res) => {
  try {
    const { receiverId, content } = req.body;

    if (!receiverId && !content && !req.file) {
      return res.status(400).json({ error: 'Receiver, content, or file required' });
    }

    let filePath;
    let filename;
    let messageType = 'text';

    if (req.file) {
      const ext = path.extname(req.file.originalname).toLowerCase();
      filename = `${uuidv4()}${ext}`;
      filePath = path.join(__dirname, 'uploads/chats', filename);

      await fs.mkdir(path.dirname(filePath), { recursive: true });

      if (req.file.mimetype.startsWith('image/')) {
        await sharp(req.file.buffer).toFile(filePath);
        messageType = 'image';
      } else {
        await fs.writeFile(filePath, req.file.buffer);
        messageType = 'file';
      }
    }

    const message = {
      id: uuidv4(),
      sender_id: req.user.id,
      receiver_id: receiverId,
      type: filename ? messageType : 'text',
      content: filename || content,
      timestamp: new Date().toISOString(),
      status: 'sent',
    };

    const { error } = await supabase.from('messages').insert(message);
    if (error) {
      return res.status(500).json({ error: 'Failed to send message: ' + error.message });
    }

    // Update sender's stats
    await supabase
      .from('profiles')
      .update({ no_of_messages_sent: (req.user.no_of_messages_sent || 0) + 1 })
      .eq('id', req.user.id);

    // Emit via socket
    const receiverSocket = onlineUsers.get(receiverId);
    if (receiverSocket) {
      io.to(receiverSocket).emit('new-message', message);
    }

    // Include file URL if available
    const fileUrl = filename ? `${req.protocol}://${req.get('host')}/chat/file/${filename}` : null;
    res.json({ ...message, fileUrl });
  } catch (err) {
    res.status(500).json({ error: 'Unexpected error: ' + err.message });
  }
});


// Download chat files securely
app.get('/chat/file/:filename', authenticateJWT, async (req, res) => {
  try {
    const { filename } = req.params;

    // Check if file belongs to a message in DB
    const { data: message, error } = await supabase
      .from('messages')
      .select('*')
      .eq('content', filename)
      .single();

    if (error || !message) {
      return res.status(404).json({ error: 'Message not found for this file' });
    }

    // Check if current user is sender or receiver
    if (message.sender_id !== req.user.id && message.receiver_id !== req.user.id) {
      return res.status(403).json({ error: 'Unauthorized to access this file' });
    }

    // Build file path
    const filePath = path.join(__dirname, 'uploads/chats', filename);

    // Check if file actually exists
    await fs.access(filePath);

    // Return file
    res.sendFile(filePath);
  } catch (err) {
    res.status(404).json({ error: 'File not found: ' + err.message });
  }
});


// Get messages with status = 'sent' for a specific receiver

app.get('/messages/unread/:id', authenticateJWT, async (req, res) => {
  try {
    const receiverId = req.params.id;

    const { data, error } = await supabase
      .from('messages')
      .select(`
        id,
        sender_id,
        content,
        timestamp,
        status,
        profiles:sender_id (
          name,
          specialization,
          clinic_hospital_name
        )
      `)
      .eq('receiver_id', receiverId)
      .eq('status', 'sent')   // only unread messages
      .order('timestamp', { ascending: false });

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch messages: ' + error.message });
    }

    // Flatten the response to make it frontend-friendly
    const formatted = data.map(msg => ({
      id: msg.id,
      sender_id: msg.sender_id,
      sender_name: msg.profiles?.name || "Unknown",
      sender_specialization: msg.profiles?.specialization || null,
      sender_clinic: msg.profiles?.clinic_hospital_name || null,
      content: msg.content,
      timestamp: msg.timestamp,
      status: msg.status
    }));

    return res.json({
      unreadCount: formatted.length,
      messages: formatted
    });
  } catch (err) {
    res.status(500).json({ error: 'Unexpected error: ' + err.message });
  }
});


// Mark Message as Read


app.put('/chat/:messageId/read', authenticateJWT, async (req, res) => {
  const { messageId } = req.params;

  // Update message status only if the logged-in user is the receiver
  const { data: updatedMessages, error } = await supabase
    .from('messages')
    .update({ status: 'read' })
    .eq('id', messageId)
    .eq('receiver_id', req.user.id)
    .select(); // Important: return updated row

  if (error) {
    return res.status(500).json({ error: 'Failed to update message status: ' + error.message });
  }

  if (!updatedMessages || updatedMessages.length === 0) {
    return res.status(404).json({ error: 'Message not found or you are not authorized to mark it as read' });
  }

  const message = updatedMessages[0];

  // Emit socket event to sender
  const senderSocket = onlineUsers.get(message.sender_id);
  if (senderSocket) {
    io.to(senderSocket).emit('message-read', { messageId });
  }

  res.json({ message: 'Message marked as read', messageId });
});



// Get chat history between logged-in user and another user


app.get('/chat/:userId', authenticateJWT, async (req, res) => {
  const { userId } = req.params;

  try {
    // Fetch messages where current user is sender or receiver with the target user
    const { data: messages, error } = await supabase
      .from('messages')
      .select('*')
      .or(
        `and(sender_id.eq.${req.user.id},receiver_id.eq.${userId}),and(sender_id.eq.${userId},receiver_id.eq.${req.user.id})`
      )
      .order('timestamp', { ascending: true });

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch messages: ' + error.message });
    }

    // Map messages: if type === 'image', prefix with backend URL
    const mappedMessages = messages.map((msg) => {
  if (msg.type === 'image') {
    return {
      ...msg,
      content: `http://localhost:3000/uploads/chats/${msg.content.trim()}`, // 🔑 remove hidden newlines/spaces
    };
  }
  return msg;
});

    res.json(mappedMessages);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});




// Post Research Paper
app.post('/research-paper', authenticateJWT, upload.fields([{ name: 'file', maxCount: 1 }, { name: 'image', maxCount: 5 }])
, async (req, res) => {
  const { title, authors, category, specialty, publish_date, tags, abstract, description } = req.body;

  // Validate required fields
  if (!title || !authors || !category || !specialty || !publish_date || !tags || !abstract || !description) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Validate and parse authors
  let parsedAuthors;
  try {
    parsedAuthors = JSON.parse(authors);
    if (!Array.isArray(parsedAuthors) || !parsedAuthors.every(item => typeof item === 'string')) {
      return res.status(400).json({ error: 'Authors must be an array of strings' });
    }
  } catch (error) {
    return res.status(400).json({ error: 'Invalid JSON format for authors: ' + error.message });
  }

  // Validate and parse tags
  let parsedTags;
  try {
    parsedTags = JSON.parse(tags);
    if (!Array.isArray(parsedTags) || !parsedTags.every(item => typeof item === 'string')) {
      return res.status(400).json({ error: 'Tags must be an array of strings' });
    }
  } catch (error) {
    return res.status(400).json({ error: 'Invalid JSON format for tags: ' + error.message });
  }

  const researchPaper = {
    id: uuidv4(),
    title,
    authors: parsedAuthors,
    category,
    specialty,
    publish_date,
    tags: parsedTags,
    abstract,
    description,
    created_by: req.user.id,
    created_at: new Date().toISOString(),
    download_count: 0,
  };

  if (req.files.file) {
    const ext = path.extname(req.files.file[0].originalname);
    const filename = `${researchPaper.id}${ext}`;
    const filepath = path.join(__dirname, 'uploads/research', filename);
    await fs.writeFile(filepath, req.files.file[0].buffer);
    researchPaper.file = filename;
  }

  if (req.files.image) {
  researchPaper.image = [];
  for (const img of req.files.image) {
    const filename = `${uuidv4()}.png`;
    const filepath = path.join(__dirname, 'uploads/research', filename);
    await sharp(img.buffer).png().toFile(filepath);
    researchPaper.image.push(filename);
  }
}

  const { error } = await supabase.from('research_papers').insert(researchPaper);
  if (error) {
    return res.status(500).json({ error: 'Failed to post research paper: ' + error.message });
  }

  await supabase
    .from('profiles')
    .update({ no_of_research_papers: req.user.no_of_research_papers + 1 })
    .eq('id', req.user.id);

  res.json(researchPaper);
});

// Update Research Paper
app.put('/research-paper/:id', authenticateJWT, upload.fields([{ name: 'file' }, { name: 'image', maxCount: 1 }]), async (req, res) => {
  const { id } = req.params;
  const { title, authors, category, specialty, publish_date, tags, abstract, description } = req.body;

  const { data: existingPaper } = await supabase
    .from('research_papers')
    .select('*')
    .eq('id', id)
    .single();

  if (!existingPaper || (existingPaper.created_by !== req.user.id && req.user.user_type !== 'superadmin')) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const updates = {};
  if (title) updates.title = title;
  if (category) updates.category = category;
  if (specialty) updates.specialty = specialty;
  if (publish_date) updates.publish_date = publish_date;
  if (abstract) updates.abstract = abstract;
  if (description) updates.description = description;

  if (authors) {
    try {
      const parsedAuthors = JSON.parse(authors);
      if (!Array.isArray(parsedAuthors) || !parsedAuthors.every(item => typeof item === 'string')) {
        return res.status(400).json({ error: 'Authors must be an array of strings' });
      }
      updates.authors = parsedAuthors;
    } catch (error) {
      return res.status(400).json({ error: 'Invalid JSON format for authors: ' + error.message });
    }
  }

  if (tags) {
    try {
      const parsedTags = JSON.parse(tags);
      if (!Array.isArray(parsedTags) || !parsedTags.every(item => typeof item === 'string')) {
        return res.status(400).json({ error: 'Tags must be an array of strings' });
      }
      updates.tags = parsedTags;
    } catch (error) {
      return res.status(400).json({ error: 'Invalid JSON format for tags: ' + error.message });
    }
  }

  if (req.files.file) {
    if (existingPaper.file) {
      await fs.unlink(path.join(__dirname, 'uploads/research', existingPaper.file)).catch(() => {});
    }
    const ext = path.extname(req.files.file[0].originalname);
    const filename = `${id}${ext}`;
    const filepath = path.join(__dirname, 'uploads/research', filename);
    await fs.writeFile(filepath, req.files.file[0].buffer);
    updates.file = filename;
  }

  if (req.files.image) {
    if (req.files.image) {
  // Delete old images
  if (existingPaper.image && Array.isArray(existingPaper.image)) {
    for (const oldImage of existingPaper.image) {
      await fs.unlink(path.join(__dirname, 'uploads/research', oldImage)).catch(() => {});
    }
  }

  // Save new images
  const newImages = [];
  for (const img of req.files.image) {
    const filename = `${uuidv4()}.png`;
    const filepath = path.join(__dirname, 'uploads/research', filename);
    await sharp(img.buffer).png().toFile(filepath);
    newImages.push(filename);
  }
  updates.image = newImages;
}
    const filename = `${uuidv4()}.png`;
    const filepath = path.join(__dirname, 'uploads/research', filename);
    await sharp(req.files.image[0].buffer).png().toFile(filepath);
    updates.image = filename;
  }

  const { data, error } = await supabase
    .from('research_papers')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: 'Failed to update research paper: ' + error.message });
  }

  res.json(data);
});



// Get Research Paper
app.get('/research-paper/:id', authenticateJWT, async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from('research_papers')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'Research paper not found' });
  }

  if (data.image && Array.isArray(data.image)) {
  data.image = data.image.map(img => `http://localhost:3000/uploads/research/${img}`);
}

  res.json(data);
});

// Get All Research Papers
app.get('/research-papers', authenticateJWT, async (req, res) => {
  const { data, error } = await supabase.from('research_papers').select('*');
  if (error) {
    return res.status(500).json({ error: 'Failed to fetch research papers: ' + error.message });
  }
  res.json(data);
});

// Delete Research Paper
app.delete('/research-paper/:id', authenticateJWT, async (req, res) => {
  const { id } = req.params;
  const { data: paper } = await supabase
    .from('research_papers')
    .select('created_by, file, image')
    .eq('id', id)
    .single();

  if (!paper || (paper.created_by !== req.user.id && req.user.user_type !== 'superadmin')) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  if (paper.file) {
    await fs.unlink(path.join(__dirname, 'uploads/research', paper.file)).catch(() => {});
  }

  if (paper.image && Array.isArray(paper.image)) {
  for (const img of paper.image) {
    await fs.unlink(path.join(__dirname, 'uploads/research', img)).catch(() => {});
  }
}

  const { error } = await supabase.from('research_papers').delete().eq('id', id);
  if (error) {
    return res.status(500).json({ error: 'Failed to delete research paper: ' + error.message });
  }

  if (paper.created_by === req.user.id) {
    await supabase
      .from('profiles')
      .update({ no_of_research_papers: req.user.no_of_research_papers - 1 })
      .eq('id', req.user.id);
  }

  res.json({ message: 'Research paper deleted successfully' });
});

// Download Research Paper
app.get('/research-paper/:id/download', authenticateJWT, async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from('research_papers')
    .select('file, download_count')
    .eq('id', id)
    .single();

  if (error || !data || !data.file) {
    return res.status(404).json({ error: 'File not found' });
  }

  await supabase
    .from('research_papers')
    .update({ download_count: data.download_count + 1 })
    .eq('id', id);

  res.sendFile(path.join(__dirname, 'uploads/research', data.file));
});


// Post Case Discussion
app.post('/case-discussion', authenticateJWT, upload.array('images', 5), async (req, res) => {
  const { title, type, specialty, publish_date, tags, diagnosis, outcome, history, author } = req.body;

  if (!title || !type || !specialty || !publish_date || !tags || !diagnosis || !outcome || !history || !author) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  let parsedTags;
  try {
    parsedTags = JSON.parse(tags);
    if (!Array.isArray(parsedTags) || !parsedTags.every(item => typeof item === 'string')) {
      return res.status(400).json({ error: 'Tags must be an array of strings' });
    }
  } catch (error) {
    return res.status(400).json({ error: 'Invalid JSON format for tags: ' + error.message });
  }

  const caseDiscussion = {
    id: uuidv4(),
    title,
    type,
    specialty,
    publish_date,
    tags: parsedTags,
    diagnosis,
    outcome,
    history,
    author, // ✅ Added author from input field
    created_by: req.user.id,
    created_at: new Date().toISOString(),
    solved: false,
    view_count: 0,
    comment_count: 0,
    edit_logs: [],
  };

  if (req.files) {
    const imagePaths = [];
    for (const img of req.files) {
      const filename = `${uuidv4()}.png`;
      const filepath = path.join(__dirname, 'uploads/cases', filename);
      await sharp(img.buffer).png().toFile(filepath);
      imagePaths.push(filename);
    }
    caseDiscussion.images = imagePaths;
  }

  const { error } = await supabase.from('case_discussions').insert(caseDiscussion);
  if (error) {
    return res.status(500).json({ error: 'Failed to post case discussion: ' + error.message });
  }

  await supabase
    .from('profiles')
    .update({ no_of_case_discussions: req.user.no_of_case_discussions + 1 })
    .eq('id', req.user.id);

  res.json(caseDiscussion);
});


// Update Case Discussion
app.put('/case-discussion/:id', authenticateJWT, upload.array('images', 5), async (req, res) => {
  const { id } = req.params;
  const { title, type, specialty, publish_date, tags, diagnosis, outcome, solved, history } = req.body;

  const { data: existingCase, error: fetchError } = await supabase
    .from('case_discussions')
    .select('*')
    .eq('id', id)
    .single();

  if (fetchError || !existingCase) {
    return res.status(404).json({ error: 'Case not found' });
  }

  if (existingCase.created_by !== req.user.id && req.user.user_type !== 'superadmin') {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const updates = {};
  if (title) updates.title = title;
  if (type) updates.type = type;
  if (specialty) updates.specialty = specialty;
  if (publish_date) updates.publish_date = publish_date;
  if (diagnosis) updates.diagnosis = diagnosis;
  if (outcome) updates.outcome = outcome;
  if (history) updates.history = history;
  if (solved !== undefined) updates.solved = solved;

  if (tags) {
    try {
      const parsedTags = JSON.parse(tags);
      if (!Array.isArray(parsedTags) || !parsedTags.every(item => typeof item === 'string')) {
        return res.status(400).json({ error: 'Tags must be an array of strings' });
      }
      updates.tags = parsedTags;
    } catch (error) {
      return res.status(400).json({ error: 'Invalid JSON format for tags: ' + error.message });
    }
  }

  updates.edited_at = new Date().toISOString();

  const prevLogs = Array.isArray(existingCase.edit_logs) ? existingCase.edit_logs : [];
  updates.edit_logs = [...prevLogs, { timestamp: new Date().toISOString(), updated_by: req.user.id }];

  if (req.files && req.files.length > 0) {
    if (existingCase.images) {
      for (const img of existingCase.images) {
        await fs.unlink(path.join(__dirname, 'uploads/cases', img)).catch(() => {});
      }
    }
    const imagePaths = [];
    for (const img of req.files) {
      const filename = `${uuidv4()}.png`;
      const filepath = path.join(__dirname, 'uploads/cases', filename);
      await sharp(img.buffer).png().toFile(filepath);
      imagePaths.push(filename);
    }
    updates.images = imagePaths;
  }

  const { data, error } = await supabase
    .from('case_discussions')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    console.error("Update Error:", error);
    return res.status(500).json({ error: 'Failed to update case discussion: ' + error.message });
  }

  res.json(data);
});


// Get Case Discussion with Images
app.get('/case-discussion/:id', authenticateJWT, async (req, res) => {
  const { id } = req.params;

  try {
    // Fetch the case discussion
    const { data, error } = await supabase
      .from('case_discussions')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Case discussion not found' });
    }

    // Increment view count
    await supabase
      .from('case_discussions')
      .update({ view_count: data.view_count + 1 })
      .eq('id', id);

    // Build image URLs if any
    let imageUrls = [];
    if (data.images && data.images.length > 0) {
      imageUrls = data.images.map(
        (filename) => `http://localhost:3000/uploads/cases/${filename}`
      );
    }

    // Return combined response
    res.json({
      ...data,
      images: imageUrls.length > 0 ? imageUrls : [], // return empty array if no images
    });

  } catch (err) {
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});


// ✅ Mark Case Discussion as Solved
app.put('/case-discussion/:id/solve', authenticateJWT, async (req, res) => {
  try {
    const { id } = req.params;

    // Fetch case by ID
    const { data: caseData, error: fetchError } = await supabase
      .from('case_discussions')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError || !caseData) {
      return res.status(404).json({ error: 'Case not found' });
    }

    // Check ownership (only creator can solve)
    if (caseData.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Unauthorized: Only the case creator can mark as solved' });
    }

    // Update case as solved
    const { data, error } = await supabase
      .from('case_discussions')
      .update({ solved: true })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: 'Failed to update case: ' + error.message });
    }

    res.json({ message: 'Case marked as solved', case: data });
  } catch (err) {
    console.error('Mark Case Solved Error:', err);
    res.status(500).json({ error: 'Server error while marking case as solved' });
  }
});


// Get All Case Discussions
app.get('/case-discussions', authenticateJWT, async (req, res) => {
  const { data, error } = await supabase.from('case_discussions').select('*');
  if (error) {
    return res.status(500).json({ error: 'Failed to fetch case discussions: ' + error.message });
  }
  res.json(data);
});

// Delete Case Discussion
app.delete('/case-discussion/:id', authenticateJWT, async (req, res) => {
  const { id } = req.params;
  const { data: caseDiscussion } = await supabase
    .from('case_discussions')
    .select('created_by, images')
    .eq('id', id)
    .single();

  if (!caseDiscussion || (caseDiscussion.created_by !== req.user.id && req.user.user_type !== 'superadmin')) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  if (caseDiscussion.images) {
    for (const img of caseDiscussion.images) {
      await fs.unlink(path.join(__dirname, 'uploads/cases', img)).catch(() => {});
    }
  }

  const { error } = await supabase.from('case_discussions').delete().eq('id', id);
  if (error) {
    return res.status(500).json({ error: 'Failed to delete case discussion: ' + error.message });
  }

  if (caseDiscussion.created_by === req.user.id) {
    await supabase
      .from('profiles')
      .update({ no_of_case_discussions: req.user.no_of_case_discussions - 1 })
      .eq('id', req.user.id);
  }

  res.json({ message: 'Case discussion deleted successfully' });
});

// Post Comment (Research Paper or Case Discussion)
app.post('/:type/:id/comment', authenticateJWT, async (req, res) => {
  const { type, id } = req.params;
  const { content } = req.body;

  // Validate type (match your frontend routes)
  if (!['research-paper', 'case-discussion'].includes(type)) {
    return res.status(400).json({ error: 'Invalid comment type' });
  }

  // Validate content
  if (!content || typeof content !== 'string' || content.trim() === '') {
    return res.status(400).json({ error: 'Content is required and must be a non-empty string' });
  }

  // Validate UUID
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(id)) {
    return res.status(400).json({ error: 'Invalid parent ID format' });
  }

  // Map type to table
  const parentTable =
    type === 'research-paper' ? 'research_papers' : 'case_discussions';

  // Check if parent exists
  const { data: parentItem, error: parentError } = await supabase
    .from(parentTable)
    .select('comment_count')
    .eq('id', id)
    .single();

  if (parentError || !parentItem) {
    return res.status(404).json({ error: `${type} not found` });
  }

  // Create comment object
  const comment = {
    id: uuidv4(),
    parent_id: id,
    parent_type: type,
    content,
    created_by: req.user.id,
    created_at: new Date().toISOString(),
  };

  // Insert comment
  const { error: insertError } = await supabase.from('comments').insert(comment);
  if (insertError) {
    return res
      .status(500)
      .json({ error: 'Failed to post comment: ' + insertError.message });
  }

  // Update parent comment count
  await supabase
    .from(parentTable)
    .update({ comment_count: parentItem.comment_count + 1 })
    .eq('id', id);

  // Update user comment stats
  await supabase
    .from('profiles')
    .update({ no_of_comments_posted: req.user.no_of_comments_posted + 1 })
    .eq('id', req.user.id);

  // Emit event (keep event names consistent with type)
  io.emit(`${type}-comment`, { itemId: id, comment });

  res.json(comment);
});


// Get all comments for a specific parent (research-paper or case-discussion)
app.get('/:type/:id/comments', authenticateJWT, async (req, res) => {
  const { type, id } = req.params;

  // Validate type
  if (!['research-paper', 'case-discussion'].includes(type)) {
    return res.status(400).json({ error: 'Invalid comment type' });
  }

  // Validate UUID
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(id)) {
    return res.status(400).json({ error: 'Invalid parent ID format' });
  }

  try {
    // Fetch comments for this parent
    const { data: comments, error } = await supabase
      .from('comments')
      .select(`
        id,
        content,
        created_at,
        created_by,
        profiles!comments_created_by_fkey(name)
      `)
      .eq('parent_id', id)
      .eq('parent_type', type)
      .order('created_at', { ascending: true }); // oldest first

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch comments: ' + error.message });
    }

    res.json(comments);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});



//calculate total profiels registerd
app.get('/profiles/count', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id'); // fetch all IDs

    if (error) return res.status(500).json({ error: 'Failed to fetch profile count: ' + error.message });

    res.json({ totalProfiles: data.length });
  } catch (err) {
    res.status(500).json({ error: 'Unexpected error: ' + err.message });
  }
});


// Logout
app.post('/logout', authenticateJWT, async (req, res) => {
  await supabase
    .from('profiles')
    .update({
      online: false,
      login_logs: [...(req.user.login_logs || []), { type: 'logout', timestamp: new Date().toISOString() }],
    })
    .eq('email', req.user.email);

  res.json({ message: 'Logged out successfully' });
});


app.get("/", (req, res) => {
  res.send("Isa Nagpur acadamia project running");
});

const port = process.env.PORT || 3000;
server.listen(port, '0.0.0.0', () => {
  console.log(`Server running on port ${port}`);
});
