const socket = io();
const $ = id => document.getElementById(id);
let roomId = location.pathname.split("/").filter(Boolean)[0] || null;
let pendingCreate = false, player = null, currentVideo = null, isApplyingRemote = false;
let localStream = null, cameraOn = false, micOn = false, selfName = "";
let participants = new Map();

function show(id){$(id).classList.remove("hidden")}
function hide(id){$(id).classList.add("hidden")}
function enterRoom(){hide("home");hide("join");show("room");$("roomCode").textContent = "Комната " + roomId; }
function showJoin(){show("join");$("nickname").focus()}
$("createRoom").onclick = () => { pendingCreate = true; socket.emit("create-room", result => { roomId = result.roomId; history.pushState({}, "", "/" + roomId); showJoin(); }); };
$("closeJoin").onclick = () => { hide("join"); if (!roomId) show("home"); };
$("joinForm").onsubmit = e => {
  e.preventDefault(); selfName = $("nickname").value.trim();
  socket.emit("join-room", { roomId, name: selfName }, result => {
    if (!result.ok) { $("joinError").textContent = result.error; return; }
    enterRoom();
    participants.clear();
    result.state.participants.forEach(p => participants.set(p.id,p));
    renderParticipants();
    if (result.state.video) setVideo(result.state.video, result.state.playback);
  });
};
if (roomId) showJoin();

$("copyLink").onclick = async () => {
  try { await navigator.clipboard.writeText(location.href); $("copyLink").textContent = "Ссылка скопирована"; setTimeout(()=>$("copyLink").textContent="Копировать ссылку",1800); }
  catch { prompt("Скопируйте ссылку:", location.href); }
};

function setVideo(video, playback) {
  currentVideo = video; $("playerPlaceholder").classList.add("hidden");
  $("videoStatus").textContent = "YouTube · " + video.id;
  $("playPause").disabled = false;
  if (player && player.loadVideoById) {
    isApplyingRemote = true; player.loadVideoById(video.id); player.pauseVideo();
    setTimeout(()=>{ if(playback?.time) player.seekTo(playback.time,true); isApplyingRemote=false; },500);
  } else window.pendingVideo = video;
}
$("addVideo").onclick = () => {
  const url = $("videoUrl").value.trim();
  if (!url) return;
  socket.emit("set-video", url); $("videoUrl").value="";
};
socket.on("video-changed", ({video,playback}) => setVideo(video,playback));
socket.on("notice", msg => alert(msg));
window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player("player", {
    width:"100%", height:"100%", videoId: window.pendingVideo?.id || "",
    playerVars:{playsinline:1,rel:0},
    events:{ onReady: () => { if(window.pendingVideo) setVideo(window.pendingVideo,{time:0,playing:false}); } }
  });
};
function localTime(){return player?.getCurrentTime?.() || 0}
$("playPause").onclick = () => {
  if (!player || !currentVideo) return;
  const playing = player.getPlayerState() !== YT.PlayerState.PLAYING;
  socket.emit("playback",{playing,time:localTime()});
};
socket.on("playback", state => {
  if (!player || !currentVideo) return;
  isApplyingRemote = true;
  const target = state.time + (state.playing ? (Date.now()-state.updatedAt)/1000 : 0);
  if (Math.abs(localTime()-target)>1.4) player.seekTo(target,true);
  if(state.playing) player.playVideo(); else player.pauseVideo();
  $("playPause").textContent = state.playing ? "Ⅱ Пауза" : "▶ Воспроизвести";
  setTimeout(()=>isApplyingRemote=false,300);
});
// Periodically publish local player state changes; server arrival order decides the winner.
setInterval(() => {
  if (!player || !currentVideo || isApplyingRemote) return;
  const state = player.getPlayerState?.();
  if (state === YT.PlayerState.PLAYING || state === YT.PlayerState.PAUSED) {
    const playing = state === YT.PlayerState.PLAYING;
    if (window.lastPublishedPlaying !== playing || Math.floor(localTime()) !== window.lastPublishedSecond) {
      window.lastPublishedPlaying = playing; window.lastPublishedSecond = Math.floor(localTime());
      socket.emit("playback",{playing,time:localTime()});
    }
  }
},1500);

