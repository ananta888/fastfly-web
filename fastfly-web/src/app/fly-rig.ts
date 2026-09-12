// Loads and assembles the real NeuroMechFly v2 fly body (meshes + joint
// hierarchy + recorded gait tables + real CPG topology), sourced from the
// flygym project's browser-game assets. See public/fly/ATTRIBUTION.md for
// provenance/license (Apache-2.0) — only the geometry, the real per-leg
// joint-angle *shape*, and the real coupled-oscillator gait *algorithm* are
// reused; FastFly drives it with its own simulated-brain motor signals, not
// flygym's own CPG-drive/keyboard controller, and at our own (much slower,
// real-time-calibrated) step frequency — see stepCpg()'s comment for why.
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

export const LEG_ORDER = ['lf', 'lm', 'lh', 'rf', 'rm', 'rh'] as const;
export type LegName = (typeof LEG_ORDER)[number];
// dof_names order in gait-tables.json: coxa_yaw, coxa_pitch, coxa_roll,
// tf_pitch, tf_roll, tibia_pitch, tarsus1_pitch.
const DOF_JOINT_SUFFIX = [
  (p: string) => `c_thorax-${p}_coxa-yaw`,
  (p: string) => `c_thorax-${p}_coxa-pitch`,
  (p: string) => `c_thorax-${p}_coxa-roll`,
  (p: string) => `${p}_coxa-${p}_trochanterfemur-pitch`,
  (p: string) => `${p}_coxa-${p}_trochanterfemur-roll`,
  (p: string) => `${p}_trochanterfemur-${p}_tibia-pitch`,
  (p: string) => `${p}_tibia-${p}_tarsus1-pitch`,
];

interface RigJoint {
  name: string;
  axis: [number, number, number];
  springref: number;
}
interface RigGeom {
  name: string;
  mesh: string;
  material: string;
  pos?: [number, number, number];
  quat?: [number, number, number, number];
}
interface RigNode {
  name: string;
  pos: [number, number, number];
  quat: [number, number, number, number];
  geoms: RigGeom[];
  joints: RigJoint[];
  children: RigNode[];
}
interface RigFile {
  thorax: RigNode;
  materials: Record<string, [number, number, number, number]>;
  meshes: Record<string, { file: string; scale: [number, number, number] }>;
}

export interface GaitTables {
  n_samples: number;
  leg_order: LegName[];
  tripod_map: number[];
  dof_names: string[];
  legs: Record<LegName, { angles: number[][]; neutral: number[]; swing: [number, number] }>;
  // Real coupled-oscillator topology (dimensionless, timescale-independent —
  // see stepCpg()): 6x6 coupling weights + phase biases, per-leg convergence.
  cpg: { coupling_weights: number[][]; phase_biases: number[][]; convergence_coefs: number[] };
}

export interface FlyRig {
  root: THREE.Group; // add this to your scene/parent group
  legJoints: Record<LegName, THREE.Group[]>; // 7 joint groups per leg, DOF order above
  abdomenMeshes: THREE.Mesh[]; // for firing-rate glow
  haustellum: THREE.Object3D; // for the pharynx feeding-reflex pulse
  wings: { left: THREE.Group; right: THREE.Group }; // kept still — see class comment in lab-view.ts
  antennae: { left: THREE.Group; right: THREE.Group }; // synthetic pivot (rig has no real antenna joint), driven by motor_antenna
  eyes: { left: THREE.MeshStandardMaterial; right: THREE.MeshStandardMaterial }; // for motor_eye shimmer
  head: THREE.Group; // synthetic pivot (c_head is a fixed geom on the thorax, no joint), driven by motor_neck
  gait: GaitTables;
}

// Flat approximation of flygym's procedural body-part textures (we skip the
// texture bitmaps and just use their base tone) — the 4 parts that do have a
// flat rgba <material> in fly.xml are read from the file instead.
const TEXTURE_TONE: Record<string, [number, number, number, number]> = {
  headthorax: [0.59, 0.39, 0.12, 1],
  antennaproboscis: [0.59, 0.39, 0.12, 1],
  abdomen12345: [0.7, 0.53, 0.3, 1],
  abdomen6: [0.6, 0.43, 0.24, 1],
  coxa: [0.59, 0.39, 0.12, 1],
  trochanterfemur: [0.63, 0.43, 0.16, 1],
  tibia: [0.67, 0.47, 0.2, 1],
  tarsus: [0.71, 0.51, 0.24, 1],
};

