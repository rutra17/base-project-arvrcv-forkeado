/**
 * cv.js – Lógica cliente para a interface de Visão Computacional
 *
 * Responsabilidades:
 *  - Acesso à webcam (getUserMedia)
 *  - Captura de frames e envio ao servidor via Socket.IO
 *  - Exibição dos resultados processados (imagem + detecções)
 *  - Suporte a upload de imagem estática
 */

"use strict";

/* ── Estado ── */
let socket        = null;
let camStream     = null;
let captureTimer  = null;
let currentPipeline = "edges";
let frameCount    = 0;
let lastFpsTime   = Date.now();
let waitingResult = false;

/* ── Elementos DOM ── */
const statusDot   = document.getElementById("statusDot");
const statusText  = document.getElementById("statusText");
const logPanel    = document.getElementById("logPanel");
const webcamVideo = document.getElementById("webcamVideo");
const captureCanvas = document.getElementById("captureCanvas");
const uploadedImg = document.getElementById("uploadedImg");
const noSignal    = document.getElementById("noSignal");
const resultImg   = document.getElementById("resultImg");
const noResult    = document.getElementById("noResult");
const fpsBadge    = document.getElementById("fpsBadge");
const fpsRange    = document.getElementById("fpsRange");
const fpsVal      = document.getElementById("fpsVal");
const detectionsList = document.getElementById("detectionsList");
const detCount    = document.getElementById("detCount");
const btnStartCam = document.getElementById("btnStartCam");
const btnStopCam  = document.getElementById("btnStopCam");

/* ── Utilitários ── */
function log(msg, type = "info") {
  const p = document.createElement("p");
  p.className = type;
  p.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  logPanel.appendChild(p);
  logPanel.scrollTop = logPanel.scrollHeight;
  if (logPanel.children.length > 80) logPanel.removeChild(logPanel.firstChild);
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

fpsRange.addEventListener("input", () => {
  fpsVal.textContent = fpsRange.value;
  if (captureTimer) restartCaptureLoop();
});

/* ── Pipelines ── */
function setPipeline(btn) {
  document.querySelectorAll(".pipeline-btn").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  currentPipeline = btn.dataset.pipeline;
  log(`Pipeline: ${currentPipeline}`);
  // Se não há câmera ligada mas há imagem carregada, processa novamente
  if (!camStream && uploadedImg.style.display !== "none") {
    sendImageFromElement(uploadedImg);
  }
}

/* ── Câmera ── */
async function startCamera() {
  try {
    camStream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
    webcamVideo.srcObject = camStream;
    webcamVideo.style.display = "block";
    uploadedImg.style.display = "none";
    noSignal.style.display = "none";
    fpsBadge.style.display = "block";
    btnStartCam.disabled = true;
    btnStopCam.disabled = false;
    log("Câmera iniciada.");
    startCaptureLoop();
  } catch (err) {
    log(`Erro ao acessar câmera: ${err.message}`, "error");
  }
}

function stopCamera() {
  if (camStream) {
    camStream.getTracks().forEach(t => t.stop());
    camStream = null;
  }
  clearInterval(captureTimer);
  captureTimer = null;
  webcamVideo.style.display = "none";
  webcamVideo.srcObject = null;
  noSignal.style.display = "flex";
  fpsBadge.style.display = "none";
  btnStartCam.disabled = false;
  btnStopCam.disabled = true;
  log("Câmera parada.");
}

function startCaptureLoop() {
  const fps = parseInt(fpsRange.value, 10);
  const interval = Math.floor(1000 / fps);
  captureTimer = setInterval(captureAndSend, interval);
}

function restartCaptureLoop() {
  clearInterval(captureTimer);
  startCaptureLoop();
}

function captureAndSend() {
  if (!socket || !socket.connected || waitingResult) return;
  if (!camStream || webcamVideo.readyState < 2) return;

  const ctx = captureCanvas.getContext("2d");
  captureCanvas.width  = webcamVideo.videoWidth  || 640;
  captureCanvas.height = webcamVideo.videoHeight || 480;
  ctx.drawImage(webcamVideo, 0, 0, captureCanvas.width, captureCanvas.height);

  const dataUrl = captureCanvas.toDataURL("image/jpeg", 0.8);
  sendFrame(dataUrl);
}

/* ── Upload de imagem ── */
function loadImageFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    uploadedImg.src = e.target.result;
    uploadedImg.style.display = "block";
    webcamVideo.style.display = "none";
    noSignal.style.display = "none";
    fpsBadge.style.display = "none";
    log(`Imagem carregada: ${file.name}`);
    sendImageFromElement(uploadedImg);
  };
  reader.readAsDataURL(file);
}

function sendImageFromElement(imgEl) {
  const offscreen = document.createElement("canvas");
  offscreen.width  = imgEl.naturalWidth  || imgEl.width  || 640;
  offscreen.height = imgEl.naturalHeight || imgEl.height || 480;
  const ctx = offscreen.getContext("2d");
  ctx.drawImage(imgEl, 0, 0, offscreen.width, offscreen.height);
  const dataUrl = offscreen.toDataURL("image/jpeg", 0.9);
  sendFrame(dataUrl);
}

/* ── Envio e recepção ── */
function sendFrame(dataUrl) {
  if (!socket || !socket.connected) return;
  waitingResult = true;
  socket.emit("cv_frame", { image: dataUrl, pipeline: currentPipeline });
}

/* ── Socket.IO ── */
function initSocket() {
  socket = io({ transports: ["websocket"] });

  socket.on("connect", () => {
    statusDot.classList.add("connected");
    statusText.textContent = "Conectado";
    log("Conectado ao servidor WebSocket.");
    socket.emit("join_cv");
  });

  socket.on("disconnect", () => {
    statusDot.classList.remove("connected");
    statusText.textContent = "Desconectado";
    log("Desconectado do servidor.", "warning");
  });

  socket.on("cv_ready", ({ message }) => {
    log(`Servidor: ${message}`);
  });

  socket.on("cv_result", (data) => {
    waitingResult = false;

    if (data.error) {
      log(`Erro no servidor: ${data.error}`, "error");
      return;
    }

    // Exibe imagem resultado
    resultImg.src = data.image;
    resultImg.style.display = "block";
    noResult.style.display = "none";

    // Atualiza detecções
    renderDetections(data.detections || []);

    // Atualiza FPS
    frameCount++;
    const now = Date.now();
    if (now - lastFpsTime >= 1000) {
      fpsBadge.textContent = `${frameCount} fps`;
      frameCount = 0;
      lastFpsTime = now;
    }
  });
}

/* ── Renderiza detecções ── */
const DETECTION_ICONS = {
  info:     "ℹ️",
  contours: "🔷",
  faces:    "😊",
  color:    "🎨",
  hands:    "✋",
  pose:     "🦴",
};

function renderDetections(detections) {
  detCount.textContent = detections.length;
  if (detections.length === 0) {
    detectionsList.innerHTML = `<div style="color:var(--text-muted);font-size:.85rem;padding:.5rem">Nenhuma detecção.</div>`;
    return;
  }
  detectionsList.innerHTML = detections.map(det => {
    const icon = DETECTION_ICONS[det.type] || "📌";
    const countBadge = det.count !== undefined
      ? `<span class="det-count">${Number(det.count)}</span>` : "";
    return `
      <div class="detection-item">
        <span class="det-icon">${icon}</span>
        <span class="det-text">${escHtml(det.text)}</span>
        ${countBadge}
      </div>`;
  }).join("");
}

/* ── Inicialização ── */
document.addEventListener("DOMContentLoaded", initSocket);
