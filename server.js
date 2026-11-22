
const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MAX_PEERS = 5;

const rooms = new Map();

// Раздаём файлы сайта из папки public
app.use(express.static(path.join(__dirname, "public")));

// Проверка работоспособности сервера
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// Главная страница
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Страница любой комнаты, например /abc123
app.get("/:roomId", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Создание комнаты
function createRoom() {
  return {
    id: crypto.randomBytes(5).toString("hex"),
    peers: new Map(),
    video: null,
    playing: false,
    currentTime: 0,
    updatedAt: Date.now()
  };
}

// Получение комнаты
function getRoom(roomId) {
  return rooms.get(roomId);
}

// Отправка списка участников
function broadcastPeers(room) {
  const peers = Array.from(room.peers.values()).map(peer => ({
    id: peer.id,
    nickname: peer.nickname,
    cameraOn: peer.cameraOn || false,
    micOn: peer.micOn || false
  }));

  io.to(room.id).emit("peers", peers);
}

// Отправка состояния видео
function broadcastVideo(room) {
  io.to(room.id).emit("video-state", {
    video: room.video,
    playing: room.playing,
    currentTime: room.currentTime
  });
}

io.on("connection", socket => {
  let currentRoom = null;
  let currentPeer = null;

  // Создание новой комнаты
  socket.on("create-room", callback => {
    const room = createRoom();
    rooms.set(room.id, room);

    if (typeof callback === "function") {
      callback({ roomId: room.id });
    }
  });

  // Вход в комнату
  socket.on("join-room", ({ roomId, nickname }, callback) => {
    const room = getRoom(roomId);

    if (!room) {
      if (typeof callback === "function") {
        callback({ ok: false, error: "Комната не найдена" });
      }
      return;
    }

    if (room.peers.size >= MAX_PEERS) {
      if (typeof callback === "function") {
        callback({ ok: false, error: "В комнате уже 5 участников" });
      }
      return;
    }

    const peer = {
      id: socket.id,
      nickname: String(nickname || "Гость").slice(0, 24),
      cameraOn: false,
      micOn: false
    };

    currentRoom = room;
    currentPeer = peer;

    room.peers.set(socket.id, peer);
    socket.join(room.id);

    if (typeof callback === "function") {
      callback({
        ok: true,
        roomId: room.id,
        peerId: socket.id,
        video: room.video,
        playing: room.playing,
        currentTime: room.currentTime
      });
    }

    broadcastPeers(room);
    broadcastVideo(room);
  });

  // Добавить или заменить видео
  socket.on("set-video", videoUrl => {
    if (!currentRoom || !currentPeer) return;

    currentRoom.video = String(videoUrl || "").trim() || null;
    currentRoom.playing = false;
    currentRoom.currentTime = 0;
    currentRoom.updatedAt = Date.now();

    broadcastVideo(currentRoom);
  });

  // Управление воспроизведением
  socket.on("play", currentTime => {
    if (!currentRoom) return;

    currentRoom.playing = true;

    if (Number.isFinite(Number(currentTime))) {
      currentRoom.currentTime = Math.max(0, Number(currentTime));
    }

    currentRoom.updatedAt = Date.now();
    broadcastVideo(currentRoom);
  });

  socket.on("pause", currentTime => {
    if (!currentRoom) return;

    currentRoom.playing = false;

    if (Number.isFinite(Number(currentTime))) {
      currentRoom.currentTime = Math.max(0, Number(currentTime));
    }

    currentRoom.updatedAt = Date.now();
    broadcastVideo(currentRoom);
  });

  // Перемотка
  socket.on("seek", currentTime => {
    if (!currentRoom) return;

    const time = Number(currentTime);
    if (!Number.isFinite(time)) return;

    currentRoom.currentTime = Math.max(0, time);
    currentRoom.updatedAt = Date.now();

    broadcastVideo(currentRoom);
  });

  // Остановка и удаление видео
  socket.on("stop-video", () => {
    if (!currentRoom) return;

    currentRoom.video = null;
    currentRoom.playing = false;
    currentRoom.currentTime = 0;
    currentRoom.updatedAt = Date.now();

    broadcastVideo(currentRoom);
  });

  // Сообщения чата
  socket.on("chat-message", message => {
    if (!currentRoom || !currentPeer) return;

    const text = String(message || "").trim().slice(0, 1000);
    if (!text) return;

    io.to(currentRoom.id).emit("chat-message", {
      id: crypto.randomBytes(6).toString("hex"),
      nickname: currentPeer.nickname,
      message: text,
      timestamp: Date.now()
    });
  });

  // Состояние камеры и микрофона
  socket.on("media-state", state => {
    if (!currentRoom || !currentPeer) return;

    currentPeer.cameraOn = Boolean(state?.cameraOn);
    currentPeer.micOn = Boolean(state?.micOn);

    broadcastPeers(currentRoom);
  });

  // Передача WebRTC-сигналов между участниками
  socket.on("signal", ({ target, signal }) => {
    if (!currentRoom || !target || !signal) return;

    io.to(target).emit("signal", {
      from: socket.id,
      signal
    });
  });

  // Отключение участника
  socket.on("disconnect", () => {
    if (!currentRoom || !currentPeer) return;

    currentRoom.peers.delete(socket.id);

    if (currentRoom.peers.size === 0) {
      rooms.delete(currentRoom.id);
    } else {
      broadcastPeers(currentRoom);
    }
  });
});

// Запуск сервера
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Чиллипирик запущен на порту ${PORT}`);
});
