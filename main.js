import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

const CENTER = { lat: 18.58979, lon: 41.4123419 };
const LOAD_RADIUS_M = 1700;
const STREAM_CELL_M = 1250;
const EYE_HEIGHT = 1.72;
const PLAYER_RADIUS = 0.34;
const COLLISION_CELL_M = 80;

const loadedCells = new Set();
const renderedWays = new Set();
const renderedNodes = new Set();
const namedFeatureIds = new Set();
const buildingPolys = [];
const solidSegments = [];
const roadSegments = [];
const collisionCells = new Map();
const verifiedOverrides = new Map();
let referenceCatalog = [];
let bundledSnapshot = null;
let externalBuildingsLoaded = false;
let externalBuildingCount = 0;
const namedFeatures = [];
const inspectables = [];
const raycaster = new THREE.Raycaster();
const barrierGateNodes = new Map();
let didInitialSnap = false;
let unknownBuildingHeightCount = 0;
let loadingCount = 0;

const root = document.getElementById('game');
const statusEl = document.getElementById('status');
const coordsEl = document.getElementById('coords');
const roadNameEl = document.getElementById('roadName');
const nearbyFeatureEl = document.getElementById('nearbyFeature');
const accuracyEl = document.getElementById('accuracy');
const sourceModeEl = document.getElementById('sourceMode');
const uiToggleBtn = document.getElementById('uiToggleBtn');
const qualityStatusEl = document.getElementById('qualityStatus');
const referenceCountEl = document.getElementById('referenceCount');
const dataStatusEl = document.getElementById('dataStatus');
const headingEl = document.getElementById('heading');
const walkedEl = document.getElementById('walked');
const poiCountEl = document.getElementById('poiCount');
const miniMap = document.getElementById('miniMap');
const miniCtx = miniMap?.getContext('2d');
const homeBtn = document.getElementById('homeBtn');
const refreshMapBtn = document.getElementById('refreshMapBtn');
const poiSearch = document.getElementById('poiSearch');
const poiOptions = document.getElementById('poiOptions');
const goPoiBtn = document.getElementById('goPoiBtn');
const clearRouteBtn = document.getElementById('clearRouteBtn');
const routeStatusEl = document.getElementById('routeStatus');
const inspectBtn = document.getElementById('inspectBtn');
const inspectPanel = document.getElementById('inspectPanel');
const inspectTitleEl = document.getElementById('inspectTitle');
const inspectBodyEl = document.getElementById('inspectBody');
const inspectCloseBtn = document.getElementById('inspectCloseBtn');
const inspectOsmLink = document.getElementById('inspectOsmLink');
const copyCoordsBtn = document.getElementById('copyCoordsBtn');
const copyReferenceBtn = document.getElementById('copyReferenceBtn');
let lastInspectedMeta = null;
const navGuideEl = document.getElementById('navGuide');
const navArrowEl = document.getElementById('navArrow');
const navInstructionEl = document.getElementById('navInstruction');
const start = document.getElementById('start');
const startBtn = document.getElementById('startBtn');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xaacbe5);
scene.fog = new THREE.FogExp2(0xcbbf9f, 0.00006);

const camera = new THREE.PerspectiveCamera(68, innerWidth / innerHeight, 0.08, 9000);
camera.position.set(0, EYE_HEIGHT, 0);

const isCoarse = matchMedia('(pointer:coarse)').matches;
const deviceMemoryGB = Number(navigator.deviceMemory || 4);
const maxDevicePixelRatio = isCoarse
  ? (deviceMemoryGB <= 4 ? 1.45 : 1.85)
  : (deviceMemoryGB <= 4 ? 1.65 : 2.0);
let adaptivePixelRatio = Math.min(devicePixelRatio || 1, maxDevicePixelRatio);
let fpsSampleTime = 0;
let fpsFrames = 0;
let lastFps = 60;
let qualityCooldown = 0;

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  powerPreference: 'high-performance'
});
renderer.setPixelRatio(adaptivePixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.98;
root.appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight(0xe6f1ff, 0x9e825e, 2.1));

const sun = new THREE.DirectionalLight(0xffefd2, 2.45);
sun.position.set(-900, 1200, -650);
sun.castShadow = true;
sun.shadow.mapSize.set(3072, 3072);
sun.shadow.camera.left = -320;
sun.shadow.camera.right = 320;
sun.shadow.camera.top = 320;
sun.shadow.camera.bottom = -320;
sun.shadow.camera.near = 20;
sun.shadow.camera.far = 1500;
scene.add(sun);
scene.add(sun.target);

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
let lastNearbyCheck = 0;
let lastMiniMapDraw = 0;
let lastPersist = 0;
let walkedMeters = 0;
let estimatedDimensionCount = 0;
const totalStats = { roads: 0, buildings: 0, details: 0 };
let currentDataSource = 'loading';
let activeRoute = [];
let activeRouteTarget = null;
let lastRerouteAt = 0;

const MAP_DB_NAME = 'hgame-map-cache-v1';
const MAP_DB_STORE = 'osm';
const MAP_CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

addEventListener('keydown', e => {
  keys.add(e.code);
  if (e.code === 'KeyE') inspectAhead();
});
addEventListener('keyup', e => keys.delete(e.code));

uiToggleBtn?.addEventListener('click', () => {
  const immersive = !document.body.classList.contains('immersive');
  document.body.classList.toggle('immersive', immersive);
  uiToggleBtn.setAttribute('aria-pressed', String(immersive));
  uiToggleBtn.textContent = immersive ? 'إظهار الواجهة' : 'إخفاء الواجهة';
});

startBtn.addEventListener('click', async () => {
  start.style.display = 'none';
  restorePlayerState();
  if (isCoarse && document.documentElement.requestFullscreen) {
    try { await document.documentElement.requestFullscreen(); } catch {}
  }
  if (!isCoarse) controls.lock();
});

homeBtn?.addEventListener('click', () => {
  camera.position.set(0, EYE_HEIGHT, 0);
  yaw = 0;
  pitch = 0;
  camera.rotation.set(0, 0, 0);
  localStorage.removeItem('hgame_player_state');
  walkedMeters = 0;
  if (walkedEl) walkedEl.textContent = 'المسافة التي مشيتها: 0 م';
  didInitialSnap = false;
  if (roadSegments.length) {
    snapStartToNearestRoad();
    didInitialSnap = true;
  }
});

refreshMapBtn?.addEventListener('click', async () => {
  refreshMapBtn.disabled = true;
  refreshMapBtn.textContent = 'جارٍ مسح النسخة المحلية...';
  try {
    await deleteMapCache();
  } catch {}
  location.reload();
});

function roadNodeKey(p) {
  return p[0].toFixed(3) + ',' + p[1].toFixed(3);
}

function addGraphEdge(graph, from, to, weight) {
  if (!graph.has(from)) graph.set(from, []);
  graph.get(from).push({ to, weight });
}

function buildWalkingGraph() {
  const graph = new Map();
  const coords = new Map();

  for (const s of roadSegments) {
    if (!s.walkable) continue;
    const ka = roadNodeKey(s.a);
    const kb = roadNodeKey(s.b);
    const len = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
    if (len < 0.2) continue;
    coords.set(ka, s.a);
    coords.set(kb, s.b);
    addGraphEdge(graph, ka, kb, len);
    addGraphEdge(graph, kb, ka, len);
  }

  return { graph, coords };
}

function nearestWalkableRoadPoint(x, z, maxDistance = Infinity) {
  let best = null;
  for (const s of roadSegments) {
    if (!s.walkable) continue;
    const p = closestPointOnSegment(x, z, s.a, s.b);
    if (!best || p.d2 < best.d2) best = { ...p, s };
  }
  if (!best || best.d2 > maxDistance * maxDistance) return null;
  return best;
}

