import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.module.js';
import { PointerLockControls } from 'https://cdn.jsdelivr.net/npm/three@0.160.1/examples/jsm/controls/PointerLockControls.js';

const CENTER = { lat: 18.58979, lon: 41.4123419 };
const LOAD_RADIUS_M = 3000;
const EYE_HEIGHT = 1.72;

const root = document.getElementById('game');
const statusEl = document.getElementById('status');
const coordsEl = document.getElementById('coords');
const start = document.getElementById('start');
const startBtn = document.getElementById('startBtn');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fc7e8);
scene.fog = new THREE.FogExp2(0xc8c0a8, 0.00016);

const camera = new THREE.PerspectiveCamera(68, innerWidth/innerHeight, 0.08, 7000);
camera.position.set(0,EYE_HEIGHT,0);

const renderer = new THREE.WebGLRenderer({antialias:true,powerPreference:'high-performance'});
renderer.setPixelRatio(Math.min(devicePixelRatio,1.8));
renderer.setSize(innerWidth,innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
root.appendChild(renderer.domElement);

const hemi = new THREE.HemisphereLight(0xddeeff,0xa98b63,2.25);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff1d2,2.6);
sun.position.set(-800,1000,-500);
sun.castShadow = true;
sun.shadow.mapSize.set(2048,2048);
sun.shadow.camera.left = -1800; sun.shadow.camera.right = 1800;
sun.shadow.camera.top = 1800; sun.shadow.camera.bottom = -1800;
scene.add(sun);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(8000,8000),
  new THREE.MeshStandardMaterial({color:0xc8b384,roughness:1})
);
ground.rotation.x = -Math.PI/2;
ground.receiveShadow = true;
scene.add(ground);

const controls = new PointerLockControls(camera,renderer.domElement);
scene.add(controls.getObject());

const clock = new THREE.Clock();
const keys = new Set();
let mobileMove = {x:0,y:0};
let yaw = 0, pitch = 0;
const isCoarse = matchMedia('(pointer:coarse)').matches;

addEventListener('keydown',e=>keys.add(e.code));
addEventListener('keyup',e=>keys.delete(e.code));

startBtn.addEventListener('click',()=>{
  start.style.display='none';
  if(!isCoarse) controls.lock();
});
renderer.domElement.addEventListener('click',()=>{
  if(!isCoarse && start.style.display==='none' && !controls.isLocked) controls.lock();
});

function metersPerDegree(){
  const latRad = CENTER.lat*Math.PI/180;
  return {lat:111320, lon:111320*Math.cos(latRad)};
}
const MPD = metersPerDegree();
function toXY(lat,lon){
  const x=(lon-CENTER.lon)*MPD.lon;
  const z=-(lat-CENTER.lat)*MPD.lat;
  return [x,z];
}
function toLatLon(x,z){
  return {lat:CENTER.lat+(-z)/MPD.lat, lon:CENTER.lon+x/MPD.lon};
}

function roadWidth(t){
  return ({motorway:11,trunk:10,primary:9,secondary:8,tertiary:7,residential:5.5,unclassified:5,service:4,track:3.2,path:2,footway:1.7})[t]||4.8;
}
function roadColor(t){
  if(['motorway','trunk','primary'].includes(t)) return 0x55565a;
  if(['secondary','tertiary'].includes(t)) return 0x626267;
  return 0x77736d;
}
function addRoad(points,tags){
  if(points.length<2)return;
  const w=roadWidth(tags.highway);
  const mat=new THREE.MeshStandardMaterial({color:roadColor(tags.highway),roughness:.94});
  for(let i=0;i<points.length-1;i++){
    const a=points[i], b=points[i+1];
    const dx=b[0]-a[0], dz=b[1]-a[1];
    const len=Math.hypot(dx,dz); if(len<.5) continue;
    const g=new THREE.BoxGeometry(w,.035,len);
    const m=new THREE.Mesh(g,mat);
    m.position.set((a[0]+b[0])/2,.025,(a[1]+b[1])/2);
    m.rotation.y=Math.atan2(dx,dz);
    m.receiveShadow=true;
    scene.add(m);
  }
}
function seededColor(id){
  const palette=[0xd7c39f,0xe3d3b7,0xcab38f,0xeadcc4,0xbfa987,0xf0e5cf,0xd0bd9e];
  return palette[Math.abs(Number(id)||0)%palette.length];
}
function heightFromTags(tags,id){
  const h=parseFloat(tags.height);
  if(Number.isFinite(h)) return Math.min(Math.max(h,2.7),24);
  const lv=parseFloat(tags['building:levels']);
  if(Number.isFinite(lv)) return Math.min(Math.max(lv*3.1,3),22);
  return 3.2 + (Math.abs(Number(id)||0)%3)*0.65;
}
function addBuilding(points,tags,id){
  if(points.length<4)return;
  const shape=new THREE.Shape();
  shape.moveTo(points[0][0],-points[0][1]);
  for(let i=1;i<points.length;i++) shape.lineTo(points[i][0],-points[i][1]);
  const h=heightFromTags(tags,id);
  const geo=new THREE.ExtrudeGeometry(shape,{depth:h,bevelEnabled:false,curveSegments:1});
  geo.rotateX(Math.PI/2);
  const mat=new THREE.MeshStandardMaterial({color:seededColor(id),roughness:.92});
  const mesh=new THREE.Mesh(geo,mat);
  mesh.position.y=.02;
  mesh.castShadow=true; mesh.receiveShadow=true;
  scene.add(mesh);
}

