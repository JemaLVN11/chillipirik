const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const rooms = new Map();
const PORT = process.env.PORT || 3000;
const MAX_PEERS = 5;

app.use(express.static("public"));
app.get("/health", (_, res) => res.json({ ok: true }));
const path = require("path");

app.get("/:roomId", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
function makeRoomId() {
  return crypto.randomBytes(5).toString("base64url");
}
function publicRoom(room) {
  return {
    video: room.video,
    playback: room.playback,
    participants: [...room.participants.values()].map(p => ({
      id: p.id, name: p.name, camera: p.camera, mic: p.mic
    }))
  };
}
function leaveRoom(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (room) {
    room.participants.delete(socket.id);
    socket.to(roomId).emit("participant-left", socket.id);
    if (room.participants.size === 0) rooms.delete(roomId);
    else io.to(roomId).emit("room-state", publicRoom(room));
  }
  socket.leave(roomId);
  socket.data.roomId = null;
}
io.on("connection", socket => {
  socket.on("create-room", ack => {
    let id;
    do { id = makeRoomId(); } while (rooms.has(id));
    rooms.set(id, { video: null, playback: { playing: false, time: 0, updatedAt: Date.now() }, participants: new Map() });
    if (typeof ack === "function") ack({ roomId: id });
  });

  socket.on("join-room", ({ roomId, name }, ack) => {
    const room = rooms.get(roomId);
    if (!room) return ack?.({ ok: false, error: "Комната не найдена или уже закрыта." });
    if (room.participants.size >= MAX_PEERS) return ack?.({ ok: false, error: "В комнате уже 5 участников." });
    const cleanName = String(name || "").trim().slice(0, 24);
    if (!cleanName) return ack?.({ ok: false, error: "Введите никнейм." });

    const existing = [...room.participants.values()].map(p => ({ id: p.id, name: p.name, camera: p.camera, mic: p.mic }));
    const participant = { id: socket.id, name: cleanName, camera: false, mic: false };
    room.participants.set(socket.id, participant);
    socket.join(roomId);
    socket.data.roomId = roomId;
    ack?.({ ok: true, self: participant, existing, state: publicRoom(room) });
    socket.to(roomId).emit("participant-joined", participant);
    io.to(roomId).emit("room-state", publicRoom(room));
  });

  socket.on("set-video", url => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const parsed = parseVideoUrl(url);
    if (!parsed) return socket.emit("notice", "Пока поддерживаются ссылки YouTube.");
    room.video = parsed;
    room.playback = { playing: false, time: 0, updatedAt: Date.now() };
    io.to(socket.data.roomId).emit("video-changed", { video: room.video, playback: room.playback });
  });

  socket.on("playback", command => {
    const room = rooms.get(socket.data.roomId);
    if (!room || !room.video) return;
    const time = Math.max(0, Number(command.time) || 0);
    room.playback = { playing: !!command.playing, time, updatedAt: Date.now() };
    io.to(socket.data.roomId).emit("playback", room.playback);
  });

  socket.on("chat", message => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const participant = room.participants.get(socket.id);
    const text = String(message || "").trim().slice(0, 1000);
    if (!participant || !text) return;
    io.to(socket.data.roomId).emit("chat", {
      id: crypto.randomUUID(), name: participant.name, text, at: Date.now()
    });
  });

  socket.on("media-state", state => {
    const room = rooms.get(socket.data.roomId);
    const p = room?.participants.get(socket.id);
    if (!p) return;
    p.camera = !!state.camera;
    p.mic = !!state.mic;
    io.to(socket.data.roomId).emit("participant-media", { id: socket.id, camera: p.camera, mic: p.mic });
  });

  socket.on("signal", ({ to, data }) => {
    if (to && data) io.to(to).emit("signal", { from: socket.id, data });
  });
  socket.on("disconnect", () => leaveRoom(socket));
});

function parseVideoUrl(raw) {
  try {
    const u = new URL(String(raw));
    let id = null;
    if (u.hostname === "youtu.be") id = u.pathname.slice(1);
    if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(u.hostname)) {
      id = u.searchParams.get("v");
      if (!id && u.pathname.startsWith("/embed/")) id = u.pathname.split("/")[2];
    }
    if (!id || !/^[\w-]{6,}$/.test(id)) return null;
    return { provider: "youtube", id };
  } catch { return null; }
}

server.listen(PORT, () => console.log(`Чиллипирик запущен: http://localhost:${PORT}`));