function connectTemporaryNode(graph, coords, key, hit) {
  const aKey = roadNodeKey(hit.s.a);
  const bKey = roadNodeKey(hit.s.b);
  const len = Math.hypot(hit.s.b[0] - hit.s.a[0], hit.s.b[1] - hit.s.a[1]);
  const point = [hit.x, hit.z];
  coords.set(key, point);

  const dA = hit.t * len;
  const dB = (1 - hit.t) * len;
  addGraphEdge(graph, key, aKey, dA);
  addGraphEdge(graph, aKey, key, dA);
  addGraphEdge(graph, key, bKey, dB);
  addGraphEdge(graph, bKey, key, dB);
}

function shortestPath(graph, coords, startKey, targetKey) {
  const dist = new Map([[startKey, 0]]);
  const prev = new Map();
  const visited = new Set();
  const queue = [{ key: startKey, d: 0 }];

  while (queue.length) {
    queue.sort((a, b) => a.d - b.d);
    const current = queue.shift();
    if (!current || visited.has(current.key)) continue;
    visited.add(current.key);
    if (current.key === targetKey) break;

    for (const edge of graph.get(current.key) || []) {
      if (visited.has(edge.to)) continue;
      const nd = current.d + edge.weight;
      if (nd < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, nd);
        prev.set(edge.to, current.key);
        queue.push({ key: edge.to, d: nd });
      }
    }
  }

  if (!dist.has(targetKey)) return null;
  const keys = [];
  let cursor = targetKey;
  while (cursor) {
    keys.push(cursor);
    if (cursor === startKey) break;
    cursor = prev.get(cursor);
  }
  if (keys[keys.length - 1] !== startKey) return null;
  keys.reverse();

  return {
    points: keys.map(k => coords.get(k)).filter(Boolean),
    distance: dist.get(targetKey)
  };
}

function clearRoute() {
  activeRoute = [];
  activeRouteTarget = null;
  if (routeStatusEl) routeStatusEl.textContent = 'المسار: غير محدد';
  if (navGuideEl) navGuideEl.style.display = 'none';
  if (navInstructionEl) navInstructionEl.textContent = 'لا يوجد مسار نشط';
  if (navArrowEl) navArrowEl.style.transform = 'rotate(0deg)';
}

clearRouteBtn?.addEventListener('click', clearRoute);

async function planRouteToTarget(target, silent = false) {
  if (!target) return false;

  const startHit = nearestWalkableRoadPoint(camera.position.x, camera.position.z, 250);
  const targetHit = nearestWalkableRoadPoint(target.x, target.z, 700);

  if (!targetHit) {
    if (!silent && nearbyFeatureEl) nearbyFeatureEl.textContent = 'المعلم موثق لكن لا يوجد طريق مشي محمّل قريب منه';
    return false;
  }
  if (!startHit) {
    if (!silent && nearbyFeatureEl) nearbyFeatureEl.textContent = 'أنت بعيد عن شبكة الطرق المحمّلة؛ اقترب من طريق موثق أولاً';
    return false;
  }

  const { graph, coords } = buildWalkingGraph();
  connectTemporaryNode(graph, coords, '__route_start__', startHit);
  connectTemporaryNode(graph, coords, '__route_target__', targetHit);

  const result = shortestPath(graph, coords, '__route_start__', '__route_target__');
  if (!result || result.points.length < 2) {
    if (!silent && nearbyFeatureEl) nearbyFeatureEl.textContent = 'لم أجد مسار مشي متصل ضمن الطرق المحمّلة';
    return false;
  }

  activeRoute = result.points;
  activeRouteTarget = target;
  lastRerouteAt = performance.now();

  const label = result.distance < 1000
    ? Math.round(result.distance) + ' م'
    : (result.distance / 1000).toFixed(2) + ' كم';

  if (routeStatusEl) routeStatusEl.textContent = 'المسار: ' + label + ' إلى ' + target.label;
  if (!silent && nearbyFeatureEl) nearbyFeatureEl.textContent = 'تم تحديد مسار عبر الطرق الموثقة إلى: ' + target.label;
  if (navGuideEl) navGuideEl.style.display = 'flex';
  return true;
}

goPoiBtn?.addEventListener('click', async () => {
  const query = (poiSearch?.value || '').trim();
  if (!query) return;

  const exact = namedFeatures.find(f => f.label === query);
  const partial = namedFeatures.find(f => f.label.toLowerCase().includes(query.toLowerCase()));
  const target = exact || partial;
  if (!target) {
    if (nearbyFeatureEl) nearbyFeatureEl.textContent = 'لم يتم العثور على هذا المعلم ضمن البيانات المحمّلة';
    return;
  }

  await planRouteToTarget(target, false);
});


function formatKnownValue(value) {
  if (value === undefined || value === null || value === '') return '—';
  return String(value);
}

function inspectRows(meta) {
  const tags = meta?.tags || {};
  const rows = [];
  const push = (label, value) => {
    if (value !== undefined && value !== null && value !== '') rows.push([label, formatKnownValue(value)]);
  };

  push('OSM', meta?.osm);
  push('النوع', meta?.type);
  push('الاسم', tags['name:ar'] || tags.name);
  push('المرجع', tags.ref);
  push('آخر تحديث OSM', tags.__osm_timestamp ? new Date(tags.__osm_timestamp).toLocaleString('ar-SA') : '');
  push('العنوان', featureLabel({
    'addr:housenumber': tags['addr:housenumber'],
    'addr:street': tags['addr:street'],
    'addr:place': tags['addr:place']
  }));
  push('حالة المرجع الأرضي', meta?.groundVerified ? 'مطابق بمرجع أرضي' : 'بيانات خريطة فقط');
  push('رابط المرجع الأرضي', meta?.verifiedSource);

  if (meta?.type === 'road') {
    push('تصنيف الطريق', tags.highway);
    push('السطح', tags.surface);
    push('العرض الموثق', tags.width ? tags.width + ' م' : '');
    push('المسارات', tags.lanes);
    push('المشي', tags.foot);
    push('الوصول', tags.access);
  } else if (meta?.type === 'building') {
    push('استخدام المبنى', tags.building);
    push('الارتفاع', tags.height ? tags.height + ' م' : '');
    push('الأدوار', tags['building:levels']);
    push('لون المبنى', tags['building:colour']);
    push('شكل السقف', tags['roof:shape']);
    push('حالة الارتفاع', meta.heightKnown ? 'موثق في البيانات' : 'غير موثق — عرض حيادي');
  } else if (meta?.type === 'barrier') {
    push('نوع الحاجز', tags.barrier);
    push('الارتفاع', tags.height ? tags.height + ' م' : '');
  }

  return rows;
}

