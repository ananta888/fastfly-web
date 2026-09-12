import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  signal,
  ViewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { WsService } from './ws.service';

const STIM_LEFT = 'Sugar (left proboscis)';
const STIM_RIGHT = 'Sugar (right proboscis)';

const ARENA_HALF = 12;
const SUGAR_EAT = 0.8;
const DETECT_RADIUS = 9;

@Component({
  selector: 'app-lab-view',
  imports: [CommonModule],
  template: `
    <div #labHost class="lab-host"></div>
    <div class="lab-overlay">
      <span class="lab-chip" [class.on]="detected()">
        {{ detected() ? 'ZUCKER ERKANNT' : 'SUCHE… ZUCKER' }}
      </span>
      <span class="lab-chip">{{ eatenCount() }} Zucker gegessen</span>
      <span class="lab-chip" [class.off]="!running()">
        {{ running() ? 'GEHIRN AKTIV' : 'PAUSIERT' }}
      </span>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        width: 100%;
        height: 100%;
        position: relative;
      }
      .lab-host {
        width: 100%;
        height: 100%;
      }
      .lab-overlay {
        position: absolute;
        top: 10px;
        left: 50%;
        transform: translateX(-50%);
        display: flex;
        gap: 8px;
      }
      .lab-chip {
        font-size: 11px;
        color: #8b949e;
        background: rgba(13, 17, 23, 0.8);
        border: 1px solid #21262d;
        border-radius: 20px;
        padding: 4px 12px;
        white-space: nowrap;
      }
      .lab-chip.on {
        color: #8ce99a;
        border-color: #238636;
      }
      .lab-chip.off {
        color: #ff9b9b;
        border-color: #a04040;
      }
    `,
  ],
})
export class LabView implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('labHost', { static: true }) host!: ElementRef<HTMLDivElement>;

  protected readonly detected = signal(false);
  protected readonly eatenCount = signal(0);
  protected readonly running = signal(false);

  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera!: THREE.PerspectiveCamera;
  private controls!: OrbitControls;

  private bug = new THREE.Group();
  private bugBody!: THREE.Mesh; // abdomen (glow = firing-rate heat)
  private head!: THREE.Mesh;
  private proboscis!: THREE.Mesh;
  private bugHeight = 0.55;
  private heading = Math.PI / 2;
  private velocity = new THREE.Vector3();
  private lastSpeed = 0;
  private autoTurn = 0.6;
  private legs: { hip: THREE.Group; knee: THREE.Group }[] = [];
  private legPhase = 0;
  private readonly legBaseY = -0.12;
  private readonly tripodA = new Set([0, 4, 2]); // front-left, mid-right, hind-left
  // Real per-brain-region motor drive (see onMetrics) — no per-leg motor
  // neurons exist in this connectome (brain-only, not the VNC/MANC), so
  // the tripod gait is synthesized, but its speed/turn/detail signals
  // below all come straight from actual descending/motor neuron groups.
  private turnSkew = 0;
  private brainHeat = 0;
  private neckTurn = 0;
  private pharynxAmt = 0;
  private readonly camFollowPos = new THREE.Vector3();

  private sugarMesh!: THREE.Mesh;
  private sugarMat!: THREE.MeshStandardMaterial;
  private sugarLight!: THREE.PointLight;
  private sugarPos = new THREE.Vector3(7, 0, -7);

  private raf = 0;
  private lastMetricsAt = performance.now();
  private lastStimSent = '';
  private lastStimRefreshed = 0;

  constructor(private ws: WsService) {}

  ngOnInit(): void {
    this.ws.messages.subscribe((m) => {
      if (m['type'] === 'state') this.running.set(Boolean(m['running']));
      else if (m['type'] === 'metrics') this.onMetrics(m as any);
    });
    if (!this.ws.connected()) this.ws.connect();
    this.ws.send({ cmd: 'start' });
  }

  ngAfterViewInit(): void {
    const el = this.host.nativeElement;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(el.clientWidth || 640, el.clientHeight || 480);
    this.renderer.shadowMap.enabled = true;
    this.renderer.setClearColor(0x1b2a3a);
    el.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(
      55,
      (el.clientWidth || 640) / (el.clientHeight || 480),
      0.1,
      100
    );
    this.camera.position.set(4.2, 3.4, 5.2);
    this.camera.lookAt(0, this.bugHeight, 0);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 1.5;
    this.controls.maxDistance = 22;
    this.controls.target.set(0, this.bugHeight, 0);

    this.buildArena();
    this.buildSugar(this.sugarPos);
    this.buildBug();
    this.camFollowPos.copy(this.bug.position);

    this.scene.add(new THREE.HemisphereLight(0xbfdcff, 0x2a3b2a, 0.9));
    const sun = new THREE.DirectionalLight(0xfff2cc, 1.4);
    sun.position.set(8, 14, 6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = 20;
    sun.shadow.camera.left = -s;
    sun.shadow.camera.right = s;
    sun.shadow.camera.top = s;
    sun.shadow.camera.bottom = -s;
    this.scene.add(sun);

    window.addEventListener('resize', this.onResize);
    this.loop();
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    this.controls?.dispose();
    this.renderer?.dispose();
    this.host?.nativeElement?.firstChild?.remove();
  }

  protected newSugar(): void {
    this.relocateSugar();
  }

  protected resetBug(): void {
    this.bug.position.set(0, this.bugHeight, 0);
    this.heading = Math.random() * Math.PI * 2;
    this.velocity.set(0, 0, 0);
  }

  private buildArena(): void {
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(ARENA_HALF * 2 + 4, ARENA_HALF * 2 + 4),
      new THREE.MeshStandardMaterial({ color: 0x2d5a32, roughness: 1 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, 0, 0);
    ground.receiveShadow = true;
    this.scene.add(ground);

    const grid = new THREE.GridHelper(ARENA_HALF * 2, 16, 0x3f7a46, 0x24502c);
    grid.position.y = 0.02;
    this.scene.add(grid);

    const fence = new THREE.Mesh(
      new THREE.RingGeometry(ARENA_HALF + 0.3, ARENA_HALF + 0.9, 64),
      new THREE.MeshStandardMaterial({ color: 0x6b4a1f, roughness: 1 })
    );
    fence.rotation.x = -Math.PI / 2;
    fence.position.y = 0.03;
    this.scene.add(fence);

    const rng = (() => {
      let s = 7;
      return () => {
        s = (s * 1103515245 + 12345) % 2147483648;
        return s / 2147483648;
      };
    })();
    for (let i = 0; i < 26; i++) {
      const a = rng() * Math.PI * 2;
      const r = 2 + rng() * (ARENA_HALF - 2.5);
      const bush = new THREE.Mesh(
        new THREE.SphereGeometry(0.25 + rng() * 0.5, 8, 6),
        new THREE.MeshStandardMaterial({ color: 0x1f7a33, roughness: 1, flatShading: true })
      );
      bush.position.set(Math.cos(a) * r, 0.25 + rng() * 0.2, Math.sin(a) * r);
      bush.castShadow = true;
      this.scene.add(bush);
    }
  }

  private buildSugar(pos: THREE.Vector3): void {
    const geo = new THREE.BoxGeometry(0.85, 0.85, 0.85);
    this.sugarMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0x7bd63f,
      emissiveIntensity: 1.6,
      roughness: 0.3,
    });
    this.sugarMesh = new THREE.Mesh(geo, this.sugarMat);
    this.sugarMesh.position.copy(pos);
    this.sugarMesh.position.y = 0.5;
    this.sugarMesh.castShadow = true;
    this.scene.add(this.sugarMesh);

    this.sugarLight = new THREE.PointLight(0x8ce99a, 8, 8);
    this.sugarLight.position.copy(this.sugarMesh.position);
    this.sugarLight.position.y = 2;
    this.scene.add(this.sugarLight);
  }

  private buildBug(): void {
    const dark = new THREE.MeshStandardMaterial({ color: 0x3a2a20, roughness: 0.7 });
    const gloss = new THREE.MeshStandardMaterial({ color: 0x5c3b28, roughness: 0.4 });
    const glow = new THREE.MeshStandardMaterial({ color: 0xf7b32b, emissive: 0xf7b32b, emissiveIntensity: 0.6, roughness: 0.5 });

    // Thorax (small, between head and abdomen — wings and legs attach here)
    const thorax = new THREE.Mesh(new THREE.SphereGeometry(0.24, 14, 10), gloss);
    thorax.scale.set(1.05, 0.85, 0.95);
    thorax.position.set(0.12, 0.05, 0);
    this.bug.add(thorax);

    // Abdomen (elongated, tapered rearward — glows with firing-rate heat)
    this.bugBody = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 12), glow);
    this.bugBody.scale.set(2.0, 0.78, 0.85);
    this.bugBody.position.set(-0.42, -0.03, 0);
    this.bug.add(this.bugBody);

    this.head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 10), dark);
    this.head.position.set(0.58, 0.1, 0);
    this.bug.add(this.head);
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0xb2263e, emissive: 0x8a1428, emissiveIntensity: 0.5, roughness: 0.2 });
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 10), eyeMat);
      eye.scale.set(0.9, 1, 1);
      eye.position.set(0.68, 0.14, side * 0.17);
      this.bug.add(eye);
      const anten = new THREE.Mesh(new THREE.ConeGeometry(0.02, 0.42, 6), dark);
      anten.rotation.z = side * -0.9;
      anten.position.set(0.52, 0.32, side * 0.13);
      this.bug.add(anten);
    }

    // Proboscis — retracted under the head by default, extends toward food
    // when motor_pharynx (a real feeding-circuit motor group) fires.
    this.proboscis = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.045, 0.3, 6), dark);
    this.proboscis.geometry.translate(0, -0.15, 0);
    this.proboscis.rotation.z = Math.PI / 2 + 0.3;
    this.proboscis.position.set(0.66, -0.02, 0);
    this.proboscis.scale.y = 0.05;
    this.bug.add(this.proboscis);

    // Jointed legs: hip (coxa/femur) + knee (tibia), tripod-gait driven.
    const legXs = [0.3, 0.02, -0.28]; // front / mid / hind hip, relative to thorax
    this.legs = [];
    for (const side of [-1, 1]) {
      for (const x of legXs) {
        const hip = new THREE.Group();
        hip.position.set(x, this.legBaseY, side * 0.4);
        const femur = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.02, 0.26, 6), dark);
        femur.position.set(0.02, -0.13, side * 0.09);
        femur.rotation.z = side * 0.5;
        hip.add(femur);

        const knee = new THREE.Group();
        knee.position.set(0.045, -0.25, side * 0.16);
        const tibia = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.01, 0.3, 6), dark);
        tibia.position.y = -0.15;
        knee.add(tibia);
        hip.add(knee);

        this.bug.add(hip);
        this.legs.push({ hip, knee });
      }
    }

    const wingMat = new THREE.MeshStandardMaterial({
      color: 0xdcefff,
      transparent: true,
      opacity: 0.32,
      roughness: 0.15,
      metalness: 0.1,
      side: THREE.DoubleSide,
    });
    for (const side of [-1, 1]) {
      const wing = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.22), wingMat);
      wing.position.set(0.08, 0.24, side * 0.14);
      wing.rotation.y = side * 0.55;
      wing.rotation.z = side * 0.12;
      this.bug.add(wing);
    }

    this.bug.position.set(0, this.bugHeight, 0);
    this.scene.add(this.bug);
  }

  private onMetrics(m: {
    step?: number;
    firing_rate?: number;
    motor_rates?: Record<string, number>;
    active_indices?: number[];
  }): void {
    this.running.set(true);

    const motor = m['motor_rates'] ?? {};
    const dl = motor['descending_left'] ?? 0;
    const dr = motor['descending_right'] ?? 0;
    const dc = motor['descending_center'] ?? 0;
    const ant = motor['motor_antenna'] ?? 0;
    const prob = motor['motor_proboscis'] ?? 0;
    const neck = motor['motor_neck'] ?? 0;
    const pharynx = motor['motor_pharynx'] ?? 0;

    const now = performance.now();
    const dt = Math.min(0.2, Math.max(0.01, (now - this.lastMetricsAt) / 1000));
    this.lastMetricsAt = now;

    // Sugar direction relative to bug heading
    const toSugar = new THREE.Vector3()
      .subVectors(this.sugarPos, this.bug.position);
    toSugar.y = 0;
    const dist = toSugar.length();
    const sugarAngle = Math.atan2(toSugar.x, toSugar.z);
    const relAngle = this.normAngle(sugarAngle - this.heading);
    const leftDet = dist < DETECT_RADIUS && relAngle > 0.35;
    const rightDet = dist < DETECT_RADIUS && relAngle < -0.35;
    const centerDet = dist < DETECT_RADIUS && !leftDet && !rightDet;

    this.detected.set(leftDet || rightDet || centerDet);

    // Drive the brain: stimulate the sugar sense on the detected side
    const amp = Math.min(0.5, 0.18 + 0.32 * (1 - dist / DETECT_RADIUS));
    let side = '';
    if (leftDet) side = STIM_LEFT;
    else if (rightDet) side = STIM_RIGHT;
    else if (centerDet) side = 'Sugar (proboscis)';
    if (side !== this.lastStimSent || now - this.lastStimRefreshed > 2000) {
      if (side !== this.lastStimSent) this.ws.send({ cmd: 'clear_stimulus' });
      if (side) this.ws.send({ cmd: 'stimulus_preset', name: side, amplitude: amp });
      this.lastStimSent = side;
      this.lastStimRefreshed = now;
    }

    // Brain-derived locomotion. descending_center is the connectome's actual
    // whole-body walking-drive neuron group (baseline ~0.2-0.3, fluctuates on
    // its own) — used here instead of a hardcoded constant, so idle walking
    // speed is genuinely brain-derived, not scripted. proboscis/antenna still
    // add an appetitive kick on top when the feeding circuits actually fire.
    const drive = Math.min(2.4, dc * 3.6 + prob * 700 + ant * 400);
    const steer = THREE.MathUtils.clamp((dr - dl) * 140, -2.6, 2.6);
    if (!this.detected()) this.autoTurn += (Math.random() - 0.5) * 0.28;
    else this.autoTurn *= 0.8;

    this.heading = this.normAngle(this.heading + steer * dt + this.autoTurn * dt);
    this.lastSpeed = THREE.MathUtils.lerp(this.lastSpeed, drive, 0.35);
    this.velocity.set(
      Math.sin(this.heading) * this.lastSpeed,
      0,
      Math.cos(this.heading) * this.lastSpeed
    );
    // Real descending_left/right differential also skews the leg-swing
    // amplitude between the two sides in loop() (outer legs step bigger to
    // turn, as in real hexapod steering) — not just the heading.
    this.turnSkew = THREE.MathUtils.clamp(steer / 2.6, -1, 1);
    // Neck motor neurons drive an independent head look, on top of body heading.
    this.neckTurn = THREE.MathUtils.clamp((neck - 0.03) * 30, -0.5, 0.5);
    // Pharynx motor neurons drive the proboscis extension (feeding reflex).
    this.pharynxAmt = THREE.MathUtils.clamp((pharynx - 0.009) * 60, 0, 1);

    // Emit glowing with brain activity; also feeds leg-jitter/step-frequency.
    const heat = THREE.MathUtils.clamp((m['firing_rate'] ?? 0) / 0.05, 0, 1);
    this.brainHeat = heat;
    const mat = this.bugBody.material as THREE.MeshStandardMaterial;
    mat.emissiveIntensity = 0.3 + heat * 2.2;
  }

  private relocateSugar(): void {
    const a = Math.random() * Math.PI * 2;
    const r = 2 + Math.random() * (ARENA_HALF - 3);
    this.sugarPos.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    this.sugarMesh.position.set(this.sugarPos.x, 0.5, this.sugarPos.z);
    this.sugarLight.position.set(this.sugarPos.x, 2, this.sugarPos.z);
    this.ws.send({ cmd: 'clear_stimulus' });
    this.lastStimSent = '';
  }

  private normAngle(a: number): number {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  }

  private onResize = (): void => {
    if (!this.host?.nativeElement || !this.renderer || !this.camera) return;
    const width = this.host.nativeElement.clientWidth || 640;
    const height = this.host.nativeElement.clientHeight || 480;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  };

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    const frameDt = 0.016;

    // Move bug
    this.bug.position.x += this.velocity.x * frameDt;
    this.bug.position.z += this.velocity.z * frameDt;
    const lim = ARENA_HALF - 1.0;
    if (Math.abs(this.bug.position.x) > lim || Math.abs(this.bug.position.z) > lim) {
      this.bug.position.x = Math.max(-lim, Math.min(lim, this.bug.position.x));
      this.bug.position.z = Math.max(-lim, Math.min(lim, this.bug.position.z));
      this.heading = this.normAngle(this.heading + Math.PI * (0.5 + Math.random() * 0.4));
      this.velocity.multiplyScalar(-0.5);
    }
    this.bug.position.y = this.bugHeight;
    this.bug.rotation.y = this.heading;

    // Gentle gait wobble
    this.bugBody.scale.y = 0.78 + Math.sin(performance.now() * 0.012) * 0.04;

    // Head look (independent of body heading) — driven by real motor_neck.
    this.head.rotation.y = THREE.MathUtils.lerp(this.head.rotation.y, this.neckTurn, 0.06);
    // Proboscis extension — driven by real motor_pharynx (feeding reflex).
    this.proboscis.scale.y = THREE.MathUtils.lerp(
      this.proboscis.scale.y,
      0.05 + this.pharynxAmt * 0.95,
      0.12
    );

    // Tripod-gait leg walk: two alternating groups of 3 legs. This connectome
    // has no per-leg motor neurons (it's brain-only, not the VNC/MANC that
    // actually wires individual legs in a real fly), so the gait itself is
    // synthesized — but every input driving it is a real brain signal: step
    // frequency/lift track descending_center + firing-rate heat, and the
    // left/right amplitude split tracks the real descending_left/right
    // steering differential (outer legs take bigger steps to turn, like real
    // hexapod locomotion), plus a firing-rate-linked jitter so the gait
    // visibly reacts to brain spikes instead of looping identically.
    const idleTwitch = this.lastSpeed < 0.05;
    const stepFreq = 3.2 + this.lastSpeed * 2.5 + this.brainHeat * 1.4;
    this.legPhase += frameDt * stepFreq * (idleTwitch ? 0.2 : 1);
    const baseAmp = idleTwitch ? 0.06 : THREE.MathUtils.clamp(0.2 + this.lastSpeed * 0.34, 0.2, 0.75);
    const jitter = (Math.random() - 0.5) * this.brainHeat * 0.12;
    this.legs.forEach((leg, i) => {
      const sideFactor = i < 3 ? 1 + this.turnSkew * 0.5 : 1 - this.turnSkew * 0.5;
      const groupPhase = this.tripodA.has(i) ? 0 : Math.PI;
      const s = Math.sin(this.legPhase + groupPhase);
      const amp = Math.max(0.05, baseAmp * sideFactor + jitter);
      const lift = Math.max(0, s);
      leg.hip.rotation.x = s * amp;
      leg.hip.position.y = this.legBaseY + lift * (idleTwitch ? 0.01 : 0.07);
      leg.knee.rotation.x = -lift * amp * 1.4 - 0.1;
    });

    // Sugar pulse & eat
    this.sugarMesh.rotation.y += frameDt * 2;
    const pulse = 1 + Math.sin(performance.now() * 0.006) * 0.08;
    this.sugarMesh.scale.setScalar(pulse);
    this.sugarMat.emissiveIntensity = 1.2 + Math.sin(performance.now() * 0.008) * 0.7;
    this.sugarLight.intensity = 4 + Math.sin(performance.now() * 0.008) * 3;

    const toSugar = new THREE.Vector3().subVectors(this.sugarPos, this.bug.position);
    toSugar.y = 0;
    if (toSugar.length() < SUGAR_EAT) {
      this.eatenCount.update((n) => n + 1);
      this.relocateSugar();
    }

    // Follow the bug: shift camera + orbit target by however far it moved
    // this frame, preserving whatever zoom/angle the user has dialed in.
    const followDelta = new THREE.Vector3().subVectors(this.bug.position, this.camFollowPos);
    if (this.controls && (followDelta.x !== 0 || followDelta.z !== 0)) {
      this.camera.position.add(followDelta);
      this.controls.target.add(followDelta);
      this.camFollowPos.copy(this.bug.position);
    }

    this.controls?.update();
    this.renderer?.render(this.scene, this.camera);
  };
}
