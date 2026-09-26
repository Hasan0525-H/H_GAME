import * as THREE from 'https://esm.sh/three@0.160.1';
import { PointerLockControls } from 'https://esm.sh/three@0.160.1/examples/jsm/controls/PointerLockControls.js';

const CENTER = { lat: 18.58979, lon: 41.4123419 };
const LOAD_RADIUS_M = 1700;
const STREAM_CELL_M = 1250;
const EYE_HEIGHT = 1.72;
const PLAYER_RADIUS = 0.34;

const loadedCells = new Set();
const renderedWays = new Set();
const renderedNodes = new Set();
const buildingPolys = [];
const solidSegments = [];
const roadSegments = [];
let didInitialSnap = false;
let unknownBuildingHeightCount = 0;
let loadingCount = 0;

const root = document.getElementById('game');
const statusEl = document.getElementById('status');
const coordsEl = document.getElementById('coords');
const roadNameEl = document.getElementById('roadName');
const start = document.getElementById('start');
const startBtn = document.getElementById('startBtn');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xaacbe5);
scene.fog = new THREE.FogExp2(0xcbbf9f, 0.000095);

const camera = new THREE.PerspectiveCamera(68, innerWidth / innerHeight, 0.08, 9000);
camera.position.set(0, EYE_HEIGHT, 0);

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: 'high-performance'
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.65));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.02;
root.appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight(0xe6f1ff, 0x9e825e, 2.1));

const sun = new THREE.DirectionalLight(0xffefd2, 2.45);
sun.position.set(-900, 1200, -650);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -1900;
sun.shadow.camera.right = 1900;
sun.shadow.camera.top = 1900;
sun.shadow.camera.bottom = -1900;
sun.shadow.camera.near = 50;
sun.shadow.camera.far = 3500;
scene.add(sun);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(30000, 30000),
  new THREE.MeshStandardMaterial({ color: 0xcab88f, roughness: 1 })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.04;
ground.receiveShadow = true;
scene.add(ground);

const controls = new PointerLockControls(camera, renderer.domElement);
const clock = new THREE.Clock();
const keys = new Set();
let mobileMove = { x: 0, y: 0 };
let yaw = 0;
let pitch = 0;
let lastStreamCheck = 0;
const isCoarse = matchMedia('(pointer:coarse)').matches;

addEventListener('keydown', e => keys.add(e.code));
addEventListener('keyup', e => keys.delete(e.code));

startBtn.addEventListener('click', () => {
  start.style.display = 'none';
  if (!isCoarse) controls.lock();
});

renderer.domElement.addEventListener('click', () => {
  if (!isCoarse && start.style.display === 'none' && !controls.isLocked) controls.lock();
});

function metersPerDegree() {
  const latRad = CENTER.lat * Math.PI / 180;
  return { lat: 111320, lon: 111320 * Math.cos(latRad) };
}
const MPD = metersPerDegree();

function toXY(lat, lon) {
  return [(lon - CENTER.lon) * MPD.lon, -(lat - CENTER.lat) * MPD.lat];
}

function toLatLon(x, z) {
  return {
    lat: CENTER.lat + (-z) / MPD.lat,
    lon: CENTER.lon + x / MPD.lon
  };
}

function isClosed(points) {
  if (points.length < 3) return false;
  const a = points[0], b = points[points.length - 1];
  return Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.5;
}

function makeShape(points) {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], -points[0][1]);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], -points[i][1]);
  return shape;
}