$("chatForm").onsubmit = e => { e.preventDefault(); const value=$("chatInput").value.trim(); if(value){socket.emit("chat",value);$("chatInput").value="";} };
socket.on("chat", msg => {
  const empty=document.querySelector(".chat-empty"); if(empty) empty.remove();
  const el=document.createElement("p"); el.className="message";
  const name=document.createElement("strong"); name.textContent=msg.name;
  const body=document.createElement("span"); body.textContent=msg.text;
  el.append(name,body); $("messages").append(el); $("messages").scrollTop=$("messages").scrollHeight;
});
$("toggleChat").onclick = () => { $("chatPanel").classList.toggle("collapsed"); $("toggleChat").textContent=$("chatPanel").classList.contains("collapsed")?"+":"−"; };
function renderParticipants(){
  $("participants").textContent=`Участники: ${participants.size}/5`;
  $("cameraLayer").innerHTML="";
  for(const p of participants.values()){
    const tile=document.createElement("div"); tile.className="camera-tile";
    tile.style.right=(14 + [...participants.keys()].indexOf(p.id)*12)+"px";
    const avatar=document.createElement("div"); avatar.className="camera-avatar"; avatar.textContent=(p.name||"?").slice(0,1).toUpperCase();
    const name=document.createElement("span"); name.className="camera-name"; name.textContent=p.name;
    tile.append(avatar,name); $("cameraLayer").append(tile);
  }
}
socket.on("room-state", state => { participants=new Map(state.participants.map(p=>[p.id,p])); renderParticipants(); });
socket.on("participant-joined", p=>{participants.set(p.id,p);renderParticipants();});
socket.on("participant-left", id=>{participants.delete(id);renderParticipants();});
socket.on("participant-media", update=>{const p=participants.get(update.id);if(p){Object.assign(p,update);renderParticipants();}});

async function toggleMedia(kind){
  const wantCamera = kind==="camera" ? !cameraOn : cameraOn;
  const wantMic = kind==="mic" ? !micOn : micOn;
  try{
    if((wantCamera||wantMic) && !localStream) localStream=await navigator.mediaDevices.getUserMedia({video:wantCamera,audio:wantMic});
    else if(localStream && (wantCamera||wantMic)){
      const tracks=localStream.getTracks();
      if(wantCamera && !tracks.some(t=>t.kind==="video")){const s=await navigator.mediaDevices.getUserMedia({video:true});s.getVideoTracks().forEach(t=>localStream.addTrack(t));}
      if(wantMic && !tracks.some(t=>t.kind==="audio")){const s=await navigator.mediaDevices.getUserMedia({audio:true});s.getAudioTracks().forEach(t=>localStream.addTrack(t));}
    }
    cameraOn=wantCamera;micOn=wantMic;
    localStream?.getVideoTracks().forEach(t=>t.enabled=cameraOn);
    localStream?.getAudioTracks().forEach(t=>t.enabled=micOn);
    $("cameraBtn").textContent=cameraOn?"Выключить камеру":"Включить камеру";
    $("micBtn").textContent=micOn?"Выключить микрофон":"Включить микрофон";
    $("mediaStatus").textContent="";
    socket.emit("media-state",{camera:cameraOn,mic:micOn});
  }catch(err){$("mediaStatus").textContent="Нет доступа к камере/микрофону. Проверьте разрешения браузера.";}
}
$("cameraBtn").onclick=()=>toggleMedia("camera");
$("micBtn").onclick=()=>toggleMedia("mic");
socket.on("connect_error",()=>{$("mediaStatus").textContent="Нет соединения с сервером.";});
