"""
Servidor Base para Projetos de Realidade Aumentada/Virtual e Visão Computacional
Disciplinas: AR/VR e Visão Computacional

Este servidor fornece:
- Rotas HTTP para as três interfaces web
- WebSocket (Socket.IO) para comunicação em tempo real entre:
  * Painel de controle ↔ Cena AR/VR (A-Frame)
  * Cliente de câmera ↔ Pipeline de Visão Computacional
"""

import base64
import io
import json
import logging
import os

import cv2
import numpy as np
import mediapipe as mp
from mediapipe.tasks.python import vision as mp_vision
from mediapipe.tasks.python import BaseOptions as MpBaseOptions
from flask import Flask, render_template
from flask_socketio import SocketIO, emit, join_room, leave_room

# ---------------------------------------------------------------------------
# Configuração
# ---------------------------------------------------------------------------
import re

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

# ---------------------------------------------------------------------------
# Helpers de validação
# ---------------------------------------------------------------------------
_HEX_COLOR_RE = re.compile(r'^#[0-9A-Fa-f]{3}(?:[0-9A-Fa-f]{3})?$')


def _valid_color(value: str, default: str = "#4CC3D9") -> str:
    """Retorna a cor se for um hex CSS válido, caso contrário retorna o padrão."""
    return value if _HEX_COLOR_RE.match(value or "") else default


logger = logging.getLogger(__name__)

app = Flask(__name__)
app.config["SECRET_KEY"] = "arvrcv-base-server-secret"

# allow_upgrades=True garante suporte a WebSocket via eventlet/gevent
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="eventlet", logger=False, engineio_logger=False)

# ---------------------------------------------------------------------------
# MediaPipe – Detecção de mãos e pose (Tasks API)
# ---------------------------------------------------------------------------
_MODELS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")

_MP_MODELS = {
    "hand_landmarker.task": "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task",
    "pose_landmarker.task": "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task",
}


def _ensure_models():
    """Baixa modelos MediaPipe se não existirem localmente."""
    os.makedirs(_MODELS_DIR, exist_ok=True)
    import urllib.request
    for fname, url in _MP_MODELS.items():
        path = os.path.join(_MODELS_DIR, fname)
        if not os.path.exists(path):
            logger.info("Baixando modelo MediaPipe: %s", fname)
            urllib.request.urlretrieve(url, path)
            logger.info("Modelo salvo: %s", path)


_ensure_models()

_hand_landmarker = mp_vision.HandLandmarker.create_from_options(
    mp_vision.HandLandmarkerOptions(
        base_options=MpBaseOptions(
            model_asset_path=os.path.join(_MODELS_DIR, "hand_landmarker.task")
        ),
        num_hands=2,
        min_hand_detection_confidence=0.5,
        min_tracking_confidence=0.5,
    )
)

_pose_landmarker = mp_vision.PoseLandmarker.create_from_options(
    mp_vision.PoseLandmarkerOptions(
        base_options=MpBaseOptions(
            model_asset_path=os.path.join(_MODELS_DIR, "pose_landmarker.task")
        ),
        min_pose_detection_confidence=0.5,
        min_tracking_confidence=0.5,
    )
)

# Conexões das mãos (21 landmarks): lista de pares de índices
HAND_CONNECTIONS = [
    (0, 1), (1, 2), (2, 3), (3, 4),       # Polegar
    (0, 5), (5, 6), (6, 7), (7, 8),       # Indicador
    (5, 9), (9, 10), (10, 11), (11, 12),  # Médio
    (9, 13), (13, 14), (14, 15), (15, 16),# Anelar
    (13, 17), (17, 18), (18, 19), (19, 20),# Mínimo
    (0, 17),                               # Palma
]

# Conexões de pose (33 landmarks): pares principais
POSE_CONNECTIONS = [
    (0, 1), (1, 2), (2, 3), (3, 7),       # Olho dir
    (0, 4), (4, 5), (5, 6), (6, 8),       # Olho esq
    (9, 10),                               # Boca
    (11, 12),                              # Ombros
    (11, 13), (13, 15),                    # Braço esq
    (12, 14), (14, 16),                    # Braço dir
    (11, 23), (12, 24),                    # Torso
    (23, 24),                              # Quadris
    (23, 25), (25, 27),                    # Perna esq
    (24, 26), (26, 28),                    # Perna dir
    (27, 29), (29, 31),                    # Pé esq
    (28, 30), (30, 32),                    # Pé dir
    (15, 17), (15, 19), (15, 21),          # Mão esq
    (16, 18), (16, 20), (16, 22),          # Mão dir
]

# ---------------------------------------------------------------------------
# Estado da cena AR/VR (compartilhado entre todos os clientes)
# ---------------------------------------------------------------------------
scene_state = {
    "objects": [],          # lista de objetos na cena
    "sky_color": "#87CEEB", # cor do céu
    "next_id": 1,           # próximo id disponível para objetos
}

# Contadores simples de conexões
connected_clients = {"arvr": 0, "cv": 0, "cv3d": 0, "worldgen": 0}

# ---------------------------------------------------------------------------
# OpenAI – AI World Generator
# ---------------------------------------------------------------------------
_openai_client = None


def _get_openai_client():
    """Retorna o cliente OpenAI (lazy init). Requer OPENAI_API_KEY no ambiente."""
    global _openai_client
    if _openai_client is None:
        api_key = os.environ.get("OPENAI_API_KEY", "")
        if not api_key:
            raise RuntimeError(
                "OPENAI_API_KEY não definida. "
                "Execute: export OPENAI_API_KEY='sk-...'"
            )
        from openai import OpenAI
        _openai_client = OpenAI(api_key=api_key)
    return _openai_client