function parseColor(value, fallback) {
  if (!value) return fallback;
  const named = {
    white: 0xe8e1d4, beige: 0xd7c4a2, brown: 0xa98d6d,
    grey: 0xb8b5ab, gray: 0xb8b5ab, yellow: 0xd9c48a
  };
  if (named[value]) return named[value];
  if (/^#[0-9a-f]{6}$/i.test(value)) return Number('0x' + value.slice(1));
  return fallback;
}

function roadWidth(type, tags) {
  const lanes = Math.max(0, parseFloat(tags.lanes) || 0);
  const taggedWidth = parseFloat(tags.width);
  if (Number.isFinite(taggedWidth) && taggedWidth > 1) return Math.min(taggedWidth, 20);
  if (lanes) return Math.min(Math.max(lanes * 3.1, 3.5), 18);
  return ({
    motorway: 11, trunk: 10, primary: 9, secondary: 8, tertiary: 7,
    residential: 5.7, unclassified: 5.2, service: 4.2, track: 3.2,
    path: 2, footway: 1.7
  })[type] || 4.8;
}

function roadColor(tags) {
  const surface = tags.surface || '';
  if (['dirt', 'earth', 'sand', 'ground', 'unpaved'].includes(surface)) return 0xbba67f;
  if (['gravel', 'fine_gravel'].includes(surface)) return 0xa99f8d;
  const t = tags.highway;
  if (['motorway', 'trunk', 'primary'].includes(t)) return 0x4e5054;
  if (['secondary', 'tertiary'].includes(t)) return 0x5b5c60;
  return 0x6c6a66;
}

function addSegmentBox(a, b, width, height, color, y = 0.02, cast = false) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const len = Math.hypot(dx, dz);
  if (len < 0.3) return null;
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(width, height, len),
    new THREE.MeshStandardMaterial({ color, roughness: 0.96 })
  );
  mesh.position.set((a[0] + b[0]) / 2, y + height / 2, (a[1] + b[1]) / 2);
  mesh.rotation.y = Math.atan2(dx, dz);
  mesh.receiveShadow = true;
  mesh.castShadow = cast;
  scene.add(mesh);
  return mesh;
}

function addRoad(points, tags) {
  if (points.length < 2) return;
  const width = roadWidth(tags.highway, tags);
  const color = roadColor(tags);
  const paved = !['dirt', 'earth', 'sand', 'ground', 'unpaved', 'gravel', 'fine_gravel'].includes(tags.surface || '');

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 0.5) continue;

    addSegmentBox(a, b, width, 0.035, color, 0.005, false);
    roadSegments.push({
      a, b, width, highway: tags.highway,
      name: tags.name || tags['name:ar'] || '',
      ref: tags.ref || ''
    });

    // Do not invent painted lane markings. Render only when the map explicitly says they exist.
    const explicitMarkings =
      tags.lane_markings === 'yes' ||
      tags['centre_line'] === 'yes' ||
      tags['center_line'] === 'yes';
    if (paved && explicitMarkings) {
      const line = addSegmentBox(a, b, 0.11, 0.012, 0xe8dfbd, 0.038, false);
      if (line) line.material.roughness = 0.82;
    }

    // Sidewalks are drawn only when explicitly mapped, on the mapped side.
    const sidewalk = tags.sidewalk;
    if (sidewalk && sidewalk !== 'no' && sidewalk !== 'separate') {
      const offset = width / 2 + 0.8;
      const px = (-dz / len) * offset, pz = (dx / len) * offset;
      if (sidewalk === 'left' || sidewalk === 'both' || sidewalk === 'yes') {
        addSegmentBox([a[0] + px, a[1] + pz], [b[0] + px, b[1] + pz], 1.25, 0.06, 0xc1b6a0, 0.02);
      }
      if (sidewalk === 'right' || sidewalk === 'both') {
        addSegmentBox([a[0] - px, a[1] - pz], [b[0] - px, b[1] - pz], 1.25, 0.06, 0xc1b6a0, 0.02);
      }
    }
  }
}

function heightFromTags(tags) {
  const h = parseFloat(tags.height);
  if (Number.isFinite(h)) return { value: Math.min(Math.max(h, 2.6), 32), exact: true };
  const levels = parseFloat(tags['building:levels']);
  if (Number.isFinite(levels)) return { value: Math.min(Math.max(levels * 3.05, 3), 28), exact: true };

  // Unknown height: use one neutral low block only so the mapped footprint is visible.
  // This is deliberately not varied per building, avoiding invented skyline differences.
  unknownBuildingHeightCount++;
  return { value: 3.2, exact: false };
}