function axisIndex(axis: [number, number, number]): 0 | 1 | 2 {
  if (axis[0]) return 0;
  if (axis[1]) return 1;
  return 2;
}
const AXIS_KEY = ['x', 'y', 'z'] as const;

// public/fly/*.json aren't filename-hashed by the Angular build (unlike the
// JS bundle), so a browser can serve a stale cached copy after a deploy that
// changed their shape — that's what caused a "can't zoom, fly gone" report
// once (a cached pre-CPG gait-tables.json threw in stepCpg() every frame,
// before ever reaching controls.update()/render() — see the try/catch around
// stepFlyRig() in lab-view.ts). Bump this whenever these JSON files' shape
// changes, to force a fresh fetch instead of relying on cache headers alone.
const ASSET_VERSION = 2;

export async function loadFlyRig(baseUrl: string, scale = 1): Promise<FlyRig> {
  const v = `?v=${ASSET_VERSION}`;
  const [rig, gait] = await Promise.all([
    fetch(`${baseUrl}/fly-rig.json${v}`).then((r) => r.json() as Promise<RigFile>),
    fetch(`${baseUrl}/gait-tables.json${v}`).then((r) => r.json() as Promise<GaitTables>),
  ]);

  const stlLoader = new STLLoader();
  const uniqueFiles = [...new Set(Object.values(rig.meshes).map((m) => m.file))];
  const geomByFile = new Map<string, THREE.BufferGeometry>();
  await Promise.all(
    uniqueFiles.map(async (f) => {
      const geo = await stlLoader.loadAsync(`${baseUrl}/stl/${f}`);
      geo.computeVertexNormals();
      geomByFile.set(f, geo);
    })
  );

  const materialCache = new Map<string, THREE.MeshStandardMaterial>();
  const eyeMaterials: { left: THREE.MeshStandardMaterial | null; right: THREE.MeshStandardMaterial | null } = {
    left: null,
    right: null,
  };
  function materialFor(key: string, geomName: string): THREE.MeshStandardMaterial {
    // Eyes get their own material instance each (not cached by key) so left
    // and right can shimmer independently from motor_eye.
    if (key === 'eye') {
      const rgba = rig.materials['eye'] || [0.67, 0.21, 0.12, 1];
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(rgba[0], rgba[1], rgba[2]),
        roughness: 0.35,
        emissive: new THREE.Color(rgba[0], rgba[1], rgba[2]),
        emissiveIntensity: 0.15,
      });
      if (geomName === 'l_eye') eyeMaterials.left = mat;
      if (geomName === 'r_eye') eyeMaterials.right = mat;
      return mat;
    }
    let mat = materialCache.get(key);
    if (mat) return mat;
    const rgba = rig.materials[key] || TEXTURE_TONE[key] || [0.6, 0.6, 0.6, 1];
    const isAbdomen = key === 'abdomen12345' || key === 'abdomen6';
    mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(rgba[0], rgba[1], rgba[2]),
      roughness: 0.7,
      transparent: rgba[3] < 1,
      opacity: rgba[3],
      side: rgba[3] < 1 ? THREE.DoubleSide : THREE.FrontSide,
      // Abdomen segments glow with brain firing-rate heat (see lab-view.ts);
      // give them a warm emissive channel to pulse, everything else stays flat.
      emissive: isAbdomen ? new THREE.Color(0xf7b32b) : new THREE.Color(0x000000),
      emissiveIntensity: isAbdomen ? 0.2 : 0,
    });
    materialCache.set(key, mat);
    return mat;
  }

  const meshGeomCache = new Map<string, THREE.BufferGeometry>();
  function geometryForMesh(meshName: string): THREE.BufferGeometry {
    let geo = meshGeomCache.get(meshName);
    if (geo) return geo;
    const spec = rig.meshes[meshName];
    const base = geomByFile.get(spec.file)!;
    geo = base.clone();
    geo.scale(spec.scale[0], spec.scale[1], spec.scale[2]);
    // Mirrored (negative-scale) copies flip winding; fix so lighting is correct.
    if (spec.scale[0] * spec.scale[1] * spec.scale[2] < 0) geo = geo.toNonIndexed();
    geo.computeVertexNormals();
    meshGeomCache.set(meshName, geo);
    return geo;
  }

  const abdomenMeshes: THREE.Mesh[] = [];
  const legJoints: Record<string, THREE.Group[]> = {};
  let haustellum: THREE.Object3D | null = null;
  const wings: { left: THREE.Group | null; right: THREE.Group | null } = { left: null, right: null };
  const antennae: { left: THREE.Group | null; right: THREE.Group | null } = { left: null, right: null };
  let head: THREE.Group | null = null;

  function buildNode(node: RigNode): THREE.Group {
    const outer = new THREE.Group();
    if (node.name === 'l_wing') wings.left = outer;
    if (node.name === 'r_wing') wings.right = outer;
    outer.position.set(...node.pos);
    // MJCF quat is (w,x,y,z); THREE.Quaternion wants (x,y,z,w).
    outer.quaternion.set(node.quat[1], node.quat[2], node.quat[3], node.quat[0]);

    let inner: THREE.Group = outer;

    // The base rig has no antenna joint at all (fly.xml models pedicel as a
    // fixed offset) — real flies do deflect their antennae (wind-sensing,
    // grooming, arousal), and motor_antenna is a real motor-neuron group, so
    // insert a synthetic pivot here rather than leaving the signal unused.
    if (node.name === 'l_pedicel' || node.name === 'r_pedicel') {
      const pivot = new THREE.Group();
      outer.add(pivot);
      inner = pivot;
      if (node.name === 'l_pedicel') antennae.left = pivot;
      else antennae.right = pivot;
    }

    for (const j of node.joints) {
      const jg = new THREE.Group();
      jg.userData['joint'] = j.name;
      const ax = axisIndex(j.axis);
      jg.rotation[AXIS_KEY[ax]] = j.springref;
      jg.userData['axisKey'] = AXIS_KEY[ax];
      inner.add(jg);
      inner = jg;
      (legJoints[jointLeg(j.name)] ??= []).push(jg);
    }

    for (const g of node.geoms) {
      const mesh = new THREE.Mesh(geometryForMesh(g.mesh), materialFor(g.material, g.name));
      if (g.pos) mesh.position.set(...g.pos);
      if (g.quat) mesh.quaternion.set(g.quat[1], g.quat[2], g.quat[3], g.quat[0]);
      mesh.castShadow = true;
      if (g.name === 'c_head') {
        // c_head is a fixed geom directly on the thorax, no joint of its own
        // — wrap it in a synthetic pivot at its attachment point so
        // motor_neck (a real motor-neuron group) can drive a small head
        // nod/turn instead of sitting unused.
        const pivot = new THREE.Group();
        pivot.position.copy(mesh.position);
        pivot.quaternion.copy(mesh.quaternion);
        mesh.position.set(0, 0, 0);
        mesh.quaternion.identity();
        pivot.add(mesh);
        inner.add(pivot);
        head = pivot;
      } else {
        inner.add(mesh);
      }
      if (g.name.startsWith('c_abdomen')) abdomenMeshes.push(mesh);
      if (g.name === 'c_haustellum') haustellum = mesh;
    }

    for (const child of node.children) inner.add(buildNode(child));
    return outer;
  }

  function jointLeg(jointName: string): string {
    // e.g. "c_thorax-lf_coxa-yaw" / "lf_coxa-lf_trochanterfemur-pitch" -> "lf"
    const m = jointName.match(/\b(l[fmh]|r[fmh])_/);
    return m ? m[1] : '?';
  }

  const thoraxGroup = buildNode(rig.thorax);
  // Reorder each leg's joints into the canonical 7-DOF order (coxa yaw/pitch/
  // roll, tf pitch/roll, tibia pitch, tarsus1 pitch) by joint name, since the
  // recursive build above collects them in document order (already matches,
  // but this is robust against any future reordering of fly.xml).
  const orderedLegJoints: Record<LegName, THREE.Group[]> = {} as any;
  for (const leg of LEG_ORDER) {
    const wanted = DOF_JOINT_SUFFIX.map((f) => f(leg));
    const have = legJoints[leg] || [];
    orderedLegJoints[leg] = wanted.map(
      (name) => have.find((g) => g.userData['joint'] === name)!
    );
  }

  // flygym/MuJoCo convention here: local +X = anterior, +Y = left, +Z = dorsal.
  // FastFly's arena convention: local +X = forward, +Y = up. Rotate -90° about
  // X to swap (Y,Z) -> (Z,-Y) i.e. dorsal becomes up.
  const root = new THREE.Group();
  root.rotation.x = -Math.PI / 2;
  root.scale.setScalar(scale);
  root.add(thoraxGroup);

  return {
    root,
    legJoints: orderedLegJoints,
    abdomenMeshes,
    haustellum: haustellum!,
    wings: { left: wings.left!, right: wings.right! },
    antennae: { left: antennae.left!, right: antennae.right! },
    eyes: { left: eyeMaterials.left!, right: eyeMaterials.right! },
    head: head!,
    gait,
  };
}