WORLDGEN_SCENE_PROMPT = """
You generate a JSON scene description that will be rendered by a high-quality Three.js engine.
The engine supports: terrain, water, trees, rocks, clouds, buildings, animals, particles, custom objects, and advanced lighting/sky.

Return ONLY valid JSON (no markdown, no explanation). The JSON schema:
{
  "sky": {
    "topColor": "#hex",     // sky top (zenith)
    "midColor": "#hex",     // horizon
    "bottomColor": "#hex"   // below horizon (affects fog)
  },
  "fog": {
    "fogColor": "#hex",
    "density": 0.012        // 0.005 (light) to 0.03 (heavy)
  },
  "lights": {
    "skyColor": "#hex",             // hemisphere sky color
    "groundColor": "#hex",          // hemisphere ground color
    "hemisphereIntensity": 0.6,
    "ambientColor": "#hex",
    "ambientIntensity": 0.3,
    "sunColor": "#hex",
    "sunIntensity": 1.2,
    "sunPosition": {"x": 30, "y": 40, "z": 20},
    "points": [                     // optional point lights
      {"x": 0, "y": 3, "z": 0, "color": "#hex", "intensity": 1, "distance": 20}
    ]
  },
  "terrain": {
    "size": 120,           // ground plane size
    "segments": 200,       // mesh resolution (max 256)
    "maxHeight": 8,        // max terrain elevation
    "noiseScale": 0.02,    // noise frequency (smaller = smoother hills)
    "lowColor": "#4a8c3f", // grass
    "midColor": "#8B7355", // dirt/rock
    "highColor": "#e8e8e8",// snow peaks
    "sandColor": "#c2b280",// near water level
    "flatShading": true,
    "roughness": 0.85
  },
  "water": {                // optional
    "size": 80,
    "height": -0.1,        // y position
    "color": "#1a6b8a",
    "opacity": 0.65
  },
  "trees": {
    "count": 60,           // number of trees (max 200)
    "spread": 50,          // placement area
    "types": ["oak","pine","bush"],
    "minHeight": 2,
    "maxHeight": 6,
    "avoidCenter": 3,      // clear radius around origin
    "minTerrainHeight": -0.5,
    "trunkColor": "#5C3A1E",
    "foliageColors": ["#2d6a1e","#3a8c2a","#4da83a","#228B22","#1a6b15"]
  },
  "rocks": {
    "count": 20,
    "spread": 45,
    "maxSize": 1.2,
    "colors": ["#6b6b6b","#7a7a6e","#8a8275"]
  },
  "clouds": {
    "count": 10,
    "minHeight": 20,
    "maxHeight": 35,
    "spread": 80,
    "color": "#ffffff"
  },
  "buildings": {           // optional array
    "items": [
      {"x":0,"z":0,"width":2,"height":4,"depth":2,"color":"#8B7355","roofColor":"#8B0000","rotation":0}
    ]
  },
  "animals": {             // optional
    "items": [
      {"type":"deer","x":5,"z":8,"color":"#8B6914","scale":1},
      {"type":"rabbit","x":-3,"z":5,"color":"#a08060","scale":0.8},
      {"type":"bird","x":0,"z":0,"color":"#4444aa","scale":0.6,"flyHeight":5}
    ]
  },
  "particles": [           // optional, array of systems
    {
      "count": 100,
      "spread": 40,
      "color": "#ffff88",
      "size": 0.12,
      "opacity": 0.8,
      "glow": true,        // additive blending
      "movement": "float", // "float", "rise", "fall"
      "speed": 0.01,
      "minY": 0.5,
      "maxY": 8
    }
  ],
  "objects": [             // optional custom primitives
    {
      "shape": "sphere",   // sphere, box, cylinder, cone, torus
      "x": 0, "y": 5, "z": 0,
      "radius": 2,
      "color": "#ffcc00",
      "emissive": "#ff8800",
      "emissiveIntensity": 0.5,
      "scale": 1,
      "animation": {       // optional animation for this object
        "type": "rotate",  // "rotate", "orbit", "oscillate", "pulse"
        // For rotate: speedX, speedY, speedZ (radians/sec)
        "speedY": 0.5,
        // For orbit: centerX, centerZ, radius, speed, tiltY
        // For oscillate: axis ("x"/"y"/"z"), amplitude, speed
        // For pulse: amount (scale variation), speed
      }
    }
  ],
  "camera": {
    "x": 0, "y": 12, "z": 35,
    "lookAt": {"x": 0, "y": 2, "z": 0}
  },
  "bloom": {
    "strength": 0.15,
    "radius": 0.4,
    "threshold": 0.9
  }
}

GUIDELINES:
- Include ALL relevant sections for the requested scene.
- For FORESTS: use trees.count=80-150, multiple types, varied foliageColors.
  Add animals (deer, rabbits, birds), rocks, particles (fireflies with glow).
- For OCEANS: large water, low terrain maxHeight, fish animals, particles (bubbles, rise).
- For CITIES: many buildings.items with varied sizes, low trees, street-colored terrain.
- For SPACE: dark sky, no terrain, objects for planets (spheres with emissive), star particles.
- For NIGHT scenes: dark sky, moonlight (cold sun color), firefly particles with glow, higher bloom.
- For VOLCANOES: high terrain, red/orange objects for lava with emissive, warm fog, fire particles.
- Animals: "deer", "rabbit", "bird", "fish". Place 5-15 animals with varied positions.
- Use 3-8 varied foliageColors for diverse tree canopies.
- Adjust fog density for mood: 0.008 for clear, 0.015 for atmospheric, 0.025 for misty.
- Use point lights for magical/warm spots.
- Use bloom strength 0.1-0.3 for subtle glow, 0.5+ for dramatic.
- Make terrain maxHeight proportional to the scene (2 for flat, 8 for hilly, 15 for mountainous).
- ANIMATIONS: Use animation on objects for movement. Examples:
  - Planets orbiting a sun: {"type":"orbit","radius":10,"speed":0.3}
  - Spinning windmill/propeller: {"type":"rotate","speedY":2}
  - Hovering UFO: {"type":"oscillate","axis":"y","amplitude":1.5,"speed":0.8}
  - Pulsing magic orb: {"type":"pulse","amount":0.3,"speed":1.5}
- When user asks for animated elements, use animated objects generously.
- Combine particles + point lights + emissive objects for magical effects."""