function registerSolidPolygon(points) {
  const poly = points.slice(0, isClosed(points) ? -1 : points.length);
  if (poly.length < 3) return;
  buildingPolys.push(poly);
  for (let i = 0; i < poly.length; i++) {
    solidSegments.push({ a: poly[i], b: poly[(i + 1) % poly.length], r: PLAYER_RADIUS });
  }
}

function addBuilding(points, tags, id) {
  if (points.length < 4 || !isClosed(points)) return;
  const heightInfo = heightFromTags(tags);
  const height = heightInfo.value;
  const geo = new THREE.ExtrudeGeometry(makeShape(points), {
    depth: height,
    bevelEnabled: false,
    curveSegments: 1
  });
  geo.rotateX(-Math.PI / 2);

  const baseColor = parseColor(tags['building:colour'], 0xd8cbb2);
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color: baseColor, roughness: 0.91 })
  );
  mesh.position.y = 0.045;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  registerSolidPolygon(points);

  // ExtrudeGeometry already closes the top. Do not add a guessed roof shape.
  // Roof-specific geometry will only be added later when reliable roof tags or ground references exist.
}

function landColor(tags) {
  if (tags.natural === 'water') return 0x6f929c;
  if (tags.natural === 'sand') return 0xd7c399;
  if (tags.natural === 'scrub') return 0xa9a176;
  if (tags.natural === 'wood') return 0x8c936b;
  const l = tags.landuse || tags.leisure || '';
  return ({
    residential: 0xc4b18c,
    farmland: 0xb5a574,
    farmyard: 0xb8a17b,
    orchard: 0x9fa477,
    grass: 0xa9a775,
    meadow: 0xaaa77a,
    cemetery: 0xa4a27b,
    recreation_ground: 0xa6a77b,
    park: 0x9ea77d
  })[l] || 0xc7b58e;
}

function addArea(points, tags) {
  if (points.length < 4 || !isClosed(points)) return;
  const geo = new THREE.ShapeGeometry(makeShape(points));
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({
    color: landColor(tags),
    roughness: 1,
    transparent: true,
    opacity: 0.92,
    depthWrite: false
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = -0.015;
  mesh.receiveShadow = true;
  scene.add(mesh);
}

function barrierHeight(tags) {
  if (Number.isFinite(parseFloat(tags.height))) return Math.min(parseFloat(tags.height), 4);
  if (tags.barrier === 'wall') return 1.85;
  if (tags.barrier === 'fence') return 1.35;
  if (tags.barrier === 'retaining_wall') return 1.3;
  return 1.1;
}

function addBarrier(points, tags) {
  if (points.length < 2) return;
  const h = barrierHeight(tags);
  const fence = tags.barrier === 'fence';
  const color = fence ? 0x77736a : 0xbca98a;
  const width = fence ? 0.055 : 0.18;
  for (let i = 0; i < points.length - 1; i++) {
    addSegmentBox(points[i], points[i + 1], width, h, color, 0, true);
    solidSegments.push({ a: points[i], b: points[i + 1], r: PLAYER_RADIUS + width * 0.5 });
  }
}

function addWaterway(points, tags) {
  // A mapped waterway line does not prove visible standing water.
  // Only render it when width is explicitly mapped; otherwise preserve it as data but not scenery.
  const mappedWidth = parseFloat(tags.width);
  if (points.length < 2 || !Number.isFinite(mappedWidth) || mappedWidth <= 0) return;
  const color = tags.intermittent === 'yes' ? 0xb5a785 : 0x738e93;
  const width = Math.min(Math.max(mappedWidth, 0.8), 12);
  for (let i = 0; i < points.length - 1; i++) {
    addSegmentBox(points[i], points[i + 1], width, 0.012, color, -0.015, false);
  }
}

function addPowerLine(points) {
  if (points.length < 2) return;
  const geom = new THREE.BufferGeometry().setFromPoints(
    points.map(p => new THREE.Vector3(p[0], 9.3, p[1]))
  );
  scene.add(new THREE.Line(geom, new THREE.LineBasicMaterial({ color: 0x3f3b36 })));
}

function cylinder(radius, height, color, x, y, z) {
  const m = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, height, 8),
    new THREE.MeshStandardMaterial({ color, roughness: 0.9 })
  );
  m.position.set(x, y + height / 2, z);
  m.castShadow = true;
  scene.add(m);
  return m;
}