// --- Real coupled-oscillator CPG (Hopf-style phase + amplitude), the actual
// algorithm flygym's own game uses (game.js: Controller.stepCPG) — reused
// verbatim (dimensionless coupling_weights/phase_biases/convergence_coefs
// from the real model), NOT the naive "replay the table at raw phase" we
// started with. The key property this buys, which the old version was
// missing: WALKING SPEED IS CONVEYED BY STRIDE AMPLITUDE, NOT BY SPEEDING UP
// THE LEG-CYCLE FREQUENCY. Real insects (and this model) keep stepping
// cadence close to constant across a wide speed range and get from "idle
// shuffle" to "fast walk" mostly by taking bigger strides — our earlier
// version instead played the same fixed-amplitude stride back faster and
// faster with speed, which read as frantic/too-fast blurring rather than
// purposeful walking.
//
// flygym's own intrinsic_freqs (36.0) is calibrated for THEIR pipeline,
// where the physics runs at MuJoCo's dt=1e-4 and is then displayed at a
// fixed ~0.1x playback speed — so a human actually perceives ~3.6 Hz, not
// literally 36. We don't replicate that dt/playback-speed indirection; we
// integrate directly in real seconds, so BASE_FREQ_HZ below is our own
// real-time-calibrated pick (matching normal Drosophila walking cadence)
// rather than flygym's raw constant.
const BASE_FREQ_HZ = 4.2;