function showInspection(meta, distance) {
  if (!inspectPanel || !inspectBodyEl || !inspectTitleEl) return;
  lastInspectedMeta = meta;
  const rows = inspectRows(meta);
  inspectTitleEl.textContent =
    meta?.type === 'building' ? 'مبنى من بيانات الخريطة' :
    meta?.type === 'road' ? 'طريق من بيانات الخريطة' :
    meta?.type === 'barrier' ? 'حاجز من بيانات الخريطة' :
    'عنصر من بيانات الخريطة';

  if (Number.isFinite(distance)) rows.push(['المسافة عنك', Math.round(distance) + ' م']);
  rows.push(['المصدر', meta?.source || 'OpenStreetMap']);

  if (inspectOsmLink) {
    if (/^(node|way|relation)\/\d+$/.test(meta?.osm || '')) {
      inspectOsmLink.href = 'https://www.openstreetmap.org/' + meta.osm;
      inspectOsmLink.hidden = false;
    } else {
      inspectOsmLink.hidden = true;
    }
  }

  inspectBodyEl.innerHTML = rows.map(([k,v]) =>
    '<div class="row"><span class="key">' + escapeHtml(k) + '</span><span>' + escapeHtml(v) + '</span></div>'
  ).join('');
  inspectPanel.hidden = false;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function inspectAhead() {
  if (!inspectables.length) {
    if (nearbyFeatureEl) nearbyFeatureEl.textContent = 'لا توجد عناصر قابلة للفحص محمّلة بعد';
    return;
  }
  raycaster.setFromCamera({ x: 0, y: 0 }, camera);
  raycaster.far = 90;
  const hits = raycaster.intersectObjects(inspectables, false);
  const hit = hits.find(h => h.object?.userData?.inspect);
  if (!hit) {
    if (nearbyFeatureEl) nearbyFeatureEl.textContent = 'وجّه المؤشر إلى طريق أو مبنى موثق ثم افحصه';
    return;
  }
  showInspection(hit.object.userData.inspect, hit.distance);
}

inspectBtn?.addEventListener('click', inspectAhead);
inspectCloseBtn?.addEventListener('click', () => {
  if (inspectPanel) inspectPanel.hidden = true;
});

copyReferenceBtn?.addEventListener('click', async () => {
  if (!lastInspectedMeta?.osm) {
    copyReferenceBtn.textContent = 'افحص عنصرًا أولًا';
    setTimeout(() => { copyReferenceBtn.textContent = 'نسخ قالب مرجع أرضي لهذا العنصر'; }, 1500);
    return;
  }

  const p = toLatLon(camera.position.x, camera.position.z);
  const a = isCoarse ? yaw : camera.rotation.y;
  const headingDeg = ((-a * 180 / Math.PI) % 360 + 360) % 360;

  const template = {
    id: 'reference-' + Date.now(),
    osm: lastInspectedMeta.osm,
    source_url: '',
    captured_at: new Date().toISOString(),
    observer: '',
    position: {
      lat: Number(p.lat.toFixed(7)),
      lon: Number(p.lon.toFixed(7)),
      heading_deg: Math.round(headingDeg),
      accuracy_m: null
    },
    verification: 'exact-object',
    claims: {},
    notes: 'أضف رابط الصورة/الفيديو والحقائق المرئية فقط. لا تضف استنتاجات.'
  };

  const value = JSON.stringify(template, null, 2);
  try {
    await navigator.clipboard.writeText(value);
    copyReferenceBtn.textContent = 'تم نسخ قالب المرجع';
  } catch {
    copyReferenceBtn.textContent = 'تعذر النسخ';
  }
  setTimeout(() => { copyReferenceBtn.textContent = 'نسخ قالب مرجع أرضي لهذا العنصر'; }, 1800);
});

copyCoordsBtn?.addEventListener('click', async () => {
  const p = toLatLon(camera.position.x, camera.position.z);
  const textValue = p.lat.toFixed(6) + ', ' + p.lon.toFixed(6);
  try {
    await navigator.clipboard.writeText(textValue);
    copyCoordsBtn.textContent = 'تم نسخ الإحداثيات';
    setTimeout(() => { copyCoordsBtn.textContent = 'نسخ إحداثيات موقعي'; }, 1500);
  } catch {
    copyCoordsBtn.textContent = textValue;
  }
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

function verifiedRecord(type, id) {
  const item = verifiedOverrides.get(type + '/' + id);
  if (!item || item.verified !== true || !item.source_url || !item.attributes) return null;
  return item;
}

function verifiedAttributes(type, id) {
  return verifiedRecord(type, id)?.attributes || null;
}

async function loadVerifiedOverrides() {
  try {
    const response = await fetch('./data/verified-overrides.json', { cache: 'no-store' });
    if (!response.ok) return;
    const json = await response.json();
    for (const item of json.entries || []) {
      if (item?.osm && item.verified === true && item.source_url && item.attributes) {
        verifiedOverrides.set(item.osm, item);
      }
    }
  } catch {}
}

async function loadBundledSnapshot() {
  try {
    const response = await fetch('./data/osm-snapshot.json', { cache: 'no-store' });
    if (!response.ok) return;
    const json = await response.json();
    if (!Array.isArray(json.elements) || !json.center || !Number.isFinite(json.radius_m)) return;
    bundledSnapshot = json;
  } catch {}
}

async function loadReferenceCatalog() {
  try {
    const response = await fetch('./data/reference-sources.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('reference catalog unavailable');
    const json = await response.json();
    referenceCatalog = Array.isArray(json.sources) ? json.sources : [];
    const exact = referenceCatalog.filter(x => x.geolocation_status === 'exact').length;
    const area = referenceCatalog.filter(x => x.geolocation_status === 'area-level').length;
    if (referenceCountEl) {
      referenceCountEl.textContent =
        'المراجع المحفوظة: ' + referenceCatalog.length +
        ' • مطابق مكانيًا: ' + exact +
        ' • مرجع عام: ' + area;
    }
  } catch {
    if (referenceCountEl) referenceCountEl.textContent = 'المراجع المحفوظة: تعذر قراءة الفهرس';
  }
}

function roadWidth(type, tags) {
  const lanes = Math.max(0, parseFloat(tags.lanes) || 0);
  const taggedWidth = parseFloat(tags.width);
  if (Number.isFinite(taggedWidth) && taggedWidth > 1) return Math.min(taggedWidth, 20);
  if (lanes) {
    estimatedDimensionCount++;
    return Math.min(Math.max(lanes * 3.1, 3.5), 18);
  }
  estimatedDimensionCount++;
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
  if (['asphalt', 'paved', 'concrete'].includes(surface)) return 0x5c5d60;
  // Surface is unknown: use a neutral material, not an asphalt claim.
  return 0x77746e;
}

function attachInspectMeta(mesh, meta) {
  if (!mesh || !meta) return mesh;
  mesh.userData.inspect = meta;
  inspectables.push(mesh);
  return mesh;
}

function addSegmentBox(a, b, width, height, color, y = 0.02, cast = false, meta = null) {
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
  attachInspectMeta(mesh, meta);
  return mesh;
}

function addRoadRibbon(points, width, color, y = 0.008, meta = null) {
  if (points.length < 2 || isClosed(points)) return null;

  const half = width / 2;
  const left = [];
  const right = [];

  const segmentNormal = (a, b) => {
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz) || 1;
    return [-dz / len, dx / len];
  };

  for (let i = 0; i < points.length; i++) {
    const p = points[i];

    if (i === 0) {
      const n = segmentNormal(points[0], points[1]);
      left.push([p[0] + n[0] * half, p[1] + n[1] * half]);
      right.push([p[0] - n[0] * half, p[1] - n[1] * half]);
      continue;
    }

    if (i === points.length - 1) {
      const n = segmentNormal(points[i - 1], points[i]);
      left.push([p[0] + n[0] * half, p[1] + n[1] * half]);
      right.push([p[0] - n[0] * half, p[1] - n[1] * half]);
      continue;
    }

    const n1 = segmentNormal(points[i - 1], p);
    const n2 = segmentNormal(p, points[i + 1]);
    let mx = n1[0] + n2[0];
    let mz = n1[1] + n2[1];
    const ml = Math.hypot(mx, mz);

    if (ml < 1e-5) {
      mx = n2[0];
      mz = n2[1];
    } else {
      mx /= ml;
      mz /= ml;
    }

    const denom = Math.max(0.32, Math.abs(mx * n2[0] + mz * n2[1]));
    const miter = Math.min(half / denom, half * 2.8);

    left.push([p[0] + mx * miter, p[1] + mz * miter]);
    right.push([p[0] - mx * miter, p[1] - mz * miter]);
  }

  const polygon = [...left, ...right.reverse()];
  if (polygon.length < 4) return null;
  polygon.push(polygon[0]);

  const geo = new THREE.ShapeGeometry(makeShape(polygon));
  geo.rotateX(-Math.PI / 2);

  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({
      color,
      roughness: 0.94,
      metalness: 0
    })
  );
  mesh.position.y = y;
  mesh.receiveShadow = true;
  scene.add(mesh);
  attachInspectMeta(mesh, meta);
  return mesh;
}

function isWalkableRoad(tags) {
  const h = tags.highway || '';
  if (!h) return false;
  if (h === 'motorway' || h === 'motorway_link') return false;
  if (tags.foot === 'no') return false;
  if (tags.access === 'no' || tags.access === 'private') return false;
  return true;
}

function addRoad(points, tags, id) {
  if (points.length < 2) return;
  const overrideRecord = verifiedRecord('way', id);
  const override = overrideRecord?.attributes || null;
  const effectiveTags = override ? { ...tags, ...override } : tags;
  const width = roadWidth(effectiveTags.highway, effectiveTags);
  const color = roadColor(effectiveTags);
  const paved = !['dirt', 'earth', 'sand', 'ground', 'unpaved', 'gravel', 'fine_gravel'].includes(effectiveTags.surface || '');
  const inspectMeta = {
    osm: 'way/' + id,
    type: 'road',
    tags: effectiveTags,
    groundVerified: !!overrideRecord,
    verifiedSource: overrideRecord?.source_url || ''
  };

  const ribbon = addRoadRibbon(points, width, color, 0.008, inspectMeta);

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 0.5) continue;

    if (!ribbon) {
      addSegmentBox(a, b, width, 0.035, color, 0.005, false, inspectMeta);
    }
    roadSegments.push({
      a, b, width, highway: effectiveTags.highway,
      name: effectiveTags.name || effectiveTags['name:ar'] || '',
      ref: effectiveTags.ref || '',
      walkable: isWalkableRoad(effectiveTags)
    });

    // Do not invent painted lane markings. Render only when the map explicitly says they exist.
    const explicitMarkings =
      effectiveTags.lane_markings === 'yes' ||
      effectiveTags['centre_line'] === 'yes' ||
      effectiveTags['center_line'] === 'yes';
    if (paved && explicitMarkings) {
      const line = addSegmentBox(a, b, 0.11, 0.012, 0xe8dfbd, 0.038, false);
      if (line) line.material.roughness = 0.82;
    }

    // Sidewalks are drawn only when explicitly mapped, on the mapped side.
    const sidewalk = effectiveTags.sidewalk;
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

function collisionCellKey(cx, cz) {
  return cx + ',' + cz;
}

function getCollisionBucket(cx, cz, create = false) {
  const key = collisionCellKey(cx, cz);
  let bucket = collisionCells.get(key);
  if (!bucket && create) {
    bucket = { polys: [], segments: [] };
    collisionCells.set(key, bucket);
  }
  return bucket || null;
}

function indexPolygon(poly) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const p of poly) {
    minX = Math.min(minX, p[0]); minZ = Math.min(minZ, p[1]);
    maxX = Math.max(maxX, p[0]); maxZ = Math.max(maxZ, p[1]);
  }
  const x0 = Math.floor(minX / COLLISION_CELL_M), x1 = Math.floor(maxX / COLLISION_CELL_M);
  const z0 = Math.floor(minZ / COLLISION_CELL_M), z1 = Math.floor(maxZ / COLLISION_CELL_M);
  for (let cx = x0; cx <= x1; cx++) {
    for (let cz = z0; cz <= z1; cz++) getCollisionBucket(cx, cz, true).polys.push(poly);
  }
}