function addTree(x, z) {
  cylinder(0.12, 2.15, 0x6f573c, x, 0, z);
  const crown = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1.35, 1),
    new THREE.MeshStandardMaterial({ color: 0x68744b, roughness: 1 })
  );
  crown.scale.set(1.15, 0.95, 1.15);
  crown.position.set(x, 2.65, z);
  crown.castShadow = true;
  scene.add(crown);
}

function addPowerPole(x, z, tower = false) {
  const h = tower ? 14 : 8.5;
  cylinder(tower ? 0.13 : 0.09, h, 0x777570, x, 0, z);
}

function addStreetLamp(x, z) {
  cylinder(0.055, 6.3, 0x77756f, x, 0, z);
  const head = new THREE.Mesh(
    new THREE.BoxGeometry(0.75, 0.12, 0.24),
    new THREE.MeshStandardMaterial({ color: 0x77756f, roughness: 0.75 })
  );
  head.position.set(x + 0.28, 6.15, z);
  scene.add(head);
}

function addNodeFeature(node) {
  if (!node.tags) return;
  if (renderedNodes.has(node.id)) return;
  const t = node.tags;
  if (!(t.natural === 'tree' || t.power === 'pole' || t.power === 'tower' || t.highway === 'street_lamp')) return;
  renderedNodes.add(node.id);
  const [x, z] = toXY(node.lat, node.lon);
  if (t.natural === 'tree') addTree(x, z);
  else if (t.power === 'pole') addPowerPole(x, z, false);
  else if (t.power === 'tower') addPowerPole(x, z, true);
  else if (t.highway === 'street_lamp') addStreetLamp(x, z);
}

async function fetchOSMAt(lat, lon) {
  const q =
    '[out:json][timeout:40];(' +
    'way["highway"](around:' + LOAD_RADIUS_M + ',' + lat + ',' + lon + ');' +
    'way["building"](around:' + LOAD_RADIUS_M + ',' + lat + ',' + lon + ');' +
    'way["barrier"](around:' + LOAD_RADIUS_M + ',' + lat + ',' + lon + ');' +
    'way["landuse"](around:' + LOAD_RADIUS_M + ',' + lat + ',' + lon + ');' +
    'way["leisure"](around:' + LOAD_RADIUS_M + ',' + lat + ',' + lon + ');' +
    'way["natural"](around:' + LOAD_RADIUS_M + ',' + lat + ',' + lon + ');' +
    'way["waterway"](around:' + LOAD_RADIUS_M + ',' + lat + ',' + lon + ');' +
    'way["power"="line"](around:' + LOAD_RADIUS_M + ',' + lat + ',' + lon + ');' +
    'node["natural"="tree"](around:' + LOAD_RADIUS_M + ',' + lat + ',' + lon + ');' +
    'node["power"~"pole|tower"](around:' + LOAD_RADIUS_M + ',' + lat + ',' + lon + ');' +
    'node["highway"="street_lamp"](around:' + LOAD_RADIUS_M + ',' + lat + ',' + lon + ');' +
    ');(._;>;);out body;';

  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.nchc.org.tw/api/interpreter'
  ];

  let lastErr;
  loadingCount++;
  statusEl.textContent = 'جاري جلب التفاصيل الحقيقية حول موقعك...';

  for (const ep of endpoints) {
    try {
      const response = await fetch(ep, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: 'data=' + encodeURIComponent(q)
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const json = await response.json();
      loadingCount--;
      return json;
    } catch (err) {
      lastErr = err;
    }
  }

  loadingCount--;
  throw lastErr || new Error('تعذر جلب الخريطة');
}