async function fetchOSM(){
  const q='[out:json][timeout:35];(way["highway"](around:'+LOAD_RADIUS_M+','+CENTER.lat+','+CENTER.lon+');way["building"](around:'+LOAD_RADIUS_M+','+CENTER.lat+','+CENTER.lon+'););(._;>;);out body;';
  const endpoints=[
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.nchc.org.tw/api/interpreter'
  ];
  let lastErr;
  for(const ep of endpoints){
    try{
      statusEl.textContent='جاري جلب طرق ومباني سعيدة الصوالحة...';
      const r=await fetch(ep,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded;charset=UTF-8'},body:'data='+encodeURIComponent(q)});
      if(!r.ok) throw new Error('HTTP '+r.status);
      return await r.json();
    }catch(e){lastErr=e;}
  }
  throw lastErr||new Error('تعذر جلب الخريطة');
}
function buildFromOSM(data){
  const nodes=new Map();
  for(const e of data.elements) if(e.type==='node') nodes.set(e.id,e);
  let roads=0, buildings=0;
  for(const e of data.elements){
    if(e.type!=='way'||!e.nodes||!e.tags) continue;
    const pts=e.nodes.map(id=>nodes.get(id)).filter(Boolean).map(n=>toXY(n.lat,n.lon));
    if(e.tags.highway){addRoad(pts,e.tags);roads++;}
    else if(e.tags.building){addBuilding(pts,e.tags,e.id);buildings++;}
  }
  statusEl.textContent='تم تحميل '+roads+' طريق و '+buildings+' مبنى من بيانات الخريطة الحقيقية';
}
fetchOSM().then(buildFromOSM).catch(err=>{
  console.error(err);
  statusEl.textContent='تعذر تحميل بيانات OSM الآن — لم تتم إضافة تضاريس أو مبانٍ وهمية.';
});

function updateCoords(){
  const p=toLatLon(camera.position.x,camera.position.z);
  coordsEl.textContent=p.lat.toFixed(6)+', '+p.lon.toFixed(6);
}

function move(dt){
  const speed=(keys.has('ShiftLeft')||keys.has('ShiftRight'))?7.2:3.3;
  let f=0,s=0;
  if(keys.has('KeyW')||keys.has('ArrowUp'))f+=1;
  if(keys.has('KeyS')||keys.has('ArrowDown'))f-=1;
  if(keys.has('KeyD')||keys.has('ArrowRight'))s+=1;
  if(keys.has('KeyA')||keys.has('ArrowLeft'))s-=1;
  f+=-mobileMove.y; s+=mobileMove.x;
  const l=Math.hypot(f,s); if(l>1){f/=l;s/=l;}
  if(isCoarse){
    camera.rotation.order='YXZ';camera.rotation.y=yaw;camera.rotation.x=pitch;
    const dir=new THREE.Vector3(Math.sin(yaw),0,Math.cos(yaw));
    const right=new THREE.Vector3(Math.cos(yaw),0,-Math.sin(yaw));
    camera.position.addScaledVector(dir,-f*speed*dt);
    camera.position.addScaledVector(right,s*speed*dt);
  }else{
    if(f) controls.moveForward(f*speed*dt);
    if(s) controls.moveRight(s*speed*dt);
  }
  camera.position.y=EYE_HEIGHT;
}

let lastTouch=null;
renderer.domElement.addEventListener('touchstart',e=>{
  const t=e.changedTouches[0];
  if(t.clientX>innerWidth*.35) lastTouch={x:t.clientX,y:t.clientY};
},{passive:true});
renderer.domElement.addEventListener('touchmove',e=>{
  if(!lastTouch)return;
  const t=e.changedTouches[0];
  yaw-=(t.clientX-lastTouch.x)*.004;
  pitch-=(t.clientY-lastTouch.y)*.004;
  pitch=Math.max(-1.25,Math.min(1.25,pitch));
  lastTouch={x:t.clientX,y:t.clientY};
},{passive:true});
renderer.domElement.addEventListener('touchend',()=>lastTouch=null,{passive:true});

const joy=document.getElementById('joystick'), stick=document.getElementById('stick');
let joyId=null;
function joyMove(t){
  const r=joy.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2;
  let dx=t.clientX-cx,dy=t.clientY-cy; const max=38,l=Math.hypot(dx,dy);
  if(l>max){dx=dx/l*max;dy=dy/l*max;}
  mobileMove={x:dx/max,y:dy/max};
  stick.style.transform='translate('+dx+'px,'+dy+'px)';
}
joy.addEventListener('touchstart',e=>{const t=e.changedTouches[0];joyId=t.identifier;joyMove(t);e.preventDefault()},{passive:false});
joy.addEventListener('touchmove',e=>{const t=[...e.changedTouches].find(x=>x.identifier===joyId);if(t)joyMove(t);e.preventDefault()},{passive:false});
joy.addEventListener('touchend',()=>{joyId=null;mobileMove={x:0,y:0};stick.style.transform='translate(0,0)'});

function animate(){
  requestAnimationFrame(animate);
  const dt=Math.min(clock.getDelta(),.04);
  move(dt);updateCoords();renderer.render(scene,camera);
}
animate();

addEventListener('resize',()=>{
  camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();
  renderer.setSize(innerWidth,innerHeight);
});