WORLDGEN_AFRAME_PROMPT = """
You are an expert 3D world generator for the web. Given a user prompt describing
an environment, you produce a SINGLE self-contained HTML file that renders a
rich, immersive 3D scene in the browser using A-Frame + custom Three.js components.

=== OUTPUT FORMAT ===
- Return ONLY raw HTML. No markdown, no explanations, no code fences.
- The HTML must be a full document: <!DOCTYPE html><html><head>…</head><body>…</body></html>

=== TECHNOLOGY STACK ===
Include in <head>: <script src="https://aframe.io/releases/1.6.0/aframe.min.js"></script>
You have full access to AFRAME.THREE, custom components via AFRAME.registerComponent(),
custom shaders via AFRAME.registerShader(), and inline <script> blocks.

=== SCENE QUALITY ===
- Use PROCEDURAL GENERATION with loops to create 30-100+ entities with random variations.
- Custom components for terrain (PlaneGeometry + vertex displacement), trees
  (CylinderGeometry trunk + IcosahedronGeometry canopy with noise), water
  (animated vertex shader), rocks, clouds, animals (composite primitives).
- Multiple lights (ambient, directional with shadows, hemisphere, point).
- fog, PBR materials (metalness, roughness, emissive), flatShading for stylized look.
- Animation via tick() with Math.sin/cos, A-Frame animation attribute for simple loops.
- Particle systems via custom components (fireflies, rain, snow, sparks).

=== CONSTRAINTS ===
- NO external assets (images, models, textures). Procedural only.
- Keep HTML under 12KB. Use InstancedMesh for 50+ repeated objects.
- Camera: <a-entity position="0 2 12"><a-camera wasd-controls look-controls></a-camera></a-entity>
- Style: body { margin: 0; overflow: hidden; }
"""

# ---------------------------------------------------------------------------

WORLDGEN_THREEJS_PROMPT = """
You are an expert 3D graphics programmer. Given a user prompt describing an
environment or scenario, you generate a SINGLE self-contained HTML file that
renders a HIGH-QUALITY 3D scene using raw Three.js with post-processing effects.

=== OUTPUT FORMAT ===
- Return ONLY raw HTML. No markdown, no explanations, no code fences.
- Full document: <!DOCTYPE html><html><head>…</head><body>…</body></html>

=== TECHNOLOGY STACK ===
Use this exact importmap in <head>:
<script type="importmap">
{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"}}
</script>

Then in <script type="module">:
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
// Import only what you need from above

=== MANDATORY SCENE SETUP ===
const renderer = new THREE.WebGLRenderer({antialias:true});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth/window.innerHeight, 0.1, 1000);
camera.position.set(0, 8, 25);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.maxPolarAngle = Math.PI/2.1;

// Post-processing
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
// Add bloom for glow effects:
const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.3, 0.4, 0.85);
composer.addPass(bloomPass);

// Resize handler
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

// Animation loop – ALWAYS use composer.render() not renderer.render()
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  // update animations here
  composer.render();
}
animate();

=== PROCEDURAL TECHNIQUES (use these!) ===

1. TERRAIN with height-based coloring:
   Create PlaneGeometry(200,200,256,256), displace vertices with layered sine/cosine
   for natural-looking hills. Use a custom ShaderMaterial with vertexColors or
   a fragment shader that colors by height: green (low), brown (mid), white/snow (high).
   Example vertex displacement:
     const simplex = (x,z) => Math.sin(x*0.05)*3 + Math.cos(z*0.07)*2 + Math.sin(x*0.15+z*0.1)*1.5 + Math.cos(x*0.02)*5;
   Set vertex colors based on height for gradient terrain.

2. WATER with animated shader:
   PlaneGeometry with custom ShaderMaterial:
   - Vertex shader: displace y with sin(position.x*freq + time) * amplitude
   - Fragment shader: mix deep blue and lighter blue based on wave height,
     add fresnel-like effect, semi-transparent
   - Set transparent:true, opacity:0.7, side:THREE.DoubleSide

3. TREES (varied, organic):
   Function makeTree(x,z) that creates a Group with:
   - Trunk: CylinderGeometry with slight taper, brown MeshStandardMaterial
   - Multiple canopy layers: IcosahedronGeometry(detail:1-2) with vertex
     displacement (noise), various green shades via HSL randomization
   - Randomize height (2-6), trunk thickness, canopy size, lean angle
   Generate 40-100 trees with placement avoiding overlap.

4. ROCKS & BOULDERS:
   DodecahedronGeometry or IcosahedronGeometry with vertex displacement.
   Multiple sizes, gray-brown colors with slight variation.

5. ANIMALS/CREATURES (composite geometry):
   Build from primitives: body=SphereGeometry(stretched), head=SphereGeometry(smaller),
   legs=CylinderGeometry(thin), ears/horns=ConeGeometry, tail=curved tube.
   Add idle animation: bobbing via sin(time), head turning.

6. PARTICLES & ATMOSPHERE:
   - Points with BufferGeometry for fireflies, dust, rain, snow, stars
   - Animate positions in the render loop
   - Use PointsMaterial with size, transparent, color, sizeAttenuation
   - Use emissive for glowing particles

7. SKY:
   - Custom gradient sky using a large SphereGeometry with ShaderMaterial
     (fragment shader: mix colors based on y-position of normal/uv)
   - OR use scene.background = new THREE.Color() with fog for simple sky

8. LIGHTING:
   - THREE.HemisphereLight(skyColor, groundColor, intensity) for ambient
   - THREE.DirectionalLight with shadow (shadow.mapSize 2048, shadow.camera bounds)
   - THREE.PointLight for local glow (lamps, fire, magic)
   - scene.fog = new THREE.FogExp2(color, density) for atmosphere

9. INSTANCED RENDERING (for performance with many objects):
   When placing 50+ identical objects (grass blades, trees of same type, rocks):
   const instancedMesh = new THREE.InstancedMesh(geometry, material, count);
   const dummy = new THREE.Object3D();
   for(let i=0; i<count; i++) {
     dummy.position.set(x,y,z); dummy.rotation.set(...); dummy.scale.set(...);
     dummy.updateMatrix();
     instancedMesh.setMatrixAt(i, dummy.matrix);
   }

10. POST-PROCESSING EFFECTS:
    - UnrealBloomPass for glow (lava, magic, neon, fire)
    - Custom color grading via ShaderPass
    - Adjust bloomPass.strength, bloomPass.radius, bloomPass.threshold
    - Use renderer.toneMapping = THREE.ACESFilmicToneMapping for cinematic look

=== CONSTRAINTS ===
- NO external assets: no image/texture URLs, no GLTF/OBJ models.
  Everything must be procedural (geometry + math + shaders).
- Keep HTML under 15KB.
- Must handle window resize.
- Must run at 30+ FPS. Use InstancedMesh for large numbers of objects.
- Style: body { margin:0; overflow:hidden; } canvas { display:block; }
- Use OrbitControls so user can navigate with mouse.

=== QUALITY GOAL ===
Create VISUALLY IMPRESSIVE scenes with depth, atmosphere, layered composition,
and cinematic lighting. The scene should feel immersive and detailed, not flat
or sparse. Use fog for depth, shadows for grounding, bloom for mood, and
procedural variation for organic naturalness. Think of stylized low-poly games
like Firewatch, Monument Valley, or Polytopia as quality targets.

Generate scenes at this quality level. Be creative, ambitious, and technically excellent.
"""

