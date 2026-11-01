// Server game Caro - không cần cài thêm thư viện. Chạy: node server.js
const http = require('http'),
    fs = require('fs'),
    path = require('path'),
    crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'; // ĐỔI mật khẩu này!
const DATA_DIR = process.env.DATA_DIR || __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });
const FILE = path.join(DATA_DIR, 'data.json');

let db = { users: {}, rooms: {} };
try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {}
db.users = db.users || {};
db.rooms = db.rooms || {};
if (!db.users.admin) db.users.admin = { name: 'Admin', avatar: '👑', token: '', streak: 0, best: 0, wins: 0, losses: 0, isAdmin: true };

let timer = null;

function saveNow() {
    clearTimeout(timer);
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(db));
    fs.renameSync(FILE + '.tmp', FILE);
}

function save() {
    clearTimeout(timer);
    timer = setTimeout(saveNow, 300);
}
['SIGINT', 'SIGTERM'].forEach(s => process.on(s, () => {
    saveNow();
    process.exit(0);
}));
saveNow();

const clients = {}; // code -> Set(res)
const WIN = { 3: 3, 5: 4 }; // số quân liên tiếp để thắng

const pub = u => u && ({ name: u.name, avatar: u.avatar, streak: u.streak, best: u.best, wins: u.wins, losses: u.losses, admin: !!u.isAdmin });
const key = n => String(n).trim().toLowerCase();

function view(r) {
    return {
        code: r.code,
        size: r.size,
        win: r.win,
        board: r.board,
        turn: r.turn,
        status: r.status,
        game: r.game,
        winner: r.winner,
        draw: r.draw,
        line: r.line,
        left: !!r.left,
        inf: !!r.inf,
        moves: r.inf ? (r.moves || []) : [],
        players: r.players.map(k => k ? pub(db.users[k]) : null),
        viewers: clients[r.code] ? clients[r.code].size : 0
    };
}

function broadcast(r) {
    const set = clients[r.code];
    if (!set) return;
    const s = 'data: ' + JSON.stringify(view(r)) + '\n\n';
    set.forEach(res => res.write(s));
}

function checkWin(r, i) {
    const n = r.size,
        m = r.board[i],
        x = i % n,
        y = (i / n) | 0;
    for (const [dx, dy] of[[1, 0], [0, 1], [1, 1], [1, -1]]) {
        const line = [i];
        for (const s of[1, -1]) {
            let cx = x + dx * s,
                cy = y + dy * s;
            while (cx >= 0 && cy >= 0 && cx < n && cy < n && r.board[cy * n + cx] === m) {
                line.push(cy * n + cx);
                cx += dx * s;
                cy += dy * s;
            }
        }
        if (line.length >= r.win) return line;
    }
    return null;
}

function checkInf(r, x, y) {
    const m = r.cells[x + ',' + y];
    for (const [dx, dy] of[[1, 0], [0, 1], [1, 1], [1, -1]]) {
        const line = [
            [x, y]
        ];
        for (const s of[1, -1]) {
            let cx = x + dx * s,
                cy = y + dy * s;
            while (r.cells[cx + ',' + cy] === m) {
                line.push([cx, cy]);
                cx += dx * s;
                cy += dy * s;
            }
        }
        if (line.length >= r.win) return line;
    }
    return null;
}

function finish(r, winnerKey, line) {
    r.status = 'done';
    r.line = line || [];
    if (winnerKey) {
        r.winner = winnerKey;
        const w = db.users[winnerKey],
            l = db.users[r.players.find(k => k && k !== winnerKey)];
        if (w) {
            w.wins++;
            w.streak++;
            w.best = Math.max(w.best, w.streak);
        }
        if (l) {
            l.losses++;
            l.streak = 0;
        }
    } else r.draw = true;
    save();
}

function newCode() {
    if (Object.keys(db.rooms).length > 9000)
        for (const c in db.rooms)
            if (db.rooms[c].status === 'done' && !(clients[c] && clients[c].size)) delete db.rooms[c];
    let c;
    do { c = String(Math.floor(Math.random() * 10000)).padStart(4, '0'); } while (db.rooms[c]);
    return c;
}

function removeRoom(r) {
    const set = clients[r.code];
    if (set) { set.forEach(res => res.write('data: {"closed":true}\n\n')); }
    delete db.rooms[r.code];
    save();
}

