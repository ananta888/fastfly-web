// Loads and assembles the real NeuroMechFly v2 fly body (meshes + joint
// hierarchy + recorded gait tables), sourced from the flygym project's
// browser-game assets. See public/fly/ATTRIBUTION.md for provenance/license
// (Apache-2.0) — only the geometry and the real per-leg joint-angle-vs-phase
// *shape* are reused; FastFly drives it with its own simulated-brain motor
// signals, not flygym's own CPG/keyboard controller.
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
}

export interface FlyRig {
  root: THREE.Group; // add this to your scene/parent group
  legJoints: Record<LegName, THREE.Group[]>; // 7 joint groups per leg, DOF order above
  abdomenMeshes: THREE.Mesh[]; // for firing-rate glow
  haustellum: THREE.Object3D; // for the pharynx feeding-reflex pulse
  wings: { left: THREE.Group; right: THREE.Group }; // idle twitch (no flight joint in this walking-only rig)
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

export async function loadFlyRig(baseUrl: string, scale = 1): Promise<FlyRig> {
  const [rig, gait] = await Promise.all([
    fetch(`${baseUrl}/fly-rig.json`).then((r) => r.json() as Promise<RigFile>),
    fetch(`${baseUrl}/gait-tables.json`).then((r) => r.json() as Promise<GaitTables>),
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
  function materialFor(key: string): THREE.MeshStandardMaterial {
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

  function buildNode(node: RigNode): THREE.Group {
    const outer = new THREE.Group();
    if (node.name === 'l_wing') wings.left = outer;
    if (node.name === 'r_wing') wings.right = outer;
    outer.position.set(...node.pos);
    // MJCF quat is (w,x,y,z); THREE.Quaternion wants (x,y,z,w).
    outer.quaternion.set(node.quat[1], node.quat[2], node.quat[3], node.quat[0]);

    let inner: THREE.Group = outer;
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
      const mesh = new THREE.Mesh(geometryForMesh(g.mesh), materialFor(g.material));
      if (g.pos) mesh.position.set(...g.pos);
      if (g.quat) mesh.quaternion.set(g.quat[1], g.quat[2], g.quat[3], g.quat[0]);
      mesh.castShadow = true;
      inner.add(mesh);
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
    gait,
  };
}

// Sample a leg's baked 360-sample joint-angle table at a continuous phase
// (radians, any range — wrapped to [0, 2π)) with linear interpolation, and
// write the 7 angles straight into that leg's joint-group rotations.
export function applyLegPhase(rig: FlyRig, leg: LegName, phase: number): void {
  const table = rig.gait.legs[leg].angles;
  const n = rig.gait.n_samples;
  const TWO_PI = Math.PI * 2;
  let p = phase % TWO_PI;
  if (p < 0) p += TWO_PI;
  const f = (p / TWO_PI) * n;
  const i0 = Math.floor(f) % n;
  const i1 = (i0 + 1) % n;
  const t = f - Math.floor(f);
  const row0 = table[i0];
  const row1 = table[i1];
  const groups = rig.legJoints[leg];
  for (let dof = 0; dof < 7; dof++) {
    const angle = row0[dof] + (row1[dof] - row0[dof]) * t;
    const g = groups[dof];
    if (g) g.rotation[g.userData['axisKey'] as 'x' | 'y' | 'z'] = angle;
  }
}