function indexSolidSegment(segment) {
  const minX = Math.min(segment.a[0], segment.b[0]) - segment.r;
  const maxX = Math.max(segment.a[0], segment.b[0]) + segment.r;
  const minZ = Math.min(segment.a[1], segment.b[1]) - segment.r;
  const maxZ = Math.max(segment.a[1], segment.b[1]) + segment.r;
  const x0 = Math.floor(minX / COLLISION_CELL_M), x1 = Math.floor(maxX / COLLISION_CELL_M);
  const z0 = Math.floor(minZ / COLLISION_CELL_M), z1 = Math.floor(maxZ / COLLISION_CELL_M);
  for (let cx = x0; cx <= x1; cx++) {
    for (let cz = z0; cz <= z1; cz++) getCollisionBucket(cx, cz, true).segments.push(segment);
  }
}

function registerSolidPolygon(points) {
  const poly = points.slice(0, isClosed(points) ? -1 : points.length);
  if (poly.length < 3) return;
  buildingPolys.push(poly);
  indexPolygon(poly);
  for (let i = 0; i < poly.length; i++) {
    const segment = { a: poly[i], b: poly[(i + 1) % poly.length], r: PLAYER_RADIUS };
    solidSegments.push(segment);
    indexSolidSegment(segment);
  }
}

function addBuilding(points, tags, id) {
  if (points.length < 4 || !isClosed(points)) return;
  const overrideRecord = verifiedRecord('way', id);
  const override = overrideRecord?.attributes || null;
  const effectiveTags = override ? { ...tags, ...override } : tags;
  const heightInfo = heightFromTags(effectiveTags);
  const height = heightInfo.value;
  const geo = new THREE.ExtrudeGeometry(makeShape(points), {
    depth: height,
    bevelEnabled: false,
    curveSegments: 1
  });
  geo.rotateX(-Math.PI / 2);

  const baseColor = parseColor(effectiveTags['building:colour'], 0xd8cbb2);
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color: baseColor, roughness: 0.91 })
  );
  mesh.position.y = 0.045;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  attachInspectMeta(mesh, {
    osm: 'way/' + id,
    type: 'building',
    tags: effectiveTags,
    heightKnown: heightInfo.exact,
    groundVerified: !!overrideRecord,
    verifiedSource: overrideRecord?.source_url || ''
  });
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

function gateGapWidth(node) {
  const explicit = parseFloat(node?.tags?.width);
  if (Number.isFinite(explicit) && explicit > 0) return Math.min(explicit, 8);
  estimatedDimensionCount++;
  return 1.2;
}

function trimSegmentForGate(a, b, startGate, endGate) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const len = Math.hypot(dx, dz);
  if (len < 0.5) return null;
  const ux = dx / len, uz = dz / len;
  let trimA = startGate ? gateGapWidth(startGate) / 2 : 0;
  let trimB = endGate ? gateGapWidth(endGate) / 2 : 0;
  if (trimA + trimB >= len - 0.2) return null;
  return {
    a: [a[0] + ux * trimA, a[1] + uz * trimA],
    b: [b[0] - ux * trimB, b[1] - uz * trimB]
  };
}