WORLDGEN_SYSTEM_PROMPT = WORLDGEN_AFRAME_PROMPT  # backward compat

# ---------------------------------------------------------------------------
# Rotas HTTP
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    """Página principal – escolha de interface."""
    return render_template("index.html")


@app.route("/arvr")
def arvr():
    """Interface de Realidade Aumentada e Virtual."""
    return render_template("arvr.html")


@app.route("/cv")
def cv_page():
    """Interface de Visão Computacional."""
    return render_template("cv.html")


@app.route("/cv3d")
def cv3d_page():
    """Interface CV → 3D Bridge (Three.js)."""
    return render_template("cv3d.html")


@app.route("/worldgen")
def worldgen_page():
    """Interface AI World Generator."""
    return render_template("worldgen.html")


# ---------------------------------------------------------------------------
# Eventos Socket.IO – conexão/desconexão
# ---------------------------------------------------------------------------

@socketio.on("connect")
def on_connect():
    logger.info("Cliente conectado: %s", socketio.server.eio.sockets.keys() if hasattr(socketio.server, "eio") else "?")


@socketio.on("disconnect")
def on_disconnect():
    logger.info("Cliente desconectado")


# ---------------------------------------------------------------------------
# Eventos Socket.IO – AR/VR
# ---------------------------------------------------------------------------

@socketio.on("join_arvr")
def on_join_arvr():
    """Cliente entra na sala AR/VR e recebe o estado atual da cena."""
    join_room("arvr")
    connected_clients["arvr"] += 1
    logger.info("Cliente entrou na sala arvr. Total: %d", connected_clients["arvr"])
    emit("scene_state", scene_state)


@socketio.on("leave_arvr")
def on_leave_arvr():
    leave_room("arvr")
    connected_clients["arvr"] = max(0, connected_clients["arvr"] - 1)


