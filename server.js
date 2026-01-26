const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const Datastore = require('nedb-promises');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- إعداد قواعد البيانات ---
const db = {
    users: Datastore.create({ filename: 'users.db', autoload: true }),
    messages: Datastore.create({ filename: 'messages.db', autoload: true }),
    groups: Datastore.create({ filename: 'groups.db', autoload: true })
};

// ضمان عدم تكرار اسم المستخدم على مستوى قاعدة البيانات (إضافة أمان)
db.users.ensureIndex({ fieldName: 'username', unique: true });

// --- إعداد Multer ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = './public/uploads';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage, limits: { fileSize: 250 * 1024 * 1024 } });

app.use(express.static(__dirname + '/public'));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

let onlineUsers = {};

// تحديث القائمة (تظهر الأصدقاء فقط)
async function broadcastUserList(socket) {
    if (!socket.username) return;
    const user = await db.users.findOne({ username: socket.username });
    if (!user) return;
    const friends = user.friends || [];
    const list = friends.map(f => ({ username: f, isOnline: !!onlineUsers[f] }));
    socket.emit('update_user_list', list);
}

app.post(['/upload', '/upload-avatar'], upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false });
    res.json({ 
        success: true, 
        filePath: '/uploads/' + req.file.filename,
        avatarPath: '/uploads/' + req.file.filename,
        fileType: req.file.mimetype 
    });
});

io.on('connection', (socket) => {

    // 1. نظام الدخول والتسجيل (معدل بمنع تكرار صارم)
    socket.on('authenticate', async ({ username, password, email, isRegistering }) => {
        let user = await db.users.findOne({ username });

        if (isRegistering) {
            // التحقق قبل التسجيل لمنع الأسماء المتشابهة
            if (user) {
                return socket.emit('auth_error', 'اسم المستخدم هذا مأخوذ بالفعل');
            }
            
            try {
                const hashedPassword = await bcrypt.hash(password, 10);
                user = await db.users.insert({ 
                    username, 
                    password: hashedPassword, 
                    email: email || "", 
                    avatar: "/uploads/default-avatar.png", 
                    bio: "",
                    friends: [] 
                });
            } catch (err) {
                return socket.emit('auth_error', 'حدث خطأ أثناء التسجيل، ربما الاسم مستخدم بالفعل');
            }
        } else {
            if (!user || !(await bcrypt.compare(password, user.password))) {
                return socket.emit('auth_error', 'خطأ في اسم المستخدم أو كلمة المرور');
            }
        }

        socket.username = username;
        onlineUsers[username] = socket.id;
        socket.emit('auth_success', username);
        
        broadcastUserList(socket);
        socket.emit('update_group_list', await db.groups.find({ members: username }));
    });

    // 2. نظام طلب المصادقة (Friend Requests)
    socket.on('send_request', async (data) => {
        if (!socket.username) return;
        
        const targetUser = await db.users.findOne({ username: data.targetName });
        if (!targetUser) return socket.emit('error_msg', 'المستخدم غير موجود في النظام');
        if (targetUser.username === socket.username) return socket.emit('error_msg', 'لا يمكنك إضافة نفسك');

        const targetSocketId = onlineUsers[data.targetName];
        if (targetSocketId) {
            io.to(targetSocketId).emit('receive_request', { from: socket.username });
        } else {
            socket.emit('error_msg', 'المستخدم غير متصل حالياً لإرسال الطلب');
        }
    });

    socket.on('accept_request', async (data) => {
        if (!socket.username) return;
        
        // إضافة الطرفين لبعضهما في قاعدة البيانات
        await db.users.update({ username: socket.username }, { $addToSet: { friends: data.from } });
        await db.users.update({ username: data.from }, { $addToSet: { friends: socket.username } });

        // تحديث القائمة للطرفين فوراً
        broadcastUserList(socket);
        if (onlineUsers[data.from]) {
            const otherSocket = io.sockets.sockets.get(onlineUsers[data.from]);
            if (otherSocket) broadcastUserList(otherSocket);
        }
    });

    // 3. الملف الشخصي
    socket.on('get_profile', async (target) => {
        const u = await db.users.findOne({ username: target });
        if (u) socket.emit('profile_data', { 
            username: u.username, bio: u.bio || "لا يوجد وصف", 
            avatar: u.avatar || "/uploads/default-avatar.png", email: u.email 
        });
    });

    socket.on('update_profile', async (data) => {
        if (socket.username) await db.users.update({ username: socket.username }, { $set: data });
    });

    // 4. الرسائل والدردشة
    socket.on('chat_message', async (data) => {
        if (!socket.username) return;
        const msg = { ...data, from: socket.username, timestamp: new Date() };
        await db.messages.insert(msg);

        if (data.isGroup) {
            const group = await db.groups.findOne({ name: data.to });
            group?.members.forEach(m => onlineUsers[m] && io.to(onlineUsers[m]).emit('new_msg', msg));
        } else {
            if (onlineUsers[data.to]) io.to(onlineUsers[data.to]).emit('new_msg', msg);
            socket.emit('new_msg', msg);
        }
    });

    // 5. المجموعات
    socket.on('create_group', async (name) => {
        if (!socket.username) return;
        if (await db.groups.findOne({ name })) return socket.emit('auth_error', 'الاسم محجوز');
        await db.groups.insert({ name, admin: socket.username, members: [socket.username] });
        socket.emit('update_group_list', await db.groups.find({ members: socket.username }));
    });

    socket.on('add_member', async ({ groupName, userToAdd }) => {
        const gp = await db.groups.findOne({ name: groupName });
        if (gp?.admin !== socket.username) return;
        await db.groups.update({ name: groupName }, { $addToSet: { members: userToAdd } });
        if (onlineUsers[userToAdd]) io.to(onlineUsers[userToAdd]).emit('update_group_list', await db.groups.find({ members: userToAdd }));
    });

    socket.on('get_history', async ({ other, isGroup }) => {
        if (!socket.username) return;
        const query = isGroup ? { toGroup: other } : { $or: [{ from: socket.username, to: other }, { from: other, to: socket.username }] };
        socket.emit('chat_history', await db.messages.find(query).sort({ timestamp: 1 }));
    });

    socket.on('disconnect', () => { 
        if (socket.username) {
            delete onlineUsers[socket.username];
        }
    });
});

server.listen(3000, '0.0.0.0', () => console.log('Server running on port 3000'));