export interface CpgState {
  phases: Float64Array; // one phase per leg, radians
  mags: Float64Array; // one stride-amplitude (0..~1) per leg
}

export function createCpgState(): CpgState {
  const phases = new Float64Array(6);
  for (let i = 0; i < 6; i++) phases[i] = Math.random() * Math.PI * 2;
  return { phases, mags: new Float64Array(6) };
}

// gainL/gainR: desired stride amplitude for the left/right tripod (0 = stand
// still, ~1 = full recorded stride), independently — this is exactly how
// turning works here, same as flygym's own Level-1 CPG game mode: the outer
// (faster/bigger-striding) side amplitude is higher than the inner side.
export function stepCpg(rig: FlyRig, state: CpgState, dt: number, gainL: number, gainR: number): void {
  const { coupling_weights: W, phase_biases: PB, convergence_coefs: conv } = rig.gait.cpg;
  const { phases: ph, mags: mg } = state;
  const amps = [gainL, gainL, gainL, gainR, gainR, gainR];
  const TWO_PI = Math.PI * 2;
  const dph = new Array(6);
  for (let i = 0; i < 6; i++) {
    let coupling = 0;
    for (let j = 0; j < 6; j++) coupling += mg[j] * W[i][j] * Math.sin(ph[j] - ph[i] - PB[i][j]);
    dph[i] = TWO_PI * BASE_FREQ_HZ + coupling;
  }
  for (let i = 0; i < 6; i++) {
    ph[i] += dph[i] * dt;
    mg[i] += conv[i] * (amps[i] - mg[i]) * dt;
  }
  for (let i = 0; i < 6; i++) applyLegPhase(rig, LEG_ORDER[i], ph[i], mg[i]);
}

// Joint angles for one leg at a phase / stride-amplitude, by periodic-lerp of
// the baked table: angle = neutral + amplitude * (table(phase) - neutral).
// At amplitude 0 the leg just sits at its neutral standing pose, however
// fast the phase clock spins — this decoupling of "internal clock speed"
// from "visible movement extent" is the whole point of the amplitude term.
function applyLegPhase(rig: FlyRig, leg: LegName, phase: number, amplitude: number): void {
  const t = rig.gait.legs[leg];
  const n = rig.gait.n_samples;
  const TWO_PI = Math.PI * 2;
  let p = phase % TWO_PI;
  if (p < 0) p += TWO_PI;
  const f = (p / TWO_PI) * n;
  const i0 = Math.floor(f) % n;
  const i1 = (i0 + 1) % n;
  const frac = f - Math.floor(f);
  const groups = rig.legJoints[leg];
  for (let dof = 0; dof < 7; dof++) {
    const samp = t.angles[i0][dof] * (1 - frac) + t.angles[i1][dof] * frac;
    const angle = t.neutral[dof] + amplitude * (samp - t.neutral[dof]);
    const g = groups[dof];
    if (g) g.rotation[g.userData['axisKey'] as 'x' | 'y' | 'z'] = angle;
  }
}