function addBarrier(points, tags, nodeIds, nodes) {
  if (points.length < 2) return;
  const h = barrierHeight(tags);
  const fence = tags.barrier === 'fence';
  const color = fence ? 0x77736a : 0xbca98a;
  const width = fence ? 0.055 : 0.18;

  for (let i = 0; i < points.length - 1; i++) {
    const startNode = nodes.get(nodeIds[i]);
    const endNode = nodes.get(nodeIds[i + 1]);
    const startGate = startNode && /gate/.test(startNode.tags?.barrier || '') ? startNode : null;
    const endGate = endNode && /gate/.test(endNode.tags?.barrier || '') ? endNode : null;
    const trimmed = trimSegmentForGate(points[i], points[i + 1], startGate, endGate);
    if (!trimmed) continue;

    addSegmentBox(trimmed.a, trimmed.b, width, h, color, 0, true, {
      osm: tags.__osm || '',
      type: 'barrier',
      tags
    });
    const segment = {
      a: trimmed.a,
      b: trimmed.b,
      r: PLAYER_RADIUS + width * 0.5
    };
    solidSegments.push(segment);
    indexSolidSegment(segment);
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

function addPowerLine(points, tags = {}) {
  if (points.length < 2) return;
  let h = parseFloat(tags.height);
  if (!Number.isFinite(h)) {
    h = 9.3;
    estimatedDimensionCount++;
  }
  const geom = new THREE.BufferGeometry().setFromPoints(
    points.map(p => new THREE.Vector3(p[0], h, p[1]))
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

function addTree(x, z, tags = {}) {
  let h = parseFloat(tags.height);
  if (!Number.isFinite(h)) {
    h = 4.2;
    estimatedDimensionCount++;
  }
  h = Math.min(Math.max(h, 2.2), 18);
  cylinder(0.11, Math.max(1.4, h * 0.52), 0x6f573c, x, 0, z);
  const crown = new THREE.Mesh(
    new THREE.IcosahedronGeometry(Math.max(0.8, h * 0.24), 1),
    new THREE.MeshStandardMaterial({ color: 0x68744b, roughness: 1 })
  );
  crown.position.set(x, h * 0.72, z);
  crown.castShadow = true;
  scene.add(crown);
}

function addPowerPole(x, z, tower = false, tags = {}) {
  let h = parseFloat(tags.height);
  if (!Number.isFinite(h)) {
    h = tower ? 14 : 8.5;
    estimatedDimensionCount++;
  }
  cylinder(tower ? 0.13 : 0.09, Math.min(Math.max(h, 4), 40), 0x777570, x, 0, z);
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

function featureLabel(tags) {
  if (!tags) return '';
  const named = tags['name:ar'] || tags.name || tags.operator || tags.brand;
  if (named) return named;

  const house = tags['addr:housenumber'] || '';
  const street = tags['addr:street'] || tags['addr:place'] || '';
  if (house || street) return [street, house].filter(Boolean).join(' ');

  return '';
}

function featureKind(tags) {
  if (!tags) return '';
  if (tags.entrance) return 'entrance:' + tags.entrance;
  if (tags['addr:housenumber']) return 'address';
  if (tags.amenity) return tags.amenity;
  if (tags.shop) return 'shop:' + tags.shop;
  if (tags.place) return 'place:' + tags.place;
  if (tags.tourism) return 'tourism:' + tags.tourism;
  if (tags.barrier) return 'barrier:' + tags.barrier;
  if (tags.power) return 'power:' + tags.power;
  if (tags.natural) return 'natural:' + tags.natural;
  return '';
}

function registerNamedNode(node) {
  const label = featureLabel(node.tags);
  const key = 'node/' + node.id;
  if (!label || namedFeatureIds.has(key)) return;
  namedFeatureIds.add(key);
  const [x, z] = toXY(node.lat, node.lon);
  namedFeatures.push({
    x, z, label,
    kind: featureKind(node.tags),
    osm: key
  });
}

function refreshPoiOptions() {
  if (!poiOptions) return;
  const current = poiSearch?.value || '';
  const unique = [...namedFeatures]
    .sort((a, b) => a.label.localeCompare(b.label, 'ar'))
    .slice(0, 500);

  poiOptions.innerHTML = '';
  for (const f of unique) {
    const opt = document.createElement('option');
    opt.value = f.label;
    opt.label = f.kind ? f.label + ' — ' + f.kind : f.label;
    poiOptions.appendChild(opt);
  }
  if (poiSearch) poiSearch.value = current;
}

function registerNamedWay(way, points) {
  const label = featureLabel(way.tags);
  const key = 'way/' + way.id;
  if (!label || namedFeatureIds.has(key) || !points.length) return;
  namedFeatureIds.add(key);
  let x = 0, z = 0;
  for (const p of points) { x += p[0]; z += p[1]; }
  x /= points.length; z /= points.length;
  namedFeatures.push({
    x, z, label,
    kind: featureKind(way.tags),
    osm: key
  });
}

function addNodeFeature(node) {
  if (!node.tags) return;
  registerNamedNode(node);

  const t = node.tags;
  if (/gate/.test(t.barrier || '')) barrierGateNodes.set(node.id, node);

  if (renderedNodes.has(node.id)) return;
  if (!(t.natural === 'tree' || t.power === 'pole' || t.power === 'tower' || t.highway === 'street_lamp')) return;

  renderedNodes.add(node.id);
  const [x, z] = toXY(node.lat, node.lon);
  if (t.natural === 'tree') addTree(x, z, t);
  else if (t.power === 'pole') addPowerPole(x, z, false, t);
  else if (t.power === 'tower') addPowerPole(x, z, true, t);
  else if (t.highway === 'street_lamp') addStreetLamp(x, z);
}

function openMapDB() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in self)) return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open(MAP_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(MAP_DB_STORE)) db.createObjectStore(MAP_DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function mapCacheGet(key) {
  const db = await openMapDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MAP_DB_STORE, 'readonly');
    const req = tx.objectStore(MAP_DB_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

async function mapCachePut(key, data) {
  const db = await openMapDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MAP_DB_STORE, 'readwrite');
    tx.objectStore(MAP_DB_STORE).put({ savedAt: Date.now(), data }, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function deleteMapCache() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in self)) return resolve();
    const req = indexedDB.deleteDatabase(MAP_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

function mapCacheKey(lat, lon) {
  return lat.toFixed(4) + ',' + lon.toFixed(4) + ',r' + LOAD_RADIUS_M;
}

function setDataSourceStatus(source) {
  currentDataSource = source;
  if (!dataStatusEl) return;
  if (source === 'live') dataStatusEl.textContent = 'بيانات الخريطة: مباشرة من OpenStreetMap';
  else if (source === 'cache') dataStatusEl.textContent = 'بيانات الخريطة: نسخة محلية موثقة (أقل من 7 أيام)';
  else if (source === 'stale-cache') dataStatusEl.textContent = 'بيانات الخريطة: نسخة محلية أقدم بسبب تعذر الاتصال';
  else if (source === 'bundled') {
    const stamp = bundledSnapshot?.fetched_at ? ' • ' + new Date(bundledSnapshot.fetched_at).toLocaleDateString('ar-SA') : '';
    dataStatusEl.textContent = 'بيانات الخريطة: لقطة OSM مرفقة مع النسخة' + stamp;
  } else dataStatusEl.textContent = 'بيانات الخريطة: جارٍ التحميل...';
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
  const dP = (lat2 - lat1) * Math.PI / 180;
  const dL = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dP/2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dL/2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function snapshotCovers(lat, lon) {
  if (!bundledSnapshot?.center || !Number.isFinite(bundledSnapshot.radius_m)) return false;
  const d = haversineMeters(
    lat, lon,
    Number(bundledSnapshot.center.lat),
    Number(bundledSnapshot.center.lon)
  );
  return d + LOAD_RADIUS_M <= bundledSnapshot.radius_m;
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
    'node["barrier"](around:' + LOAD_RADIUS_M + ',' + lat + ',' + lon + ');' +
    'node["name"](around:' + LOAD_RADIUS_M + ',' + lat + ',' + lon + ');' +
    'node["addr:housenumber"](around:' + LOAD_RADIUS_M + ',' + lat + ',' + lon + ');' +
    'node["entrance"](around:' + LOAD_RADIUS_M + ',' + lat + ',' + lon + ');' +
    'node["amenity"](around:' + LOAD_RADIUS_M + ',' + lat + ',' + lon + ');' +
    'node["shop"](around:' + LOAD_RADIUS_M + ',' + lat + ',' + lon + ');' +
    'node["tourism"](around:' + LOAD_RADIUS_M + ',' + lat + ',' + lon + ');' +
    'node["place"](around:' + LOAD_RADIUS_M + ',' + lat + ',' + lon + ');' +
    'way["amenity"](around:' + LOAD_RADIUS_M + ',' + lat + ',' + lon + ');' +
    'way["shop"](around:' + LOAD_RADIUS_M + ',' + lat + ',' + lon + ');' +
    'way["tourism"](around:' + LOAD_RADIUS_M + ',' + lat + ',' + lon + ');' +
    'way["place"](around:' + LOAD_RADIUS_M + ',' + lat + ',' + lon + ');' +
    ');(._;>;);out meta;';

  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.nchc.org.tw/api/interpreter'
  ];

  let lastErr;
  const cacheKey = mapCacheKey(lat, lon);
  let cached = null;

  try {
    cached = await mapCacheGet(cacheKey);
    if (cached && Date.now() - cached.savedAt <= MAP_CACHE_MAX_AGE) {
      setDataSourceStatus('cache');
      return cached.data;
    }
  } catch {}

  loadingCount++;
  setDataSourceStatus('loading');
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
      setDataSourceStatus('live');
      mapCachePut(cacheKey, json).catch(() => {});
      return json;
    } catch (err) {
      lastErr = err;
    }
  }

  loadingCount--;
  if (cached?.data) {
    setDataSourceStatus('stale-cache');
    return cached.data;
  }

  if (snapshotCovers(lat, lon) && Array.isArray(bundledSnapshot?.elements)) {
    setDataSourceStatus('bundled');
    return { elements: bundledSnapshot.elements };
  }

  throw lastErr || new Error('تعذر جلب الخريطة');
}


function polygonCentroid(points) {
  if (!points.length) return [0, 0];
  let x = 0, z = 0;
  for (const p of points) { x += p[0]; z += p[1]; }
  return [x / points.length, z / points.length];
}

function addExternalBuildingPolygon(ring, properties = {}) {
  if (!Array.isArray(ring) || ring.length < 4) return false;
  const points = ring
    .filter(p => Array.isArray(p) && p.length >= 2)
    .map(([lon, lat]) => toXY(Number(lat), Number(lon)))
    .filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (points.length < 4) return false;

  const centroid = polygonCentroid(points);
  for (const poly of buildingPolys) {
    if (pointInPoly(centroid[0], centroid[1], poly)) return false;
  }

  let height = Number(properties.height);
  let exactHeight = Number.isFinite(height) && height > 1;
  if (!exactHeight) {
    const floors = Number(properties.num_floors ?? properties.level);
    if (Number.isFinite(floors) && floors > 0) {
      height = Math.min(floors * 3.05, 36);
      exactHeight = true;
    } else {
      height = 3.2;
      estimatedDimensionCount++;
    }
  }

  const geo = new THREE.ExtrudeGeometry(makeShape(points), {
    depth: Math.min(Math.max(height, 2.6), 40),
    bevelEnabled: false,
    curveSegments: 1
  });
  geo.rotateX(-Math.PI / 2);

  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color: 0xd6c9b1, roughness: 0.92 })
  );
  mesh.position.y = 0.045;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);

  attachInspectMeta(mesh, {
    osm: '',
    externalId: properties.id || '',
    type: 'building',
    source: properties.__source || 'Microsoft Global ML Building Footprints',
    tags: {
      building: properties.class || properties.subtype || 'yes',
      height: Number.isFinite(Number(properties.height)) ? properties.height : '',
      'building:levels': Number.isFinite(Number(properties.num_floors)) ? properties.num_floors : ''
    },
    heightKnown: exactHeight,
    groundVerified: false,
    verifiedSource: ''
  });

  registerSolidPolygon(points);
  externalBuildingCount++;
  return true;
}