function buildFromOSM(data) {
  const nodes = new Map();
  for (const e of data.elements) if (e.type === 'node') nodes.set(e.id, e);
  for (const e of data.elements) if (e.type === 'node') addNodeFeature(e);

  let roads = 0, buildings = 0, details = 0;

  for (const e of data.elements) {
    if (e.type !== 'way' || !e.nodes || !e.tags) continue;
    if (renderedWays.has(e.id)) continue;
    const pts = e.nodes.map(id => nodes.get(id)).filter(Boolean).map(n => toXY(n.lat, n.lon));
    if (pts.length < 2) continue;

    renderedWays.add(e.id);

    if (e.tags.highway) {
      addRoad(pts, e.tags);
      roads++;
    } else if (e.tags.building) {
      addBuilding(pts, e.tags, e.id);
      buildings++;
    } else if (e.tags.barrier) {
      addBarrier(pts, e.tags);
      details++;
    } else if (e.tags.waterway) {
      addWaterway(pts, e.tags);
      details++;
    } else if (e.tags.power === 'line') {
      addPowerLine(pts);
      details++;
    } else if (e.tags.landuse || e.tags.leisure || e.tags.natural) {
      addArea(pts, e.tags);
      details++;
    }
  }

  statusEl.textContent =
    'المحمّل من الخريطة: ' + roads + ' طريق، ' + buildings + ' مبنى، ' + details + ' عنصر موثق' +
    (unknownBuildingHeightCount ? ' • ارتفاع غير موثق: ' + unknownBuildingHeightCount : '');

  if (!didInitialSnap && roadSegments.length) {
    snapStartToNearestRoad();
    didInitialSnap = true;
  }
}

function closestPointOnSegment(px, pz, a, b) {
  const vx = b[0] - a[0], vz = b[1] - a[1];
  const l2 = vx * vx + vz * vz;
  if (!l2) return { x: a[0], z: a[1], d2: (px - a[0]) ** 2 + (pz - a[1]) ** 2, t: 0 };
  const t = Math.max(0, Math.min(1, ((px - a[0]) * vx + (pz - a[1]) * vz) / l2));
  const x = a[0] + t * vx, z = a[1] + t * vz;
  return { x, z, d2: (px - x) ** 2 + (pz - z) ** 2, t };
}

function snapStartToNearestRoad() {
  let best = null;
  for (const s of roadSegments) {
    const p = closestPointOnSegment(0, 0, s.a, s.b);
    if (!best || p.d2 < best.d2) best = { ...p, s };
  }
  if (!best || best.d2 > 250 * 250) return;
  camera.position.x = best.x;
  camera.position.z = best.z;
  const dx = best.s.b[0] - best.s.a[0];
  const dz = best.s.b[1] - best.s.a[1];
  yaw = Math.atan2(-dx, -dz);
  if (isCoarse) camera.rotation.y = yaw;
}

async function streamAroundPlayer(force = false) {
  const ll = toLatLon(camera.position.x, camera.position.z);
  const cx = Math.floor(camera.position.x / STREAM_CELL_M);
  const cz = Math.floor(camera.position.z / STREAM_CELL_M);
  const key = cx + ',' + cz;

  if (!force && loadedCells.has(key)) return;
  loadedCells.add(key);

  try {
    const data = await fetchOSMAt(ll.lat, ll.lon);
    buildFromOSM(data);
  } catch (err) {
    console.error(err);
    loadedCells.delete(key);
    statusEl.textContent = 'تعذر تحميل هذا الجزء الآن؛ لم تتم إضافة أي معالم مختلقة.';
  }
}

function pointInPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], zi = poly[i][1];
    const xj = poly[j][0], zj = poly[j][1];
    const hit = ((zi > z) !== (zj > z)) &&
      (x < (xj - xi) * (z - zi) / ((zj - zi) || 1e-9) + xi);
    if (hit) inside = !inside;
  }
  return inside;
}

function distanceToSegment(x, z, a, b) {
  return Math.sqrt(closestPointOnSegment(x, z, a, b).d2);
}

function collides(x, z) {
  for (const poly of buildingPolys) {
    if (pointInPoly(x, z, poly)) return true;
  }
  for (const s of solidSegments) {
    if (distanceToSegment(x, z, s.a, s.b) < s.r) return true;
  }
  return false;
}