function resetBoard(r) {
    r.board = Array(r.size * r.size).fill('');
    r.cells = {};
    r.moves = [];
    r.turn = 0;
    r.winner = null;
    r.draw = false;
    r.line = [];
    r.left = null;
    r.game++;
}

const routes = {
    'POST /api/login' (req, u, b) {
        const name = String(b.name || '').trim().replace(/\s+/g, ' ');
        if (name.length < 2 || name.length > 16) return [400, { error: 'Tên phải từ 2 đến 16 ký tự' }];
        const k = key(name);
        if (k === 'admin') return [400, { error: 'Tên này được dành riêng' }];
        const avatar = String(b.avatar || '🙂');
        if (avatar.length > 60000) return [400, { error: 'Ảnh quá lớn' }];
        let ex = db.users[k];
        if (ex) {
            if (!b.token || b.token !== ex.token) return [400, { error: 'Tên đã có người dùng, hãy chọn tên khác' }];
            ex.avatar = avatar;
            save();
            return [200, { token: ex.token, me: pub(ex) }];
        }
        const token = crypto.randomBytes(16).toString('hex');
        ex = db.users[k] = { name, avatar, token, streak: 0, best: 0, wins: 0, losses: 0 };
        save();
        return [200, { token, me: pub(ex) }];
    },
    'POST /api/admin-login' (req, u, b) {
        if (b.password !== ADMIN_PASSWORD) return [403, { error: 'Sai mật khẩu admin' }];
        const a = db.users.admin;
        a.token = crypto.randomBytes(16).toString('hex');
        save();
        return [200, { token: a.token, me: pub(a) }];
    },
    'GET /api/me' (req, u) { return u ? [200, { me: pub(u) }] : [401, { error: 'auth' }]; },
    'GET /api/leaderboard' () {
        const list = Object.values(db.users).filter(x => x.best > 0 || x.wins > 0).sort((a, b) => b.best - a.best || b.wins - a.wins).slice(0, 20).map(pub);
        return [200, { list }];
    },
    'POST /api/room/create' (req, u, b) {
        if (!u) return [401, {}];
        const inf = b.size === 'inf',
            size = inf ? 0 : 3,
            code = newCode();
        const r = db.rooms[code] = { code, size, inf, win: inf ? 5 : WIN[size], board: [], cells: {}, moves: [], turn: 0, status: 'waiting', game: 1, winner: null, draw: false, line: [], players: [key(u.name), null], left: null };
        resetBoard(r);
        r.game = 1;
        save();
        return [200, { code }];
    },
    'POST /api/room/join' (req, u, b) {
        if (!u) return [401, {}];
        const r = db.rooms[String(b.code)];
        if (!r) return [404, { error: 'Không tìm thấy phòng' }];
        const k = key(u.name);
        if (!r.players.includes(k) && !r.players[1] && !r.left) {
            r.players[1] = k;
            if (r.status === 'waiting') r.status = 'playing';
            save();
            broadcast(r);
        }
        return [200, { code: r.code, player: r.players.includes(k) }];
    },
    'POST /api/room/move' (req, u, b) {
        if (!u) return [401, {}];
        const r = db.rooms[String(b.code)];
        if (!r) return [404, {}];
        const k = key(u.name);
        if (r.status !== 'playing' || r.players[r.turn] !== k) return [400, { error: 'Không hợp lệ' }];
        if (r.inf) { // bàn cờ vô hạn
            const x = Math.trunc(+b.x),
                y = Math.trunc(+b.y);
            if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 100000 || Math.abs(y) > 100000 || r.cells[x + ',' + y]) return [400, { error: 'Không hợp lệ' }];
            const m = r.turn === 0 ? 'X' : 'O';
            r.cells[x + ',' + y] = m;
            r.moves.push([x, y, m]);
            const line = checkInf(r, x, y);
            if (line) finish(r, k, line);
            else r.turn = 1 - r.turn;
        } else {
            const i = +b.i;
            if (!(i >= 0 && i < r.board.length) || r.board[i]) return [400, { error: 'Không hợp lệ' }];
            r.board[i] = r.turn === 0 ? 'X' : 'O';
            const line = checkWin(r, i);
            if (line) finish(r, k, line);
            else if (r.board.every(c => c)) finish(r, null);
            else r.turn = 1 - r.turn;
        }
        save();
        broadcast(r);
        return [200, {}];
    },
    'POST /api/room/rematch' (req, u, b) {
        if (!u) return [401, {}];
        const r = db.rooms[String(b.code)];
        if (!r || r.status !== 'done' || r.left || !r.players.includes(key(u.name)) || !r.players[1]) return [400, {}];
        r.players.reverse();
        resetBoard(r);
        r.status = 'playing';
        save();
        broadcast(r);
        return [200, {}];
    },
    'POST /api/room/leave' (req, u, b) {
        if (!u) return [401, {}];
        const r = db.rooms[String(b.code)];
        if (!r) return [200, {}];
        const k = key(u.name),
            idx = r.players.indexOf(k);
        if (idx < 0) return [200, {}];
        if (r.status === 'playing') {
            r.left = k;
            finish(r, r.players[1 - idx]);
            broadcast(r);
        } else if (r.status === 'waiting' || r.left) removeRoom(r);
        else { // đã xong ván, 1 người rời
            r.players[idx] = null;
            if (!r.players[0]) r.players.reverse();
            resetBoard(r);
            r.status = 'waiting';
            save();
            broadcast(r);
        }
        return [200, {}];
    },
    'GET /api/admin/data' (req, u) {
        if (!u || !u.isAdmin) return [403, {}];
        return [200, { users: Object.values(db.users).map(pub), rooms: Object.values(db.rooms).map(view) }];
    },
    'POST /api/admin/reset-streak' (req, u, b) {
        if (!u || !u.isAdmin) return [403, {}];
        const t = db.users[key(b.name)];
        if (t) {
            t.streak = 0;
            t.best = 0;
            save();
        }
        return [200, {}];
    },
    'POST /api/admin/delete-user' (req, u, b) {
        if (!u || !u.isAdmin) return [403, {}];
        const k = key(b.name);
        if (k === 'admin') return [400, { error: 'Không thể xóa admin' }];
        for (const r of Object.values(db.rooms))
            if (r.players.includes(k)) removeRoom(r); // đóng phòng của người bị xóa
        delete db.users[k];
        save();
        return [200, {}];
    },
    'POST /api/admin/set-streak' (req, u, b) {
        if (!u || !u.isAdmin) return [403, {}];
        const t = db.users[key(b.name)];
        if (!t) return [404, { error: 'Không thấy người chơi' }];
        const n = v => Math.max(0, Math.min(1000000, Math.trunc(+v) || 0));
        t.streak = n(b.streak);
        t.best = Math.max(n(b.best), t.streak);
        save();
        return [200, { user: pub(t) }];
    },
    'POST /api/admin/close-room' (req, u, b) {
        if (!u || !u.isAdmin) return [403, {}];
        const r = db.rooms[String(b.code)];
        if (r) removeRoom(r);
        return [200, {}];
    }
};

