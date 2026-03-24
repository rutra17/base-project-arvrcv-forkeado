/**
 * worldgen.js – AI World Generator
 *
 * Envia um prompt ao servidor, que chama a API da OpenAI para gerar
 * código A-Frame. O HTML resultante é renderizado em um iframe sandboxed.
 */

"use strict";

/* ── Estado ── */
let socket = null;
let currentHtml = "";
let currentPrompt = "";
let currentSceneJSON = null;
let worldRenderer = null;
let gallery = [];

/* ── DOM ── */
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const logPanel = document.getElementById("logPanel");
const promptInput = document.getElementById("promptInput");
const modelSelect = document.getElementById("modelSelect");
const btnGenerate = document.getElementById("btnGenerate");
const charCount = document.getElementById("charCount");
const sceneFrame = document.getElementById("sceneFrame");
const canvasContainer = document.getElementById("canvasContainer");
const scenePlaceholder = document.getElementById("scenePlaceholder");
const generatingOverlay = document.getElementById("generatingOverlay");
const genMessage = document.getElementById("genMessage");
const sceneOverlay = document.getElementById("sceneOverlay");
const promptBadge = document.getElementById("promptBadge");
const codePreview = document.getElementById("codePreview");
const tokensCard = document.getElementById("tokensCard");
const tokPrompt = document.getElementById("tokPrompt");
const tokCompletion = document.getElementById("tokCompletion");
const tokTotal = document.getElementById("tokTotal");
const galleryList = document.getElementById("galleryList");
const galleryCount = document.getElementById("galleryCount");
const engineSelect = document.getElementById("engineSelect");
const btnShare = document.getElementById("btnShare");
const btnFullscreen = document.getElementById("btnFullscreen");
const btnDownload = document.getElementById("btnDownload");

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
    .replace(/"/g, "&quot;");
}

/* ── Contagem de caracteres ── */
promptInput.addEventListener("input", () => {
  charCount.textContent = `${promptInput.value.length}/2000`;
});

/* ── Enviar com Ctrl+Enter ── */
promptInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    generateWorld();
  }
});

/* ── Exemplos de prompt ── */
const EXAMPLE_PROMPTS = {
  "Floresta encantada":
    "Uma floresta encantada à noite com árvores altas e luminosas, cogumelos gigantes brilhantes em cores neon, um lago espelhado refletindo a lua cheia, vaga-lumes flutuando no ar e um caminho de pedras iluminado.",
  "Cidade futurista cyberpunk":
    "Uma cidade cyberpunk futurista com arranha-céus neon azul e roxo, ruas flutuantes, hologramas no ar, carros voadores representados por caixas brilhantes, chuva de partículas e um céu noturno vermelho escuro.",
  "Fundo do oceano":
    "O fundo do oceano com corais coloridos, peixes geométricos nadando, bolhas subindo, uma tartaruga marinha gigante, algas balançando, um navio naufragado e raios de luz penetrando a superfície azul.",
  "Sistema solar":
    "O sistema solar com o Sol brilhante no centro, todos os 8 planetas orbitando em diferentes distâncias, anéis de Saturno, um cinturão de asteroides, e fundo de estrelas.",
  "Castelo medieval":
    "Um castelo medieval em uma colina com torres altas, muralhas de pedra, um fosso com água, uma ponte levadiça, bandeiras coloridas, tochas de fogo nas paredes e montanhas ao fundo com neve.",
  "Sala de estar moderna":
    "Uma sala de estar moderna e minimalista com sofá em L cinza, mesa de centro de vidro, TV na parede, estante de livros, tapete geométrico, luminária de piso, janela grande com vista para a cidade e plantas decorativas.",
  "Parque de diversões":
    "Um parque de diversões colorido com roda-gigante girando, montanha-russa com trilhos, tenda de circo listrada, carrossel com cavalos, pipoqueiras, balões flutuando e luzes neon por toda parte.",
  "Vulcão em erupção":
    "Um vulcão em erupção com lava escorrendo pelas encostas, rochas voando, fumaça subindo, um lago de lava na cratera, terreno rochoso ao redor, céu vermelho alaranjado e cinzas caindo.",
};

function useExample(btn) {
  const key = btn.textContent.trim();
  const prompt = EXAMPLE_PROMPTS[key] || key;
  promptInput.value = prompt;
  charCount.textContent = `${prompt.length}/2000`;
  promptInput.focus();
}