function updateCoords() {
  const p = toLatLon(camera.position.x, camera.position.z);
  coordsEl.textContent = p.lat.toFixed(6) + ', ' + p.lon.toFixed(6);

  if (!roadNameEl || !roadSegments.length) return;
  let best = null;
  for (const s of roadSegments) {
    if (!s.name && !s.ref) continue;
    const cp = closestPointOnSegment(camera.position.x, camera.position.z, s.a, s.b);
    if (!best || cp.d2 < best.d2) best = { d2: cp.d2, s };
  }
  if (best && best.d2 < 45 * 45) {
    const label = best.s.name || best.s.ref;
    roadNameEl.textContent = 'الطريق: ' + label;
  } else {
    roadNameEl.textContent = 'الطريق: غير مسمّى في البيانات';
  }
}

function attemptMove(dx, dz) {
  const oldX = camera.position.x, oldZ = camera.position.z;
  const nx = oldX + dx, nz = oldZ + dz;

  if (!collides(nx, oldZ)) camera.position.x = nx;
  if (!collides(camera.position.x, nz)) camera.position.z = nz;
}

function move(dt) {
  const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight')) ? 6.2 : 3.25;
  let f = 0, s = 0;

  if (keys.has('KeyW') || keys.has('ArrowUp')) f += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) f -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) s += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) s -= 1;

  f += -mobileMove.y;
  s += mobileMove.x;

  const len = Math.hypot(f, s);
  if (len > 1) { f /= len; s /= len; }

  let viewYaw;
  if (isCoarse) {
    camera.rotation.order = 'YXZ';
    camera.rotation.y = yaw;
    camera.rotation.x = pitch;
    viewYaw = yaw;
  } else {
    viewYaw = camera.rotation.y;
  }

  const forwardX = -Math.sin(viewYaw);
  const forwardZ = -Math.cos(viewYaw);
  const rightX = Math.cos(viewYaw);
  const rightZ = -Math.sin(viewYaw);

  const dx = (forwardX * f + rightX * s) * speed * dt;
  const dz = (forwardZ * f + rightZ * s) * speed * dt;
  attemptMove(dx, dz);

  camera.position.y = EYE_HEIGHT;
}

let lastTouch = null;

renderer.domElement.addEventListener('touchstart', e => {
  const t = e.changedTouches[0];
  if (t.clientX > innerWidth * 0.35) lastTouch = { x: t.clientX, y: t.clientY };
}, { passive: true });

renderer.domElement.addEventListener('touchmove', e => {
  if (!lastTouch) return;
  const t = e.changedTouches[0];
  yaw -= (t.clientX - lastTouch.x) * 0.004;
  pitch -= (t.clientY - lastTouch.y) * 0.004;
  pitch = Math.max(-1.25, Math.min(1.25, pitch));
  lastTouch = { x: t.clientX, y: t.clientY };
}, { passive: true });

renderer.domElement.addEventListener('touchend', () => {
  lastTouch = null;
}, { passive: true });

const joy = document.getElementById('joystick');
const stick = document.getElementById('stick');
let joyId = null;

function joyMove(t) {
  const r = joy.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  let dx = t.clientX - cx, dy = t.clientY - cy;
  const max = 38, len = Math.hypot(dx, dy);
  if (len > max) { dx = dx / len * max; dy = dy / len * max; }
  mobileMove = { x: dx / max, y: dy / max };
  stick.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
}

joy.addEventListener('touchstart', e => {
  const t = e.changedTouches[0];
  joyId = t.identifier;
  joyMove(t);
  e.preventDefault();
}, { passive: false });

joy.addEventListener('touchmove', e => {
  const t = [...e.changedTouches].find(x => x.identifier === joyId);
  if (t) joyMove(t);
  e.preventDefault();
}, { passive: false });

joy.addEventListener('touchend', () => {
  joyId = null;
  mobileMove = { x: 0, y: 0 };
  stick.style.transform = 'translate(0,0)';
});

streamAroundPlayer(true);

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.04);
  move(dt);
  updateCoords();

  lastStreamCheck += dt;
  if (lastStreamCheck > 2.25) {
    lastStreamCheck = 0;
    streamAroundPlayer(false);
  }

  renderer.render(scene, camera);
}
animate();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