function userFrom(token) {
    if (!token) return null;
    return Object.values(db.users).find(x => x.token && x.token === token) || null;
}

http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const token = req.headers['x-token'] || url.searchParams.get('token');
    const u = userFrom(token);

    if (url.pathname === '/api/events') {
        const r = db.rooms[url.searchParams.get('code')];
        if (!r) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        (clients[r.code] = clients[r.code] || new Set()).add(res);
        broadcast(r);
        const hb = setInterval(() => res.write(': ping\n\n'), 20000);
        req.on('close', () => {
            clearInterval(hb);
            clients[r.code] && clients[r.code].delete(res);
            const rr = db.rooms[r.code];
            if (rr) broadcast(rr);
        });
        return;
    }

    const h = routes[req.method + ' ' + url.pathname];
    if (h) {
        let body = '';
        req.on('data', c => { body += c; if (body.length > 200000) req.destroy(); });
        req.on('end', () => {
            let b = {};
            try { b = body ? JSON.parse(body) : {}; } catch (e) {}
            const [code, data] = h(req, u, b);
            res.writeHead(code, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
        });
        return;
    }
    fs.readFile(path.join(__dirname, 'public', 'index.html'), (e, d) => {
        res.writeHead(e ? 500 : 200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(d || 'Lỗi');
    });
}).listen(PORT, () => console.log('Caro chạy tại http://localhost:' + PORT + ' | mật khẩu admin: ' + ADMIN_PASSWORD));