/* ── Geração ── */
function generateWorld() {
  const prompt = promptInput.value.trim();
  if (!prompt) {
    log("Digite um prompt para gerar o mundo.", "warning");
    promptInput.focus();
    return;
  }

  if (!socket || !socket.connected) {
    log("Não conectado ao servidor!", "error");
    return;
  }

  const model = modelSelect.value;
  const engine = engineSelect.value;
  btnGenerate.disabled = true;
  generatingOverlay.classList.add("active");
  const engineLabel = engine === 'scene' ? 'Scene Engine' : engine === 'threejs' ? 'Three.js' : 'A-Frame';
  genMessage.textContent = `Gerando mundo 3D (${engineLabel})...`;
  log(`Gerando: "${prompt.substring(0, 60)}..." (${model}, ${engine})`);

  socket.emit("worldgen_generate", { prompt, model, engine });
}

/* ── Renderizar cena no iframe ── */
function renderScene(html, prompt) {
  currentHtml = html;
  currentPrompt = prompt;
  currentSceneJSON = null;

  // Limpar canvas renderer se existir
  if (worldRenderer) {
    worldRenderer.dispose();
    worldRenderer = null;
  }

  // Criar blob URL para o HTML gerado
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);

  canvasContainer.style.display = "none";
  sceneFrame.src = url;
  sceneFrame.style.display = "block";
  scenePlaceholder.style.display = "none";
  generatingOverlay.classList.remove("active");
  sceneOverlay.style.display = "flex";

  // Prompt badge truncado
  const shortPrompt = prompt.length > 50 ? prompt.substring(0, 50) + "…" : prompt;
  promptBadge.textContent = `🤖 ${shortPrompt}`;

  // Código preview
  codePreview.textContent = html;

  // Habilitar botões
  btnShare.disabled = false;
  btnFullscreen.disabled = false;
  btnDownload.disabled = false;
  btnGenerate.disabled = false;

  log(`Mundo gerado! Cena renderizada.`);
}

/* ── Renderizar cena via Scene Engine (Three.js) ── */
function renderSceneJSON(sceneJSON, prompt) {
  currentSceneJSON = sceneJSON;
  currentPrompt = prompt;
  currentHtml = JSON.stringify(sceneJSON, null, 2);

  // Limpar iframe
  sceneFrame.style.display = "none";
  sceneFrame.src = "";

  // Limpar renderer anterior
  if (worldRenderer) {
    worldRenderer.dispose();
    worldRenderer = null;
  }

  // Mostrar canvas container
  canvasContainer.style.display = "block";
  canvasContainer.innerHTML = "";
  scenePlaceholder.style.display = "none";
  generatingOverlay.classList.remove("active");
  sceneOverlay.style.display = "flex";

  // Prompt badge
  const shortPrompt = prompt.length > 50 ? prompt.substring(0, 50) + "…" : prompt;
  promptBadge.textContent = `🌍 ${shortPrompt}`;

  // Código preview (JSON)
  codePreview.textContent = currentHtml;

  // Aguardar WorldRenderer estar disponível (carregado via module)
  const tryBuild = () => {
    if (window.WorldRenderer) {
      try {
        worldRenderer = new window.WorldRenderer(canvasContainer);
        worldRenderer.buildFromJSON(sceneJSON);
        log("Mundo 3D renderizado com Scene Engine!");
      } catch (err) {
        log(`Erro no renderer: ${err.message}`, "error");
        console.error(err);
      }
    } else {
      setTimeout(tryBuild, 100);
    }
  };
  tryBuild();

  // Habilitar botões
  btnShare.disabled = false;
  btnFullscreen.disabled = false;
  btnDownload.disabled = false;
  btnGenerate.disabled = false;
}

/* ── Código ── */
function toggleCode() {
  codePreview.classList.toggle("visible");
}

function copyCode() {
  if (!currentHtml) {
    log("Nenhum código gerado ainda.", "warning");
    return;
  }
  navigator.clipboard.writeText(currentHtml).then(() => {
    log("Código copiado para a área de transferência.");
  });
}

/* ── Ações ── */
function shareScene() {
  if (!socket?.connected) return;
  if (currentSceneJSON) {
    socket.emit("worldgen_share", { scene_json: currentSceneJSON, prompt: currentPrompt, engine: "scene" });
  } else if (currentHtml) {
    socket.emit("worldgen_share", { html: currentHtml, prompt: currentPrompt });
  } else {
    return;
  }
  log("Cena compartilhada com outros clientes.");
}

function goFullscreen() {
  const target = currentSceneJSON ? canvasContainer : document.getElementById("sceneContainer");
  if (target.requestFullscreen) {
    target.requestFullscreen();
  } else if (target.webkitRequestFullscreen) {
    target.webkitRequestFullscreen();
  }
}

