/**
 * worldgen-renderer.js – Motor de renderização Three.js de alta qualidade
 *
 * Recebe uma descrição JSON de cena e gera um mundo 3D com:
 * - Terreno procedural com relevo e coloração por altura
 * - Água animada com reflexo
 * - Árvores low-poly orgânicas (vários tipos)
 * - Animais compostos com animação idle
 * - Rochas, nuvens, partículas atmosféricas
 * - Iluminação cinematográfica com sombras
 * - Post-processing (bloom, tone mapping)
 * - Fog atmosférico
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

/* =========================================================================
   NOISE – Simplex-like noise para terreno procedural
   ========================================================================= */
function hash(x, y) {
  let h = (x * 374761393 + y * 668265263 + 1376312589) & 0x7fffffff;
  h = ((h >> 13) ^ h) * 1274126177;
  return ((h >> 16) ^ h) & 0x7fffffff;
}
function smooth(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
function lerp(a, b, t) { return a + (b - a) * t; }

function valueNoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = smooth(x - ix), fy = smooth(y - iy);
  const a = hash(ix, iy) / 0x7fffffff;
  const b = hash(ix + 1, iy) / 0x7fffffff;
  const c = hash(ix, iy + 1) / 0x7fffffff;
  const d = hash(ix + 1, iy + 1) / 0x7fffffff;
  return lerp(lerp(a, b, fx), lerp(c, d, fx), fy);
}

function fbm(x, y, octaves = 5) {
  let val = 0, amp = 0.5, freq = 1;
  for (let i = 0; i < octaves; i++) {
    val += amp * valueNoise(x * freq, y * freq);
    amp *= 0.5;
    freq *= 2.1;
  }
  return val;
}

/* =========================================================================
   WORLD RENDERER CLASS
   ========================================================================= */
export class WorldRenderer {
  constructor(container) {
    this.container = container;
    this.animatedObjects = [];
    this.clock = new THREE.Clock();
    this.waterMeshes = [];
    this.particleSystems = [];
    this.animalGroups = [];

    // WASD movement state
    this._keys = { w: false, a: false, s: false, d: false, q: false, e: false, shift: false };
    this._moveSpeed = 15;
    this._moveDir = new THREE.Vector3();
    this._sideDir = new THREE.Vector3();

    this._initRenderer();
    this._initScene();
    this._initCamera();
    this._initControls();
    this._initKeyboard();
    this._initPostProcessing();
    this._onResize = this._onResize.bind(this);
    window.addEventListener("resize", this._onResize);
    this._animate();
  }