@socketio.on("arvr_command")
def on_arvr_command(data):
    """
    Recebe um comando do painel de controle e atualiza a cena.

    Comandos suportados:
      - add_object   : {"type": "box"|"sphere"|"cylinder"|"cone"|"torus", "color": "#rrggbb"}
      - remove_object: {"id": <int>}
      - change_sky   : {"color": "#rrggbb"}
      - clear_scene  : {}
      - move_object  : {"id": <int>, "x": float, "y": float, "z": float}
      - change_color : {"id": <int>, "color": "#rrggbb"}
    """
    command = data.get("command")
    payload = data.get("payload", {})
    logger.info("arvr_command: %s %s", command, payload)

    ALLOWED_TYPES = {"box", "sphere", "cylinder", "cone", "torus", "dodecahedron"}

    if command == "add_object":
        obj_type = payload.get("type", "box")
        if obj_type not in ALLOWED_TYPES:
            emit("error", {"message": f"Tipo inválido: {obj_type}"})
            return
        color = _valid_color(payload.get("color", "#4CC3D9"))
        obj_id = scene_state["next_id"]
        scene_state["next_id"] += 1
        # Posição padrão espaçada para não sobrepor
        obj = {
            "id": obj_id,
            "type": obj_type,
            "color": color,
            "position": {
                "x": round((obj_id % 5 - 2) * 1.5, 2),
                "y": 1.0,
                "z": -round((obj_id // 5) * 1.5 + 3, 2),
            },
            "rotation": {"x": 0, "y": 0, "z": 0},
            "scale": {"x": 1, "y": 1, "z": 1},
            "animation": False,
        }
        scene_state["objects"].append(obj)
        socketio.emit("object_added", obj, to="arvr")

    elif command == "remove_object":
        obj_id = payload.get("id")
        scene_state["objects"] = [o for o in scene_state["objects"] if o["id"] != obj_id]
        socketio.emit("object_removed", {"id": obj_id}, to="arvr")

    elif command == "change_sky":
        scene_state["sky_color"] = _valid_color(payload.get("color", "#87CEEB"), "#87CEEB")
        socketio.emit("sky_changed", {"color": scene_state["sky_color"]}, to="arvr")

    elif command == "clear_scene":
        scene_state["objects"] = []
        scene_state["sky_color"] = "#87CEEB"
        scene_state["next_id"] = 1
        socketio.emit("scene_cleared", {}, to="arvr")

    elif command == "move_object":
        obj_id = payload.get("id")
        for obj in scene_state["objects"]:
            if obj["id"] == obj_id:
                obj["position"]["x"] = payload.get("x", obj["position"]["x"])
                obj["position"]["y"] = payload.get("y", obj["position"]["y"])
                obj["position"]["z"] = payload.get("z", obj["position"]["z"])
                socketio.emit("object_moved", obj, to="arvr")
                break

    elif command == "change_color":
        obj_id = payload.get("id")
        for obj in scene_state["objects"]:
            if obj["id"] == obj_id:
                obj["color"] = _valid_color(payload.get("color", obj["color"]), obj["color"])
                socketio.emit("color_changed", {"id": obj_id, "color": obj["color"]}, to="arvr")
                break

    elif command == "toggle_animation":
        obj_id = payload.get("id")
        for obj in scene_state["objects"]:
            if obj["id"] == obj_id:
                obj["animation"] = not obj["animation"]
                socketio.emit("animation_toggled", {"id": obj_id, "animation": obj["animation"]}, to="arvr")
                break

    # Sempre devolve o estado completo para sincronismo
    emit("scene_state", scene_state)


# ---------------------------------------------------------------------------
# Eventos Socket.IO – Visão Computacional
# ---------------------------------------------------------------------------

@socketio.on("join_cv")
def on_join_cv():
    join_room("cv")
    connected_clients["cv"] += 1
    logger.info("Cliente entrou na sala cv. Total: %d", connected_clients["cv"])
    emit("cv_ready", {"message": "Servidor de Visão Computacional pronto."})


@socketio.on("leave_cv")
def on_leave_cv():
    leave_room("cv")
    connected_clients["cv"] = max(0, connected_clients["cv"] - 1)


@socketio.on("cv_frame")
def on_cv_frame(data):
    """
    Recebe um frame (imagem base64) do cliente, aplica o pipeline de CV e
    devolve os resultados ao mesmo cliente.

    data = {
        "image": "<base64 string>",   # frame capturado
        "pipeline": "edges"|"contours"|"faces"|"color"|"blur"|"threshold"
    }
    """
    pipeline = data.get("pipeline", "edges")
    image_b64 = data.get("image", "")

    try:
        # Decodifica imagem base64 → numpy array
        header, encoded = image_b64.split(",", 1) if "," in image_b64 else ("", image_b64)
        img_bytes = base64.b64decode(encoded)
        np_arr = np.frombuffer(img_bytes, dtype=np.uint8)
        frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

        if frame is None:
            emit("cv_result", {"error": "Não foi possível decodificar a imagem."})
            return

        result_frame, detections = _apply_pipeline(frame, pipeline)

        # Codifica resultado de volta para base64
        _, buffer = cv2.imencode(".jpg", result_frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
        result_b64 = "data:image/jpeg;base64," + base64.b64encode(buffer).decode("utf-8")

        emit("cv_result", {
            "image": result_b64,
            "pipeline": pipeline,
            "detections": detections,
        })

    except Exception as exc:
        logger.exception("Erro no pipeline de CV: %s", exc)
        emit("cv_result", {"error": str(exc)})


def _apply_pipeline(frame: np.ndarray, pipeline: str):
    """Aplica um pipeline de visão computacional e retorna (frame_resultado, detecções)."""
    detections = []

    if pipeline == "edges":
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        blurred = cv2.GaussianBlur(gray, (5, 5), 0)
        result = cv2.Canny(blurred, 50, 150)
        result = cv2.cvtColor(result, cv2.COLOR_GRAY2BGR)
        detections.append({"type": "info", "text": "Detecção de bordas (Canny)"})

    elif pipeline == "contours":
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        _, thresh = cv2.threshold(gray, 127, 255, cv2.THRESH_BINARY)
        contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        result = frame.copy()
        cv2.drawContours(result, contours, -1, (0, 255, 0), 2)
        detections.append({"type": "contours", "count": len(contours), "text": f"{len(contours)} contornos encontrados"})

    elif pipeline == "faces":
        # Usa classificador Haar para detecção de rostos
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
        faces = face_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(30, 30))
        result = frame.copy()
        for (x, y, w, h) in faces:
            cv2.rectangle(result, (x, y), (x + w, y + h), (255, 0, 0), 2)
            cv2.putText(result, "Rosto", (x, y - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 0, 0), 2)
        detections.append({"type": "faces", "count": len(faces), "text": f"{len(faces)} rosto(s) detectado(s)"})

    elif pipeline == "color":
        # Segmentação por cor – detecta tons de verde (HSV)
        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        lower_green = np.array([35, 50, 50])
        upper_green = np.array([85, 255, 255])
        mask = cv2.inRange(hsv, lower_green, upper_green)
        result = cv2.bitwise_and(frame, frame, mask=mask)
        pixel_count = int(np.sum(mask > 0))
        detections.append({"type": "color", "pixels": pixel_count, "text": f"Segmentação de cor verde – {pixel_count} pixels"})

    elif pipeline == "blur":
        result = cv2.GaussianBlur(frame, (21, 21), 0)
        detections.append({"type": "info", "text": "Desfoque Gaussiano aplicado"})

    elif pipeline == "threshold":
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        _, result_gray = cv2.threshold(gray, 127, 255, cv2.THRESH_BINARY)
        result = cv2.cvtColor(result_gray, cv2.COLOR_GRAY2BGR)
        detections.append({"type": "info", "text": "Limiarização binária aplicada"})

    elif pipeline == "hands":
        # Detecção de mãos com MediaPipe Tasks API
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        results = _hand_landmarker.detect(mp_img)
        result = frame.copy()
        h, w = frame.shape[:2]
        hand_count = len(results.hand_landmarks)
        finger_data = []

        for idx, hand_lms in enumerate(results.hand_landmarks):
            # Desenhar conexões
            for c0, c1 in HAND_CONNECTIONS:
                x0, y0 = int(hand_lms[c0].x * w), int(hand_lms[c0].y * h)
                x1, y1 = int(hand_lms[c1].x * w), int(hand_lms[c1].y * h)
                cv2.line(result, (x0, y0), (x1, y1), (0, 255, 0), 2)

            # Desenhar landmarks
            for lm in hand_lms:
                cx, cy = int(lm.x * w), int(lm.y * h)
                cv2.circle(result, (cx, cy), 4, (0, 0, 255), -1)
                cv2.circle(result, (cx, cy), 6, (255, 255, 255), 1)

            # Identificar mão (esquerda/direita)
            handedness = "?"
            if results.handedness and idx < len(results.handedness):
                handedness = results.handedness[idx][0].category_name

            # Contar dedos levantados
            fingers_up = _count_fingers_tasks(hand_lms, handedness)

            # Label da mão
            wrist = hand_lms[0]
            lx, ly = int(wrist.x * w), int(wrist.y * h)
            label = f"{handedness}: {fingers_up} dedo(s)"
            cv2.putText(result, label, (lx - 30, ly - 20),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)

            finger_data.append({
                "hand": handedness,
                "fingers_up": fingers_up,
                "landmarks": [
                    {"id": i, "x": round(lm.x, 4), "y": round(lm.y, 4), "z": round(lm.z, 4)}
                    for i, lm in enumerate(hand_lms)
                ],
            })

        detections.append({
            "type": "hands",
            "count": hand_count,
            "text": f"{hand_count} mão(s) detectada(s)",
            "hands": finger_data,
        })

    elif pipeline == "pose":
        # Detecção de pose/articulações com MediaPipe Tasks API
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        results = _pose_landmarker.detect(mp_img)
        result = frame.copy()
        h, w = frame.shape[:2]
        joint_count = 0

        if results.pose_landmarks:
            pose_lms = results.pose_landmarks[0]  # primeiro corpo
            # Desenhar conexões
            for c0, c1 in POSE_CONNECTIONS:
                if c0 < len(pose_lms) and c1 < len(pose_lms):
                    lm0, lm1 = pose_lms[c0], pose_lms[c1]
                    if lm0.visibility > 0.5 and lm1.visibility > 0.5:
                        x0, y0 = int(lm0.x * w), int(lm0.y * h)
                        x1, y1 = int(lm1.x * w), int(lm1.y * h)
                        cv2.line(result, (x0, y0), (x1, y1), (0, 255, 128), 2)

            # Desenhar landmarks
            for lm in pose_lms:
                if lm.visibility > 0.5:
                    cx, cy = int(lm.x * w), int(lm.y * h)
                    cv2.circle(result, (cx, cy), 5, (255, 0, 128), -1)
                    cv2.circle(result, (cx, cy), 7, (255, 255, 255), 1)

            # Contar articulações visíveis
            joint_count = sum(1 for lm in pose_lms if lm.visibility > 0.5)

            # Labels nos pontos principais
            key_joints = {
                0: "Nariz", 11: "Ombro E", 12: "Ombro D",
                13: "Cotovelo E", 14: "Cotovelo D",
                15: "Pulso E", 16: "Pulso D",
                23: "Quadril E", 24: "Quadril D",
                25: "Joelho E", 26: "Joelho D",
                27: "Tornozelo E", 28: "Tornozelo D",
            }
            for jid, name in key_joints.items():
                if jid < len(pose_lms):
                    lm = pose_lms[jid]
                    if lm.visibility > 0.5:
                        cx, cy = int(lm.x * w), int(lm.y * h)
                        cv2.putText(result, name, (cx + 5, cy - 5),
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 0), 1)

        detections.append({
            "type": "pose",
            "count": joint_count,
            "text": f"{joint_count} articulação(ões) visível(is)",
        })

    else:
        result = frame
        detections.append({"type": "info", "text": "Pipeline desconhecido – imagem original"})

    return result, detections


def _count_fingers_tasks(landmarks, handedness):
    """Conta dedos levantados (Tasks API – landmarks é lista de NormalizedLandmark)."""
    tips = [4, 8, 12, 16, 20]
    pips = [3, 6, 10, 14, 18]
    count = 0

    # Polegar: compara x (depende da mão)
    if handedness == "Right":
        if landmarks[tips[0]].x < landmarks[pips[0]].x:
            count += 1
    else:
        if landmarks[tips[0]].x > landmarks[pips[0]].x:
            count += 1

    # Outros 4 dedos: tip acima do PIP (y menor = mais alto)
    for i in range(1, 5):
        if landmarks[tips[i]].y < landmarks[pips[i]].y:
            count += 1

    return count


def _apply_pipeline_3d(frame: np.ndarray, pipeline: str):
    """Aplica pipeline CV e extrai dados geométricos para mapeamento 3D."""
    result_frame, detections = _apply_pipeline(frame, pipeline)
    h, w = frame.shape[:2]
    geometry = {"type": pipeline, "width": w, "height": h}

    if pipeline == "contours":
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        _, thresh = cv2.threshold(gray, 127, 255, cv2.THRESH_BINARY)
        contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        shapes = []
        for cnt in contours:
            area = cv2.contourArea(cnt)
            if area < 100:
                continue
            epsilon = 0.02 * cv2.arcLength(cnt, True)
            approx = cv2.approxPolyDP(cnt, epsilon, True)
            x, y, bw, bh = cv2.boundingRect(cnt)
            points = approx.reshape(-1, 2).tolist()
            shapes.append({"x": int(x), "y": int(y), "w": int(bw), "h": int(bh),
                           "area": float(area), "points": points})
        # Limitar a 50 maiores contornos
        shapes.sort(key=lambda s: s["area"], reverse=True)
        geometry["shapes"] = shapes[:50]

    elif pipeline == "faces":
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        face_cascade = cv2.CascadeClassifier(
            cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        )
        faces = face_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(30, 30))
        rects = []
        for (x, y, fw, fh) in faces:
            rects.append({"x": int(x), "y": int(y), "w": int(fw), "h": int(fh)})
        geometry["faces"] = rects

    elif pipeline == "edges":
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        blurred = cv2.GaussianBlur(gray, (5, 5), 0)
        edges = cv2.Canny(blurred, 50, 150)
        # Amostrar pixels brancos (cada 4 pixels) para gerar pontos 3D
        ys, xs = np.where(edges > 0)
        step = max(1, len(xs) // 3000)
        sampled_x = xs[::step].tolist()
        sampled_y = ys[::step].tolist()
        geometry["points"] = list(zip(sampled_x, sampled_y))

    elif pipeline == "color":
        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        lower_green = np.array([35, 50, 50])
        upper_green = np.array([85, 255, 255])
        mask = cv2.inRange(hsv, lower_green, upper_green)
        ys, xs = np.where(mask > 0)
        step = max(1, len(xs) // 2000)
        sampled_x = xs[::step].tolist()
        sampled_y = ys[::step].tolist()
        # Extrair cores RGB dos pixels amostrados
        colors = []
        for sx, sy in zip(sampled_x, sampled_y):
            b, g, r = frame[sy, sx]
            colors.append([int(r), int(g), int(b)])
        geometry["points"] = list(zip(sampled_x, sampled_y))
        geometry["colors"] = colors
        geometry["total_pixels"] = int(np.sum(mask > 0))

    elif pipeline == "threshold":
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        _, thresh = cv2.threshold(gray, 127, 255, cv2.THRESH_BINARY)
        ys, xs = np.where(thresh > 0)
        step = max(1, len(xs) // 2000)
        geometry["points"] = list(zip(xs[::step].tolist(), ys[::step].tolist()))

    return result_frame, detections, geometry


# ---------------------------------------------------------------------------
# Eventos Socket.IO – CV → 3D Bridge
# ---------------------------------------------------------------------------

@socketio.on("join_cv3d")
def on_join_cv3d():
    join_room("cv3d")
    connected_clients["cv3d"] += 1
    logger.info("Cliente entrou na sala cv3d. Total: %d", connected_clients["cv3d"])
    emit("cv3d_ready", {"message": "Servidor CV→3D pronto."})


@socketio.on("leave_cv3d")
def on_leave_cv3d():
    leave_room("cv3d")
    connected_clients["cv3d"] = max(0, connected_clients["cv3d"] - 1)


@socketio.on("cv3d_frame")
def on_cv3d_frame(data):
    """Processa frame e retorna imagem + dados geométricos para cena 3D."""
    pipeline = data.get("pipeline", "edges")
    image_b64 = data.get("image", "")

    try:
        header, encoded = image_b64.split(",", 1) if "," in image_b64 else ("", image_b64)
        img_bytes = base64.b64decode(encoded)
        np_arr = np.frombuffer(img_bytes, dtype=np.uint8)
        frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

        if frame is None:
            emit("cv3d_result", {"error": "Não foi possível decodificar a imagem."})
            return

        result_frame, detections, geometry = _apply_pipeline_3d(frame, pipeline)

        _, buffer = cv2.imencode(".jpg", result_frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
        result_b64 = "data:image/jpeg;base64," + base64.b64encode(buffer).decode("utf-8")

        emit("cv3d_result", {
            "image": result_b64,
            "pipeline": pipeline,
            "detections": detections,
            "geometry": geometry,
        })

    except Exception as exc:
        logger.exception("Erro no pipeline CV→3D: %s", exc)
        emit("cv3d_result", {"error": str(exc)})


@socketio.on("cv3d_broadcast")
def on_cv3d_broadcast(data):
    """Retransmite dados da cena 3D para outros clientes na sala cv3d."""
    emit("cv3d_scene_update", data, to="cv3d", include_self=False)


# ---------------------------------------------------------------------------
# Eventos Socket.IO – AI World Generator
# ---------------------------------------------------------------------------

# Histórico de cenas geradas (compartilhado)
world_gallery = []


@socketio.on("join_worldgen")
def on_join_worldgen():
    join_room("worldgen")
    connected_clients["worldgen"] += 1
    logger.info("Cliente entrou na sala worldgen. Total: %d", connected_clients["worldgen"])
    emit("worldgen_ready", {
        "message": "AI World Generator pronto.",
        "gallery": world_gallery[-10:],  # últimas 10 cenas
    })


@socketio.on("leave_worldgen")
def on_leave_worldgen():
    leave_room("worldgen")
    connected_clients["worldgen"] = max(0, connected_clients["worldgen"] - 1)


@socketio.on("worldgen_generate")
def on_worldgen_generate(data):
    """
    Recebe um prompt do usuário, chama a OpenAI API para gerar código A-Frame,
    e retorna o HTML da cena ao cliente.

    data = {"prompt": "...", "model": "gpt-4o-mini"}
    """
    prompt = (data.get("prompt") or "").strip()
    model = data.get("model", "gpt-4o-mini")
    engine = data.get("engine", "threejs")

    if not prompt:
        emit("worldgen_result", {"error": "Prompt vazio."})
        return

    if len(prompt) > 2000:
        emit("worldgen_result", {"error": "Prompt muito longo (máx 2000 caracteres)."})
        return

    # Validar modelo permitido
    allowed_models = {"gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1-nano"}
    if model not in allowed_models:
        model = "gpt-4o-mini"

    emit("worldgen_status", {"status": "generating", "message": "Gerando mundo 3D..."})

    # Selecionar prompt baseado no engine
    if engine == "aframe":
        system_prompt = WORLDGEN_AFRAME_PROMPT
    elif engine == "scene":
        system_prompt = WORLDGEN_SCENE_PROMPT
    else:
        system_prompt = WORLDGEN_THREEJS_PROMPT

    try:
        client = _get_openai_client()
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": prompt},
            ],
            max_tokens=16384,
            temperature=0.85,
        )

        html_code = response.choices[0].message.content.strip()

        # Limpar possíveis blocos de código markdown
        if html_code.startswith("```"):
            lines = html_code.split("\n")
            # Remove primeira e última linhas de bloco
            if lines[0].startswith("```"):
                lines = lines[1:]
            if lines and lines[-1].strip() == "```":
                lines = lines[:-1]
            html_code = "\n".join(lines)

        # Para modo scene (JSON), validar e parsear
        if engine == "scene":
            import json as json_mod
            try:
                scene_json = json_mod.loads(html_code)
            except json_mod.JSONDecodeError:
                start = html_code.find("{")
                end = html_code.rfind("}") + 1
                if start >= 0 and end > start:
                    try:
                        scene_json = json_mod.loads(html_code[start:end])
                    except json_mod.JSONDecodeError:
                        emit("worldgen_result", {
                            "error": "A IA não gerou JSON válido. Tente novamente.",
                        })
                        return
                else:
                    emit("worldgen_result", {
                        "error": "A IA não gerou JSON válido. Tente novamente.",
                    })
                    return

            usage = response.usage
            tokens_info = {
                "prompt_tokens": usage.prompt_tokens if usage else 0,
                "completion_tokens": usage.completion_tokens if usage else 0,
                "total_tokens": usage.total_tokens if usage else 0,
            }

            entry = {
                "prompt": prompt,
                "model": model,
                "engine": engine,
                "scene_json": scene_json,
                "tokens": tokens_info,
            }
            world_gallery.append(entry)
            if len(world_gallery) > 20:
                world_gallery.pop(0)

            emit("worldgen_result", {
                "scene_json": scene_json,
                "engine": engine,
                "prompt": prompt,
                "model": model,
                "tokens": tokens_info,
            })

            socketio.emit("worldgen_new_scene", {
                "prompt": prompt,
                "model": model,
            }, to="worldgen", include_self=False)
            return

        # Validar que contém conteúdo 3D válido
        is_valid = ("<a-scene" in html_code or "THREE" in html_code
                     or "three" in html_code.lower() and "scene" in html_code.lower())
        if not is_valid:
            emit("worldgen_result", {
                "error": "A IA não gerou código 3D válido. Tente reformular o prompt.",
            })
            return

        usage = response.usage
        tokens_info = {
            "prompt_tokens": usage.prompt_tokens if usage else 0,
            "completion_tokens": usage.completion_tokens if usage else 0,
            "total_tokens": usage.total_tokens if usage else 0,
        }

        # Armazenar no gallery
        entry = {
            "prompt": prompt,
            "model": model,
            "html": html_code,
            "tokens": tokens_info,
        }
        world_gallery.append(entry)
        # Manter apenas as últimas 20 cenas
        if len(world_gallery) > 20:
            world_gallery.pop(0)

        emit("worldgen_result", {
            "html": html_code,
            "prompt": prompt,
            "model": model,
            "tokens": tokens_info,
        })

        # Notificar outros clientes que uma nova cena foi gerada
        socketio.emit("worldgen_new_scene", {
            "prompt": prompt,
            "model": model,
        }, to="worldgen", include_self=False)

    except RuntimeError as exc:
        emit("worldgen_result", {"error": str(exc)})
    except Exception as exc:
        logger.exception("Erro ao gerar mundo: %s", exc)
        emit("worldgen_result", {"error": f"Erro na API: {str(exc)}"})


@socketio.on("worldgen_share")
def on_worldgen_share(data):
    """Compartilha a cena gerada com todos na sala."""
    html = data.get("html", "")
    prompt = data.get("prompt", "")
    if html and ("<a-scene" in html or "THREE" in html):
        socketio.emit("worldgen_shared_scene", {
            "html": html,
            "prompt": prompt,
        }, to="worldgen", include_self=False)


# ---------------------------------------------------------------------------
# Ponto de entrada
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    print("=" * 60)
    print("  Servidor Base AR/VR + Visão Computacional")
    print("  Acesse: http://localhost:5000")
    print("=" * 60)
    socketio.run(app, host="0.0.0.0", port=5000, debug=True)