function addExternalBuildingFeature(feature) {
  const g = feature?.geometry;
  if (!g || !g.coordinates) return 0;
  const props = { ...(feature.properties || {}), id: feature.id || feature.properties?.id || '' };
  let count = 0;

  if (g.type === 'Polygon') {
    if (addExternalBuildingPolygon(g.coordinates[0], props)) count++;
  } else if (g.type === 'MultiPolygon') {
    for (const polygon of g.coordinates) {
      if (addExternalBuildingPolygon(polygon?.[0], props)) count++;
    }
  }
  return count;
}

async function loadExternalBuildings() {
  if (externalBuildingsLoaded) return;
  externalBuildingsLoaded = true;

  try {
    const response = await fetch('./data/ms-buildings.geojson', { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const geojson = await response.json();
    const features = Array.isArray(geojson.features) ? geojson.features : [];

    let added = 0;
    for (const feature of features) {
      feature.properties = { ...(feature.properties || {}), __source: 'Microsoft Global ML Building Footprints' };
      added += addExternalBuildingFeature(feature);
    }

    if (added > 0) {
      statusEl.textContent += ' • مباني Microsoft: ' + added;
      if (sourceModeEl) sourceModeEl.textContent =
        'مرجع المشهد: OpenStreetMap + Microsoft Building Footprints • لا واجهات غير موثقة';
    }
  } catch (err) {
    console.warn('Microsoft building footprints unavailable:', err);
  }
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
    registerNamedWay(e, pts);

    if (e.tags.highway) {
      addRoad(pts, { ...e.tags, __osm_timestamp: e.timestamp || '' }, e.id);
      roads++;
    } else if (e.tags.building) {
      addBuilding(pts, { ...e.tags, __osm_timestamp: e.timestamp || '' }, e.id);
      buildings++;
    } else if (e.tags.barrier) {
      addBarrier(pts, { ...e.tags, __osm: 'way/' + e.id }, e.nodes, nodes);
      details++;
    } else if (e.tags.waterway) {
      addWaterway(pts, e.tags);
      details++;
    } else if (e.tags.power === 'line') {
      addPowerLine(pts, e.tags);
      details++;
    } else if (e.tags.landuse || e.tags.leisure || e.tags.natural) {
      addArea(pts, e.tags);
      details++;
    }
  }

  totalStats.roads += roads;
  totalStats.buildings += buildings;
  totalStats.details += details;

  statusEl.textContent =
    'الإجمالي المحمّل: ' + totalStats.roads + ' طريق، ' + totalStats.buildings + ' مبنى، ' +
    totalStats.details + ' عنصر موثق' +
    (unknownBuildingHeightCount ? ' • ارتفاع غير موثق: ' + unknownBuildingHeightCount : '');

  if (accuracyEl) {
    accuracyEl.textContent =
      'وضع الدقة: لا عناصر عشوائية' +
      (estimatedDimensionCount ? ' • أبعاد محايدة تقديرية: ' + estimatedDimensionCount : '');
  }
  if (sourceModeEl) {
    sourceModeEl.textContent = 'مرجع المشهد: OpenStreetMap • لا تفاصيل أرضية غير موثقة';
  }
  if (poiCountEl) {
    poiCountEl.textContent = 'المعالم المسماة المحمّلة: ' + namedFeatures.length;
  }
  refreshPoiOptions();

  if (!didInitialSnap && roadSegments.length) {
    snapStartToNearestRoad();
    didInitialSnap = true;
  }

  if (!externalBuildingsLoaded) {
    loadExternalBuildings();
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

function nearestRoadPoint(x, z, maxDistance = Infinity) {
  let best = null;
  for (const s of roadSegments) {
    const p = closestPointOnSegment(x, z, s.a, s.b);
    if (!best || p.d2 < best.d2) best = { ...p, s };
  }
  if (!best || best.d2 > maxDistance * maxDistance) return null;
  return best;
}

function faceAlongRoad(hit) {
  if (!hit?.s) return;
  const dx = hit.s.b[0] - hit.s.a[0];
  const dz = hit.s.b[1] - hit.s.a[1];
  yaw = Math.atan2(-dx, -dz);
  pitch = 0;
  if (isCoarse) {
    camera.rotation.order = 'YXZ';
    camera.rotation.y = yaw;
    camera.rotation.x = 0;
  } else {
    camera.rotation.set(0, yaw, 0);
  }
}

function snapStartToNearestRoad() {
  const best = nearestRoadPoint(0, 0, 250);
  if (!best) return;
  camera.position.x = best.x;
  camera.position.z = best.z;
  faceAlongRoad(best);
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
    setDataSourceStatus('loading');
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
  const cx = Math.floor(x / COLLISION_CELL_M);
  const cz = Math.floor(z / COLLISION_CELL_M);
  const seenPolys = new Set();
  const seenSegments = new Set();

  for (let ox = -1; ox <= 1; ox++) {
    for (let oz = -1; oz <= 1; oz++) {
      const bucket = getCollisionBucket(cx + ox, cz + oz, false);
      if (!bucket) continue;

      for (const poly of bucket.polys) {
        if (seenPolys.has(poly)) continue;
        seenPolys.add(poly);
        if (pointInPoly(x, z, poly)) return true;
      }

      for (const s of bucket.segments) {
        if (seenSegments.has(s)) continue;
        seenSegments.add(s);
        if (distanceToSegment(x, z, s.a, s.b) < s.r) return true;
      }
    }
  }
  return false;
}

function setAdaptivePixelRatio(next) {
  const clamped = Math.max(0.8, Math.min(maxDevicePixelRatio, next));
  if (Math.abs(clamped - adaptivePixelRatio) < 0.04) return;
  adaptivePixelRatio = clamped;
  renderer.setPixelRatio(adaptivePixelRatio);
  renderer.setSize(innerWidth, innerHeight, false);
}

function updateAdaptiveQuality(dt) {
  fpsSampleTime += dt;
  fpsFrames++;
  qualityCooldown = Math.max(0, qualityCooldown - dt);

  if (fpsSampleTime < 2.0) return;
  lastFps = fpsFrames / fpsSampleTime;
  fpsSampleTime = 0;
  fpsFrames = 0;

  if (qualityCooldown <= 0) {
    if (lastFps < 42 && adaptivePixelRatio > 0.85) {
      setAdaptivePixelRatio(adaptivePixelRatio - 0.12);
      qualityCooldown = 5;
    } else if (lastFps > 56 && adaptivePixelRatio < maxDevicePixelRatio) {
      setAdaptivePixelRatio(adaptivePixelRatio + 0.08);
      qualityCooldown = 7;
    }
  }

  if (qualityStatusEl) {
    qualityStatusEl.textContent =
      'الجودة: تكيف تلقائي • ' + Math.round(lastFps) + ' FPS • DPR ' + adaptivePixelRatio.toFixed(2);
  }
}

function updateSunAroundPlayer() {
  const x = camera.position.x;
  const z = camera.position.z;
  sun.position.set(x - 520, 760, z - 390);
  sun.target.position.set(x, 0, z);
  sun.target.updateMatrixWorld();
}

function updateCoords() {
  const p = toLatLon(camera.position.x, camera.position.z);
  coordsEl.textContent = p.lat.toFixed(6) + ', ' + p.lon.toFixed(6);

  if (headingEl) {
    const a = isCoarse ? yaw : camera.rotation.y;
    const deg = ((-a * 180 / Math.PI) % 360 + 360) % 360;
    const dirs = ['شمال','شمال شرق','شرق','جنوب شرق','جنوب','جنوب غرب','غرب','شمال غرب'];
    const dir = dirs[Math.round(deg / 45) % 8];
    headingEl.textContent = 'الاتجاه: ' + dir + ' • ' + Math.round(deg) + '°';
  }

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

function routePosition() {
  if (activeRoute.length < 2) return null;

  let best = null;
  let prefix = 0;

  for (let i = 0; i < activeRoute.length - 1; i++) {
    const a = activeRoute[i], b = activeRoute[i + 1];
    const cp = closestPointOnSegment(camera.position.x, camera.position.z, a, b);
    const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!best || cp.d2 < best.d2) {
      best = { ...cp, index: i, prefix, segLen };
    }
    prefix += segLen;
  }

  if (!best) return null;

  const total = prefix;
  const traveledOnRoute = best.prefix + best.t * best.segLen;
  const remaining = Math.max(0, total - traveledOnRoute);
  const nextPoint = activeRoute[Math.min(best.index + 1, activeRoute.length - 1)];
  return {
    deviation: Math.sqrt(best.d2),
    remaining,
    nextPoint,
    segmentIndex: best.index
  };
}

function updateNavigationGuide(pos) {
  if (!pos || !activeRouteTarget || !navGuideEl || !navArrowEl || !navInstructionEl) return;

  navGuideEl.style.display = 'flex';
  const dx = pos.nextPoint[0] - camera.position.x;
  const dz = pos.nextPoint[1] - camera.position.z;
  const targetAngle = Math.atan2(-dx, -dz);
  const viewYaw = isCoarse ? yaw : camera.rotation.y;
  let delta = targetAngle - viewYaw;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;

  navArrowEl.style.transform = 'rotate(' + (delta * 180 / Math.PI) + 'deg)';

  const absDeg = Math.abs(delta * 180 / Math.PI);
  let instruction = 'استمر للأمام';
  if (absDeg > 135) instruction = 'استدر للخلف';
  else if (absDeg > 45) instruction = delta > 0 ? 'اتجه يسارًا' : 'اتجه يمينًا';
  else if (absDeg > 18) instruction = delta > 0 ? 'ميل يسارًا' : 'ميل يمينًا';

  navInstructionEl.textContent = instruction + ' • ' + Math.max(1, Math.round(pos.remaining)) + ' م';
}

async function updateRouteProgress() {
  if (!activeRouteTarget || activeRoute.length < 2 || !routeStatusEl) return;

  const pos = routePosition();
  if (!pos) return;

  if (pos.remaining < 15) {
    routeStatusEl.textContent = 'وصلت قرب: ' + activeRouteTarget.label;
    if (navInstructionEl) navInstructionEl.textContent = 'وصلت قرب الوجهة';
    activeRoute = [];
    activeRouteTarget = null;
    setTimeout(() => {
      if (navGuideEl && !activeRouteTarget) navGuideEl.style.display = 'none';
    }, 2500);
    return;
  }

  const label = pos.remaining < 1000
    ? Math.round(pos.remaining) + ' م'
    : (pos.remaining / 1000).toFixed(2) + ' كم';

  routeStatusEl.textContent = 'متبقي: ' + label + ' إلى ' + activeRouteTarget.label;
  updateNavigationGuide(pos);

  const now = performance.now();
  if (pos.deviation > 35 && now - lastRerouteAt > 8000) {
    const target = activeRouteTarget;
    lastRerouteAt = now;
    const rerouted = await planRouteToTarget(target, true);
    if (rerouted && routeStatusEl) routeStatusEl.textContent += ' • أُعيد حساب المسار';
  }
}

function updateNearbyFeature() {
  if (!nearbyFeatureEl || !namedFeatures.length) {
    if (nearbyFeatureEl) nearbyFeatureEl.textContent = 'أقرب معلم موثق: لا يوجد اسم قريب في البيانات';
    return;
  }

  let best = null;
  for (const f of namedFeatures) {
    const d2 = (camera.position.x - f.x) ** 2 + (camera.position.z - f.z) ** 2;
    if (!best || d2 < best.d2) best = { d2, f };
  }

  if (!best || best.d2 > 220 * 220) {
    nearbyFeatureEl.textContent = 'أقرب معلم موثق: لا يوجد اسم ضمن 220م';
    return;
  }

  const d = Math.round(Math.sqrt(best.d2));
  const kind = best.f.kind ? ' • ' + best.f.kind : '';
  nearbyFeatureEl.textContent = 'أقرب معلم موثق: ' + best.f.label + ' • ' + d + 'م' + kind;
}

function persistPlayerState() {
  const ll = toLatLon(camera.position.x, camera.position.z);
  const state = {
    lat: ll.lat,
    lon: ll.lon,
    x: camera.position.x,
    z: camera.position.z,
    yaw: isCoarse ? yaw : camera.rotation.y,
    pitch: isCoarse ? pitch : camera.rotation.x,
    walkedMeters,
    savedAt: Date.now()
  };
  try { localStorage.setItem('hgame_player_state', JSON.stringify(state)); } catch {}
}

function restorePlayerState() {
  try {
    const raw = localStorage.getItem('hgame_player_state');
    if (!raw) return;
    const s = JSON.parse(raw);
    if (!Number.isFinite(s.x) || !Number.isFinite(s.z)) return;
    if (Math.hypot(s.x, s.z) > 15000) return;
    camera.position.set(s.x, EYE_HEIGHT, s.z);
    yaw = Number.isFinite(s.yaw) ? s.yaw : 0;
    pitch = Number.isFinite(s.pitch) ? s.pitch : 0;
    walkedMeters = Number.isFinite(s.walkedMeters) ? Math.max(0, s.walkedMeters) : 0;
    if (walkedEl) {
      walkedEl.textContent = walkedMeters < 1000
        ? 'المسافة التي مشيتها: ' + Math.round(walkedMeters) + ' م'
        : 'المسافة التي مشيتها: ' + (walkedMeters / 1000).toFixed(2) + ' كم';
    }
    if (isCoarse) {
      camera.rotation.order = 'YXZ';
      camera.rotation.y = yaw;
      camera.rotation.x = pitch;
    }
  } catch {}
}

function drawMiniMap() {
  if (!miniCtx || !miniMap) return;
  const cssSize = Math.max(150, Math.min(220, miniMap.clientWidth || 220));
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const px = Math.round(cssSize * dpr);
  if (miniMap.width !== px || miniMap.height !== px) {
    miniMap.width = px;
    miniMap.height = px;
  }
  const ctx = miniCtx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssSize, cssSize);
  ctx.fillStyle = 'rgba(24,24,22,.82)';
  ctx.fillRect(0, 0, cssSize, cssSize);

  const radius = 260;
  const scale = cssSize / (radius * 2);
  const cx = cssSize / 2, cy = cssSize / 2;
  const tx = x => cx + (x - camera.position.x) * scale;
  const tz = z => cy + (z - camera.position.z) * scale;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, cssSize, cssSize);
  ctx.clip();

  ctx.strokeStyle = 'rgba(215,205,183,.40)';
  ctx.lineWidth = 1;
  for (const poly of buildingPolys) {
    if (!poly.length) continue;
    const near = poly.some(p => Math.abs(p[0] - camera.position.x) < radius && Math.abs(p[1] - camera.position.z) < radius);
    if (!near) continue;
    ctx.beginPath();
    ctx.moveTo(tx(poly[0][0]), tz(poly[0][1]));
    for (let i = 1; i < poly.length; i++) ctx.lineTo(tx(poly[i][0]), tz(poly[i][1]));
    ctx.closePath();
    ctx.stroke();
  }

  for (const r of roadSegments) {
    const mx = (r.a[0] + r.b[0]) / 2, mz = (r.a[1] + r.b[1]) / 2;
    if (Math.abs(mx - camera.position.x) > radius || Math.abs(mz - camera.position.z) > radius) continue;
    ctx.strokeStyle = 'rgba(242,237,224,.78)';
    ctx.lineWidth = Math.max(1, Math.min(5, r.width * scale));
    ctx.beginPath();
    ctx.moveTo(tx(r.a[0]), tz(r.a[1]));
    ctx.lineTo(tx(r.b[0]), tz(r.b[1]));
    ctx.stroke();
  }

  if (activeRoute.length > 1) {
    ctx.strokeStyle = 'rgba(255,255,255,.95)';
    ctx.lineWidth = 3;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(tx(activeRoute[0][0]), tz(activeRoute[0][1]));
    for (let i = 1; i < activeRoute.length; i++) {
      ctx.lineTo(tx(activeRoute[i][0]), tz(activeRoute[i][1]));
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.restore();

  const a = isCoarse ? yaw : camera.rotation.y;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-a);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(0, -10);
  ctx.lineTo(7, 8);
  ctx.lineTo(0, 5);
  ctx.lineTo(-7, 8);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  for (const f of namedFeatures) {
    if (Math.abs(f.x - camera.position.x) > radius || Math.abs(f.z - camera.position.z) > radius) continue;
    ctx.fillStyle = 'rgba(255,255,255,.86)';
    ctx.beginPath();
    ctx.arc(tx(f.x), tz(f.z), 2.4, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = 'rgba(255,255,255,.72)';
  ctx.font = '11px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText('N', cx, 13);
  ctx.fillText('≈ 520م', cx, cssSize - 9);
}

function attemptMove(dx, dz) {
  const oldX = camera.position.x, oldZ = camera.position.z;
  const nx = oldX + dx, nz = oldZ + dz;

  if (!collides(nx, oldZ)) camera.position.x = nx;
  if (!collides(camera.position.x, nz)) camera.position.z = nz;

  const moved = Math.hypot(camera.position.x - oldX, camera.position.z - oldZ);
  if (moved > 0 && moved < 3) {
    walkedMeters += moved;
    if (walkedEl) {
      walkedEl.textContent = walkedMeters < 1000
        ? 'المسافة التي مشيتها: ' + Math.round(walkedMeters) + ' م'
        : 'المسافة التي مشيتها: ' + (walkedMeters / 1000).toFixed(2) + ' كم';
    }
  }
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

Promise.all([loadVerifiedOverrides(), loadReferenceCatalog(), loadBundledSnapshot()]).finally(() => streamAroundPlayer(true));

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.04);
  move(dt);
  updateCoords();
  updateAdaptiveQuality(dt);

  lastStreamCheck += dt;
  if (lastStreamCheck > 2.25) {
    lastStreamCheck = 0;
    streamAroundPlayer(false);
  }

  lastNearbyCheck += dt;
  if (lastNearbyCheck > 0.5) {
    lastNearbyCheck = 0;
    updateNearbyFeature();
    updateRouteProgress();
    updateSunAroundPlayer();
  }

  lastMiniMapDraw += dt;
  if (lastMiniMapDraw > 0.2) {
    lastMiniMapDraw = 0;
    drawMiniMap();
  }

  lastPersist += dt;
  if (lastPersist > 2.0) {
    lastPersist = 0;
    persistPlayerState();
  }

  renderer.render(scene, camera);
}
animate();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