  /* ── Setup ── */
  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.container.appendChild(this.renderer.domElement);
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87CEEB);
  }

  _initCamera() {
    const aspect = this.container.clientWidth / this.container.clientHeight;
    this.camera = new THREE.PerspectiveCamera(55, aspect, 0.1, 500);
    this.camera.position.set(0, 12, 35);
  }

  _initControls() {
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.maxPolarAngle = Math.PI / 2.05;
    this.controls.minDistance = 2;
    this.controls.maxDistance = 200;
    this.controls.target.set(0, 2, 0);
  }

  _initKeyboard() {
    this._onKeyDown = (e) => {
      const k = e.key.toLowerCase();
      if (k in this._keys) this._keys[k] = true;
      if (k === "shift" || e.shiftKey) this._keys.shift = true;
    };
    this._onKeyUp = (e) => {
      const k = e.key.toLowerCase();
      if (k in this._keys) this._keys[k] = false;
      if (k === "shift") this._keys.shift = false;
    };
    window.addEventListener("keydown", this._onKeyDown);
    window.addEventListener("keyup", this._onKeyUp);
  }

  _updateMovement(delta) {
    const speed = this._moveSpeed * (this._keys.shift ? 2.5 : 1) * delta;
    const cam = this.camera;
    const target = this.controls.target;

    // Direção para frente (projetada no plano XZ)
    this._moveDir.set(0, 0, -1).applyQuaternion(cam.quaternion);
    this._moveDir.y = 0;
    this._moveDir.normalize();

    // Direção lateral
    this._sideDir.crossVectors(this._moveDir, cam.up).normalize();

    let moved = false;

    if (this._keys.w) { cam.position.addScaledVector(this._moveDir, speed); target.addScaledVector(this._moveDir, speed); moved = true; }
    if (this._keys.s) { cam.position.addScaledVector(this._moveDir, -speed); target.addScaledVector(this._moveDir, -speed); moved = true; }
    if (this._keys.a) { cam.position.addScaledVector(this._sideDir, -speed); target.addScaledVector(this._sideDir, -speed); moved = true; }
    if (this._keys.d) { cam.position.addScaledVector(this._sideDir, speed); target.addScaledVector(this._sideDir, speed); moved = true; }
    if (this._keys.q) { cam.position.y -= speed; target.y -= speed; moved = true; }
    if (this._keys.e) { cam.position.y += speed; target.y += speed; moved = true; }

    return moved;
  }

  _initPostProcessing() {
    const sz = new THREE.Vector2(this.container.clientWidth, this.container.clientHeight);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(sz, 0.15, 0.4, 0.9);
    this.composer.addPass(this.bloomPass);
  }

  _onResize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
  }

  _animate() {
    this._rafId = requestAnimationFrame(() => this._animate());
    const delta = this.clock.getDelta();
    const t = this.clock.getElapsedTime();

    // WASD movement
    this._updateMovement(delta);
    this.controls.update();

    // Água
    for (const water of this.waterMeshes) {
      const pos = water.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = water._origPositions[i * 3];
        const z = water._origPositions[i * 3 + 2];
        pos.setY(i, Math.sin(x * 0.3 + t * 1.5) * 0.15 + Math.cos(z * 0.4 + t * 1.2) * 0.1);
      }
      pos.needsUpdate = true;
      water.geometry.computeVertexNormals();
    }

    // Partículas
    for (const ps of this.particleSystems) {
      const pos = ps.geometry.attributes.position;
      for (let i = 0; i < ps._count; i++) {
        let y = pos.getY(i) + ps._speeds[i];
        if (ps._type === "rise" && y > ps._maxY) y = ps._minY;
        if (ps._type === "fall" && y < ps._minY) y = ps._maxY;
        if (ps._type === "float") {
          y = ps._baseY[i] + Math.sin(t * ps._speeds[i] * 3 + ps._phases[i]) * 0.5;
        }
        pos.setY(i, y);
      }
      pos.needsUpdate = true;
    }

    // Animais
    for (const ag of this.animalGroups) {
      ag.group.position.y = ag.baseY + Math.sin(t * 1.5 + ag.phase) * 0.08;
      if (ag.head) {
        ag.head.rotation.y = Math.sin(t * 0.8 + ag.phase) * 0.3;
      }
    }

    // Animações customizadas (rotate, orbit, oscillate)
    for (const anim of this.animatedObjects) {
      if (anim.type === "rotate") {
        anim.obj.rotation.x += (anim.speedX || 0) * delta;
        anim.obj.rotation.y += (anim.speedY || 0) * delta;
        anim.obj.rotation.z += (anim.speedZ || 0) * delta;
      } else if (anim.type === "orbit") {
        const angle = t * (anim.speed || 1);
        const r = anim.radius || 5;
        anim.obj.position.x = anim.centerX + Math.cos(angle + anim.phase) * r;
        anim.obj.position.z = anim.centerZ + Math.sin(angle + anim.phase) * r;
        if (anim.tiltY) anim.obj.position.y = anim.baseY + Math.sin(angle * 0.7) * anim.tiltY;
      } else if (anim.type === "oscillate") {
        const axis = anim.axis || "y";
        const val = anim.origin + Math.sin(t * (anim.speed || 1) + anim.phase) * (anim.amplitude || 1);
        anim.obj.position[axis] = val;
      } else if (anim.type === "pulse") {
        const s = anim.baseScale + Math.sin(t * (anim.speed || 2)) * anim.amount;
        anim.obj.scale.setScalar(s);
      }
    }

    this.composer.render();
  }

  /* ── Destruir ── */
  dispose() {
    window.removeEventListener("resize", this._onResize);
    window.removeEventListener("keydown", this._onKeyDown);
    window.removeEventListener("keyup", this._onKeyUp);
    cancelAnimationFrame(this._rafId);
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  /* =========================================================================
     CONSTRUIR CENA A PARTIR DO JSON
     ========================================================================= */
  buildFromJSON(sceneData) {
    // Limpar cena anterior
    while (this.scene.children.length > 0) {
      this.scene.remove(this.scene.children[0]);
    }
    this.waterMeshes = [];
    this.particleSystems = [];
    this.animalGroups = [];

    const sd = sceneData;

    // Sky / Background
    this._buildSky(sd.sky || {});

    // Fog
    this._buildFog(sd.fog || sd.sky || {});

    // Lights
    this._buildLights(sd.lights || {});

    // Terrain
    if (sd.terrain) this._buildTerrain(sd.terrain);

    // Water
    if (sd.water) this._buildWater(sd.water);

    // Trees
    if (sd.trees) this._buildTrees(sd.trees);

    // Rocks
    if (sd.rocks) this._buildRocks(sd.rocks);

    // Clouds
    if (sd.clouds) this._buildClouds(sd.clouds);

    // Buildings / Structures
    if (sd.buildings) this._buildBuildings(sd.buildings);

    // Animals
    if (sd.animals) this._buildAnimals(sd.animals);

    // Particles
    if (sd.particles) this._buildParticles(sd.particles);

    // Custom objects
    if (sd.objects) this._buildCustomObjects(sd.objects);

    // Camera position
    if (sd.camera) {
      const c = sd.camera;
      this.camera.position.set(c.x || 0, c.y || 12, c.z || 35);
      if (c.lookAt) this.controls.target.set(c.lookAt.x || 0, c.lookAt.y || 2, c.lookAt.z || 0);
    }

    // Bloom
    if (sd.bloom) {
      this.bloomPass.strength = sd.bloom.strength ?? 0.15;
      this.bloomPass.radius = sd.bloom.radius ?? 0.4;
      this.bloomPass.threshold = sd.bloom.threshold ?? 0.9;
    }

    this._onResize();
  }

  /* ── Sky ── */
  _buildSky(sky) {
    const topColor = new THREE.Color(sky.topColor || "#1a1a2e");
    const bottomColor = new THREE.Color(sky.bottomColor || "#87CEEB");
    const midColor = sky.midColor ? new THREE.Color(sky.midColor) : bottomColor.clone().lerp(topColor, 0.5);

    const skyGeo = new THREE.SphereGeometry(200, 32, 32);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: {
        topColor: { value: topColor },
        midColor: { value: midColor },
        bottomColor: { value: bottomColor },
      },
      vertexShader: `
        varying vec3 vWorldPosition;
        void main() {
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPos.xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 midColor;
        uniform vec3 bottomColor;
        varying vec3 vWorldPosition;
        void main() {
          float h = normalize(vWorldPosition).y;
          vec3 col;
          if (h > 0.0) {
            col = mix(midColor, topColor, pow(h, 0.6));
          } else {
            col = mix(midColor, bottomColor, pow(-h, 0.4));
          }
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    this.scene.add(new THREE.Mesh(skyGeo, skyMat));
    this.scene.background = null; // usar sky mesh
  }

  /* ── Fog ── */
  _buildFog(fog) {
    const color = fog.fogColor || fog.bottomColor || "#87CEEB";
    const density = fog.density ?? 0.012;
    this.scene.fog = new THREE.FogExp2(color, density);
  }

  /* ── Lights ── */
  _buildLights(lights) {
    // Hemisphere
    const hemi = new THREE.HemisphereLight(
      lights.skyColor || "#ffffcc",
      lights.groundColor || "#3a5f2c",
      lights.hemisphereIntensity ?? 0.6
    );
    this.scene.add(hemi);

    // Ambient
    const ambient = new THREE.AmbientLight(
      lights.ambientColor || "#404060",
      lights.ambientIntensity ?? 0.3
    );
    this.scene.add(ambient);

    // Directional (sun)
    const sun = new THREE.DirectionalLight(
      lights.sunColor || "#ffe4b5",
      lights.sunIntensity ?? 1.2
    );
    const sx = lights.sunPosition?.x ?? 30;
    const sy = lights.sunPosition?.y ?? 40;
    const sz = lights.sunPosition?.z ?? 20;
    sun.position.set(sx, sy, sz);
    sun.castShadow = true;
    sun.shadow.mapSize.width = 2048;
    sun.shadow.mapSize.height = 2048;
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = 150;
    sun.shadow.camera.left = -60;
    sun.shadow.camera.right = 60;
    sun.shadow.camera.top = 60;
    sun.shadow.camera.bottom = -60;
    sun.shadow.bias = -0.001;
    this.scene.add(sun);

    // Extra point lights
    if (lights.points) {
      for (const pl of lights.points) {
        const pointLight = new THREE.PointLight(
          pl.color || "#ffffff", pl.intensity ?? 1, pl.distance ?? 20
        );
        pointLight.position.set(pl.x || 0, pl.y || 3, pl.z || 0);
        if (pl.castShadow) pointLight.castShadow = true;
        this.scene.add(pointLight);
      }
    }
  }

  /* ── Terreno ── */
  _buildTerrain(terrain) {
    const size = terrain.size || 120;
    const segments = Math.min(terrain.segments || 200, 256);
    const maxHeight = terrain.maxHeight || 8;
    const noiseScale = terrain.noiseScale || 0.02;

    const geo = new THREE.PlaneGeometry(size, size, segments, segments);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);

    // Cores do terreno
    const lowColor = new THREE.Color(terrain.lowColor || "#4a8c3f");
    const midColor = new THREE.Color(terrain.midColor || "#8B7355");
    const highColor = new THREE.Color(terrain.highColor || "#e8e8e8");
    const sandColor = new THREE.Color(terrain.sandColor || "#c2b280");

    const heights = new Float32Array(pos.count);

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      let h = fbm(x * noiseScale, y * noiseScale, 5) * maxHeight;

      // Planificação suave perto da borda
      const distFromCenter = Math.sqrt(x * x + y * y) / (size * 0.5);
      if (distFromCenter > 0.7) {
        h *= 1 - Math.pow((distFromCenter - 0.7) / 0.3, 2);
      }

      pos.setZ(i, h);
      heights[i] = h;

      // Coloração por altura
      const t = h / maxHeight;
      let col;
      if (t < 0.05) col = sandColor.clone();
      else if (t < 0.4) col = lowColor.clone().lerp(midColor, (t - 0.05) / 0.35);
      else if (t < 0.7) col = midColor.clone().lerp(highColor, (t - 0.4) / 0.3);
      else col = highColor.clone();

      // Variação aleatória sutil
      const variation = 0.9 + Math.random() * 0.2;
      colors[i * 3] = col.r * variation;
      colors[i * 3 + 1] = col.g * variation;
      colors[i * 3 + 2] = col.b * variation;
    }

    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: terrain.roughness ?? 0.85,
      metalness: 0.0,
      flatShading: terrain.flatShading !== false,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.receiveShadow = true;
    this.scene.add(mesh);

    // Armazenar heights para posicionar objetos
    this._terrain = { mesh, geo, pos, heights, size, segments, maxHeight, noiseScale };
  }

  _getTerrainHeight(x, z) {
    if (!this._terrain) return 0;
    return fbm(x * this._terrain.noiseScale, z * this._terrain.noiseScale, 5) * this._terrain.maxHeight;
  }

  /* ── Água ── */
  _buildWater(water) {
    const size = water.size || 80;
    const y = water.height ?? -0.1;
    const geo = new THREE.PlaneGeometry(size, size, 64, 64);
    geo.rotateX(-Math.PI / 2);

    // Salvar posições originais
    const origPositions = new Float32Array(geo.attributes.position.array);

    const mat = new THREE.MeshStandardMaterial({
      color: water.color || "#1a6b8a",
      transparent: true,
      opacity: water.opacity ?? 0.65,
      roughness: 0.1,
      metalness: 0.6,
      side: THREE.DoubleSide,
      flatShading: true,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = y;
    mesh.receiveShadow = true;
    mesh._origPositions = origPositions;
    this.scene.add(mesh);
    this.waterMeshes.push(mesh);
  }

  /* ── Árvores ── */
  _buildTrees(trees) {
    const count = Math.min(trees.count || 50, 200);
    const spread = trees.spread || 50;
    const types = trees.types || ["oak", "pine", "bush"];
    const minHeight = trees.minHeight || 2;
    const maxHeight = trees.maxHeight || 6;
    const avoidCenter = trees.avoidCenter ?? 3;

    for (let i = 0; i < count; i++) {
      let x, z, attempts = 0;
      do {
        x = (Math.random() - 0.5) * spread;
        z = (Math.random() - 0.5) * spread;
        attempts++;
      } while (Math.sqrt(x * x + z * z) < avoidCenter && attempts < 20);

      const y = this._getTerrainHeight(x, z);
      if (y < (trees.minTerrainHeight ?? -0.5)) continue;

      const type = types[Math.floor(Math.random() * types.length)];
      const height = minHeight + Math.random() * (maxHeight - minHeight);
      const tree = this._makeTree(type, height, trees);
      tree.position.set(x, y, z);
      tree.rotation.y = Math.random() * Math.PI * 2;
      this.scene.add(tree);
    }
  }

  _makeTree(type, height, config) {
    const group = new THREE.Group();
    const trunkColor = config.trunkColor || "#5C3A1E";
    const foliageColors = config.foliageColors || ["#2d6a1e", "#3a8c2a", "#4da83a", "#228B22", "#1a6b15"];

    const foliageColor = foliageColors[Math.floor(Math.random() * foliageColors.length)];

    // Tronco
    const trunkRadius = 0.08 + Math.random() * 0.08;
    const trunkGeo = new THREE.CylinderGeometry(trunkRadius * 0.7, trunkRadius, height * 0.6, 6);
    const trunkMat = new THREE.MeshStandardMaterial({
      color: trunkColor, roughness: 0.9, flatShading: true,
    });
    const trunk = new THREE.Mesh(trunkGeo, trunkMat);
    trunk.position.y = height * 0.3;
    trunk.castShadow = true;
    group.add(trunk);

    if (type === "pine") {
      // Pinheiro - vários cones empilhados
      const layers = 3 + Math.floor(Math.random() * 2);
      for (let j = 0; j < layers; j++) {
        const coneH = height * (0.35 - j * 0.05);
        const coneR = (height * 0.25) * (1 - j * 0.15);
        const coneGeo = new THREE.ConeGeometry(coneR, coneH, 7);
        const coneMat = new THREE.MeshStandardMaterial({
          color: foliageColor, roughness: 0.8, flatShading: true,
        });
        // Deslocar vértices para visual orgânico
        const cPos = coneGeo.attributes.position;
        for (let k = 0; k < cPos.count; k++) {
          cPos.setX(k, cPos.getX(k) + (Math.random() - 0.5) * 0.15);
          cPos.setZ(k, cPos.getZ(k) + (Math.random() - 0.5) * 0.15);
        }
        coneGeo.computeVertexNormals();
        const cone = new THREE.Mesh(coneGeo, coneMat);
        cone.position.y = height * 0.5 + j * coneH * 0.5;
        cone.castShadow = true;
        group.add(cone);
      }
    } else if (type === "bush") {
      // Arbusto - esferas baixas
      const bushCount = 2 + Math.floor(Math.random() * 3);
      for (let j = 0; j < bushCount; j++) {
        const r = 0.4 + Math.random() * 0.5;
        const bGeo = new THREE.IcosahedronGeometry(r, 1);
        // Displace
        const bPos = bGeo.attributes.position;
        for (let k = 0; k < bPos.count; k++) {
          const scale = 0.85 + Math.random() * 0.3;
          bPos.setX(k, bPos.getX(k) * scale);
          bPos.setY(k, bPos.getY(k) * scale);
          bPos.setZ(k, bPos.getZ(k) * scale);
        }
        bGeo.computeVertexNormals();
        const bMat = new THREE.MeshStandardMaterial({
          color: foliageColor, roughness: 0.85, flatShading: true,
        });
        const bush = new THREE.Mesh(bGeo, bMat);
        bush.position.set(
          (Math.random() - 0.5) * 0.6,
          r * 0.5 + Math.random() * 0.2,
          (Math.random() - 0.5) * 0.6
        );
        bush.castShadow = true;
        group.add(bush);
      }
    } else {
      // Oak/default - copa com icosaedro deformado + sub-copas
      const canopyR = height * 0.28 + Math.random() * height * 0.1;
      const canopyGeo = new THREE.IcosahedronGeometry(canopyR, 2);
      const cPos = canopyGeo.attributes.position;
      for (let k = 0; k < cPos.count; k++) {
        const scale = 0.8 + Math.random() * 0.4;
        cPos.setX(k, cPos.getX(k) * scale);
        cPos.setY(k, cPos.getY(k) * (0.7 + Math.random() * 0.3));
        cPos.setZ(k, cPos.getZ(k) * scale);
      }
      canopyGeo.computeVertexNormals();
      const canopyMat = new THREE.MeshStandardMaterial({
        color: foliageColor, roughness: 0.8, flatShading: true,
      });
      const canopy = new THREE.Mesh(canopyGeo, canopyMat);
      canopy.position.y = height * 0.65;
      canopy.castShadow = true;
      group.add(canopy);

      // Sub-copas extras
      const extras = 1 + Math.floor(Math.random() * 2);
      for (let j = 0; j < extras; j++) {
        const eR = canopyR * (0.5 + Math.random() * 0.3);
        const eGeo = new THREE.IcosahedronGeometry(eR, 1);
        const ePos = eGeo.attributes.position;
        for (let k = 0; k < ePos.count; k++) {
          ePos.setX(k, ePos.getX(k) * (0.8 + Math.random() * 0.4));
          ePos.setY(k, ePos.getY(k) * (0.7 + Math.random() * 0.3));
          ePos.setZ(k, ePos.getZ(k) * (0.8 + Math.random() * 0.4));
        }
        eGeo.computeVertexNormals();
        const fc2 = foliageColors[Math.floor(Math.random() * foliageColors.length)];
        const eMat = new THREE.MeshStandardMaterial({ color: fc2, roughness: 0.8, flatShading: true });
        const eMesh = new THREE.Mesh(eGeo, eMat);
        eMesh.position.set(
          (Math.random() - 0.5) * canopyR,
          height * 0.6 + (Math.random() - 0.3) * canopyR,
          (Math.random() - 0.5) * canopyR
        );
        eMesh.castShadow = true;
        group.add(eMesh);
      }
    }

    const scale = 0.8 + Math.random() * 0.4;
    group.scale.set(scale, scale, scale);
    return group;
  }

  /* ── Rochas ── */
  _buildRocks(rocks) {
    const count = Math.min(rocks.count || 20, 100);
    const spread = rocks.spread || 45;
    const colors = rocks.colors || ["#6b6b6b", "#7a7a6e", "#8a8275", "#5c5c5c"];

    for (let i = 0; i < count; i++) {
      const x = (Math.random() - 0.5) * spread;
      const z = (Math.random() - 0.5) * spread;
      const y = this._getTerrainHeight(x, z);
      const size = 0.2 + Math.random() * (rocks.maxSize || 1.2);

      const detail = size > 0.8 ? 1 : 0;
      const geo = new THREE.DodecahedronGeometry(size, detail);
      const pos = geo.attributes.position;
      for (let k = 0; k < pos.count; k++) {
        pos.setX(k, pos.getX(k) * (0.7 + Math.random() * 0.6));
        pos.setY(k, pos.getY(k) * (0.6 + Math.random() * 0.4));
        pos.setZ(k, pos.getZ(k) * (0.7 + Math.random() * 0.6));
      }
      geo.computeVertexNormals();

      const color = colors[Math.floor(Math.random() * colors.length)];
      const mat = new THREE.MeshStandardMaterial({
        color, roughness: 0.9, metalness: 0.05, flatShading: true,
      });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y + size * 0.15, z);
      mesh.rotation.set(Math.random() * 0.5, Math.random() * Math.PI, Math.random() * 0.5);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    }
  }

  /* ── Nuvens ── */
  _buildClouds(clouds) {
    const count = Math.min(clouds.count || 10, 30);
    const minY = clouds.minHeight || 20;
    const maxY = clouds.maxHeight || 35;
    const spread = clouds.spread || 80;

    for (let i = 0; i < count; i++) {
      const cloud = new THREE.Group();
      const puffs = 4 + Math.floor(Math.random() * 5);
      const cloudColor = clouds.color || "#ffffff";

      for (let j = 0; j < puffs; j++) {
        const r = 1.5 + Math.random() * 2;
        const geo = new THREE.SphereGeometry(r, 8, 6);
        const mat = new THREE.MeshStandardMaterial({
          color: cloudColor, transparent: true,
          opacity: 0.7 + Math.random() * 0.2, roughness: 1, flatShading: true,
        });
        const puff = new THREE.Mesh(geo, mat);
        puff.position.set(
          (Math.random() - 0.5) * 5,
          (Math.random() - 0.5) * 1.5,
          (Math.random() - 0.5) * 3
        );
        puff.scale.y *= 0.5 + Math.random() * 0.3;
        cloud.add(puff);
      }

      cloud.position.set(
        (Math.random() - 0.5) * spread,
        minY + Math.random() * (maxY - minY),
        (Math.random() - 0.5) * spread
      );
      cloud.scale.setScalar(0.8 + Math.random() * 0.8);
      this.scene.add(cloud);
    }
  }

  /* ── Construções ── */
  _buildBuildings(buildings) {
    const items = buildings.items || buildings;
    if (!Array.isArray(items)) return;

    for (const b of items) {
      const group = new THREE.Group();
      const w = b.width || 2;
      const h = b.height || 4;
      const d = b.depth || 2;

      // Corpo
      const bodyGeo = new THREE.BoxGeometry(w, h, d);
      const bodyMat = new THREE.MeshStandardMaterial({
        color: b.color || "#8B7355", roughness: 0.85, flatShading: true,
      });
      const body = new THREE.Mesh(bodyGeo, bodyMat);
      body.position.y = h / 2;
      body.castShadow = true;
      body.receiveShadow = true;
      group.add(body);

      // Telhado
      if (b.roof !== false) {
        const roofGeo = new THREE.ConeGeometry(Math.max(w, d) * 0.75, h * 0.3, 4);
        const roofMat = new THREE.MeshStandardMaterial({
          color: b.roofColor || "#8B0000", roughness: 0.8, flatShading: true,
        });
        const roof = new THREE.Mesh(roofGeo, roofMat);
        roof.position.y = h + h * 0.15;
        roof.rotation.y = Math.PI / 4;
        roof.castShadow = true;
        group.add(roof);
      }

      const bx = b.x || 0, bz = b.z || 0;
      const by = this._getTerrainHeight(bx, bz);
      group.position.set(bx, by, bz);
      group.rotation.y = b.rotation || 0;
      this.scene.add(group);
    }
  }

  /* ── Animais ── */
  _buildAnimals(animals) {
    const items = animals.items || animals;
    if (!Array.isArray(items)) return;

    for (const a of items) {
      const animal = this._makeAnimal(a);
      const ax = a.x ?? (Math.random() - 0.5) * 30;
      const az = a.z ?? (Math.random() - 0.5) * 30;
      const ay = this._getTerrainHeight(ax, az);
      animal.group.position.set(ax, ay + (a.flyHeight || 0), az);
      animal.group.rotation.y = a.rotation ?? Math.random() * Math.PI * 2;
      animal.baseY = ay + (a.flyHeight || 0);
      animal.phase = Math.random() * Math.PI * 2;
      this.scene.add(animal.group);
      this.animalGroups.push(animal);
    }
  }

  _makeAnimal(config) {
    const group = new THREE.Group();
    const type = (config.type || "deer").toLowerCase();
    const color = config.color || "#8B6914";
    const scale = config.scale || 1;

    let head = null;

    if (type === "bird" || type === "pássaro") {
      // Corpo
      const bodyGeo = new THREE.SphereGeometry(0.2, 6, 4);
      bodyGeo.scale(1.5, 0.8, 0.8);
      const bodyMat = new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.7 });
      const body = new THREE.Mesh(bodyGeo, bodyMat);
      body.position.y = 0.2;
      group.add(body);
      // Asas
      for (const side of [-1, 1]) {
        const wingGeo = new THREE.PlaneGeometry(0.5, 0.15);
        const wingMat = new THREE.MeshStandardMaterial({ color, flatShading: true, side: THREE.DoubleSide });
        const wing = new THREE.Mesh(wingGeo, wingMat);
        wing.position.set(side * 0.25, 0.25, 0);
        wing.rotation.z = side * 0.3;
        group.add(wing);
      }
      // Cabeça
      const headGeo = new THREE.SphereGeometry(0.1, 5, 4);
      head = new THREE.Mesh(headGeo, bodyMat);
      head.position.set(0.25, 0.35, 0);
      group.add(head);

    } else if (type === "fish" || type === "peixe") {
      const bodyGeo = new THREE.SphereGeometry(0.3, 6, 4);
      bodyGeo.scale(2, 0.7, 0.5);
      const bodyMat = new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.3, metalness: 0.4 });
      const body = new THREE.Mesh(bodyGeo, bodyMat);
      group.add(body);
      // Cauda
      const tailGeo = new THREE.ConeGeometry(0.2, 0.3, 3);
      const tail = new THREE.Mesh(tailGeo, bodyMat);
      tail.position.set(-0.55, 0, 0);
      tail.rotation.z = Math.PI / 2;
      group.add(tail);

    } else if (type === "rabbit" || type === "coelho") {
      const bodyGeo = new THREE.SphereGeometry(0.25, 6, 5);
      bodyGeo.scale(1, 0.8, 0.8);
      const bodyMat = new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.8 });
      const body = new THREE.Mesh(bodyGeo, bodyMat);
      body.position.y = 0.25;
      group.add(body);
      // Cabeça
      const headGeo = new THREE.SphereGeometry(0.15, 5, 4);
      head = new THREE.Mesh(headGeo, bodyMat);
      head.position.set(0.2, 0.45, 0);
      group.add(head);
      // Orelhas
      for (const side of [-0.06, 0.06]) {
        const earGeo = new THREE.CylinderGeometry(0.03, 0.02, 0.2, 4);
        const ear = new THREE.Mesh(earGeo, bodyMat);
        ear.position.set(0.2, 0.6, side);
        group.add(ear);
      }
      // Pernas
      for (const pos of [[-0.1, 0, 0.1], [-0.1, 0, -0.1], [0.1, 0, 0.08], [0.1, 0, -0.08]]) {
        const legGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.15, 4);
        const leg = new THREE.Mesh(legGeo, bodyMat);
        leg.position.set(...pos);
        group.add(leg);
      }

    } else {
      // Deer/default = quadrúpede genérico
      const bodyGeo = new THREE.SphereGeometry(0.4, 6, 5);
      bodyGeo.scale(1.6, 0.8, 0.7);
      const bodyMat = new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.8 });
      const body = new THREE.Mesh(bodyGeo, bodyMat);
      body.position.y = 0.7;
      group.add(body);
      // Cabeça
      const headGeo = new THREE.SphereGeometry(0.18, 5, 4);
      head = new THREE.Mesh(headGeo, bodyMat);
      head.position.set(0.55, 0.95, 0);
      group.add(head);
      // Pernas
      for (const pos of [[-0.25, 0.3, 0.15], [-0.25, 0.3, -0.15], [0.3, 0.3, 0.12], [0.3, 0.3, -0.12]]) {
        const legGeo = new THREE.CylinderGeometry(0.04, 0.035, 0.5, 5);
        const legMat = new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.8 });
        const leg = new THREE.Mesh(legGeo, legMat);
        leg.position.set(...pos);
        group.add(leg);
      }
      // Chifres/orelhas
      for (const side of [-0.08, 0.08]) {
        const earGeo = new THREE.ConeGeometry(0.03, 0.15, 3);
        const ear = new THREE.Mesh(earGeo, bodyMat);
        ear.position.set(0.55, 1.15, side);
        group.add(ear);
      }
    }

    group.scale.setScalar(scale);
    return { group, head };
  }

  /* ── Partículas ── */
  _buildParticles(particles) {
    const items = Array.isArray(particles) ? particles : [particles];

    for (const p of items) {
      const count = Math.min(p.count || 100, 500);
      const spread = p.spread || 40;
      const geo = new THREE.BufferGeometry();
      const positions = new Float32Array(count * 3);

      const minY = p.minY ?? 0;
      const maxY = p.maxY ?? 15;
      const speeds = new Float32Array(count);
      const phases = new Float32Array(count);
      const baseY = new Float32Array(count);

      for (let i = 0; i < count; i++) {
        positions[i * 3] = (Math.random() - 0.5) * spread;
        positions[i * 3 + 1] = minY + Math.random() * (maxY - minY);
        positions[i * 3 + 2] = (Math.random() - 0.5) * spread;
        speeds[i] = p.speed ?? (0.005 + Math.random() * 0.01);
        phases[i] = Math.random() * Math.PI * 2;
        baseY[i] = positions[i * 3 + 1];
      }

      geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));

      const mat = new THREE.PointsMaterial({
        color: p.color || "#ffff88",
        size: p.size || 0.12,
        transparent: true,
        opacity: p.opacity ?? 0.8,
        sizeAttenuation: true,
      });

      // Emissive glow - use additive blending for fireflies
      if (p.glow) {
        mat.blending = THREE.AdditiveBlending;
        mat.depthWrite = false;
      }

      const points = new THREE.Points(geo, mat);
      points._count = count;
      points._speeds = speeds;
      points._phases = phases;
      points._baseY = baseY;
      points._minY = minY;
      points._maxY = maxY;
      points._type = p.movement || "float"; // "rise", "fall", "float"
      this.scene.add(points);
      this.particleSystems.push(points);
    }
  }

  /* ── Objetos customizados ── */
  _buildCustomObjects(objects) {
    if (!Array.isArray(objects)) return;

    for (const o of objects) {
      let geo, mat;
      const color = o.color || "#ffffff";
      const shading = { roughness: o.roughness ?? 0.7, flatShading: true };

      switch (o.shape) {
        case "sphere":
          geo = new THREE.SphereGeometry(o.radius || 1, o.detail || 8, o.detail || 6);
          break;
        case "box":
          geo = new THREE.BoxGeometry(o.width || 1, o.height || 1, o.depth || 1);
          break;
        case "cylinder":
          geo = new THREE.CylinderGeometry(o.radiusTop || 0.5, o.radiusBottom || 0.5, o.height || 1, o.segments || 8);
          break;
        case "cone":
          geo = new THREE.ConeGeometry(o.radius || 0.5, o.height || 1, o.segments || 8);
          break;
        case "torus":
          geo = new THREE.TorusGeometry(o.radius || 1, o.tube || 0.3, 12, 24);
          break;
        default:
          geo = new THREE.SphereGeometry(o.radius || 1, 8, 6);
      }

      if (o.emissive) {
        mat = new THREE.MeshStandardMaterial({
          color, emissive: o.emissive, emissiveIntensity: o.emissiveIntensity || 1,
          ...shading,
        });
      } else {
        mat = new THREE.MeshStandardMaterial({ color, ...shading });
      }

      const mesh = new THREE.Mesh(geo, mat);
      const ox = o.x || 0, oz = o.z || 0;
      const oy = o.y ?? this._getTerrainHeight(ox, oz);
      mesh.position.set(ox, oy, oz);
      if (o.rotation) mesh.rotation.set(o.rotation.x || 0, o.rotation.y || 0, o.rotation.z || 0);
      if (o.scale) mesh.scale.setScalar(o.scale);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);

      // Animação no objeto
      if (o.animation) {
        const a = o.animation;
        if (a.type === "rotate") {
          this.animatedObjects.push({
            type: "rotate", obj: mesh,
            speedX: a.speedX || 0, speedY: a.speedY || 0, speedZ: a.speedZ || 0,
          });
        } else if (a.type === "orbit") {
          this.animatedObjects.push({
            type: "orbit", obj: mesh,
            centerX: a.centerX ?? ox, centerZ: a.centerZ ?? oz,
            baseY: oy, radius: a.radius || 5, speed: a.speed || 1,
            tiltY: a.tiltY || 0, phase: Math.random() * Math.PI * 2,
          });
        } else if (a.type === "oscillate") {
          this.animatedObjects.push({
            type: "oscillate", obj: mesh,
            axis: a.axis || "y", origin: mesh.position[a.axis || "y"],
            amplitude: a.amplitude || 1, speed: a.speed || 1,
            phase: Math.random() * Math.PI * 2,
          });
        } else if (a.type === "pulse") {
          this.animatedObjects.push({
            type: "pulse", obj: mesh,
            baseScale: o.scale || 1, amount: a.amount || 0.2, speed: a.speed || 2,
          });
        }
      }
    }
  }
}