function downloadScene() {
  const safeName = (currentPrompt || "").substring(0, 30).replace(/[^a-zA-Z0-9]/g, "_") || "scene";
  let blob, ext;
  if (currentSceneJSON) {
    blob = new Blob([JSON.stringify(currentSceneJSON, null, 2)], { type: "application/json" });
    ext = "json";
  } else if (currentHtml) {
    blob = new Blob([currentHtml], { type: "text/html" });
    ext = "html";
  } else {
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeName}.${ext}`;
  a.click();
  URL.revokeObjectURL(url);
  log(`Cena baixada como .${ext}.`);
}

/* ── Galeria ── */
function addToGallery(entry) {
  gallery.push(entry);
  renderGallery();
}

function renderGallery() {
  galleryCount.textContent = gallery.length;
  if (gallery.length === 0) {
    galleryList.innerHTML = `<div style="color:var(--text-muted);font-size:.8rem;text-align:center;padding:.5rem">Nenhuma cena gerada ainda.</div>`;
    return;
  }
  galleryList.innerHTML = gallery
    .map((entry, i) => {
      const shortPrompt = (entry.prompt || "Sem título").substring(0, 60);
      return `
      <div class="gallery-item" onclick="loadGalleryItem(${i})" title="${escHtml(entry.prompt)}">
        <div style="display:flex;align-items:center;gap:.3rem">
          <span class="model-tag">${escHtml(entry.model || "?")}</span>
          <span class="prompt-preview">${escHtml(shortPrompt)}</span>
        </div>
      </div>`;
    })
    .reverse()
    .join("");
}

function loadGalleryItem(index) {
  const entry = gallery[index];
  if (!entry) return;
  if (entry.engine === "scene" && entry.scene_json) {
    renderSceneJSON(entry.scene_json, entry.prompt || "");
  } else if (entry.html) {
    renderScene(entry.html, entry.prompt || "");
  }
  log(`Cena da galeria carregada: "${(entry.prompt || "").substring(0, 40)}..."`);
}

/* ── Socket.IO ── */
function initSocket() {
  socket = io({ transports: ["websocket"] });

  socket.on("connect", () => {
    statusDot.classList.add("connected");
    statusText.textContent = "Conectado";
    log("Conectado ao servidor WebSocket.");
    socket.emit("join_worldgen");
  });

  socket.on("disconnect", () => {
    statusDot.classList.remove("connected");
    statusText.textContent = "Desconectado";
    log("Desconectado.", "warning");
    btnGenerate.disabled = false;
    generatingOverlay.classList.remove("active");
  });

  socket.on("worldgen_ready", (data) => {
    log(`Servidor: ${data.message}`);
    // Carregar galeria do servidor
    if (data.gallery && data.gallery.length > 0) {
      gallery = data.gallery;
      renderGallery();
      log(`${data.gallery.length} cena(s) na galeria.`);
    }
  });

  socket.on("worldgen_status", (data) => {
    genMessage.textContent = data.message || "Processando...";
    log(data.message, "info");
  });

  socket.on("worldgen_result", (data) => {
    btnGenerate.disabled = false;

    if (data.error) {
      generatingOverlay.classList.remove("active");
      log(`Erro: ${data.error}`, "error");
      return;
    }

    // Tokens
    if (data.tokens) {
      tokensCard.style.display = "block";
      tokPrompt.textContent = data.tokens.prompt_tokens;
      tokCompletion.textContent = data.tokens.completion_tokens;
      tokTotal.textContent = data.tokens.total_tokens;
    }

    // Galeria
    addToGallery({
      prompt: data.prompt,
      model: data.model,
      html: data.html || null,
      scene_json: data.scene_json || null,
      engine: data.engine || "aframe",
      tokens: data.tokens,
    });

    // Renderizar conforme engine
    if (data.engine === "scene" && data.scene_json) {
      renderSceneJSON(data.scene_json, data.prompt);
    } else {
      renderScene(data.html, data.prompt);
    }
  });

  // Notificação de nova cena de outro cliente
  socket.on("worldgen_new_scene", (data) => {
    log(`Nova cena gerada por outro cliente: "${(data.prompt || "").substring(0, 40)}..."`, "info");
  });

  // Cena compartilhada por outro cliente
  socket.on("worldgen_shared_scene", (data) => {
    log(`Cena compartilhada recebida: "${(data.prompt || "").substring(0, 40)}..."`, "info");
    const entry = {
      prompt: data.prompt || "Cena compartilhada",
      model: "shared",
      html: data.html || null,
      scene_json: data.scene_json || null,
      engine: data.engine || "aframe",
    };
    addToGallery(entry);
    if (entry.engine === "scene" && entry.scene_json) {
      renderSceneJSON(entry.scene_json, entry.prompt);
    } else if (entry.html) {
      renderScene(entry.html, entry.prompt);
    }
  });
}

/* ── Init ── */
document.addEventListener("DOMContentLoaded", initSocket);
