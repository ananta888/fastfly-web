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
  private bugBody!: THREE.Mesh;
  private bugHeight = 0.55;
  private heading = Math.PI / 2;
  private velocity = new THREE.Vector3();
  private lastSpeed = 0;
  private autoTurn = 0.6;

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
      if (m.type === 'state') this.running.set(Boolean(m.running));
      else if (m.type === 'metrics') this.onMetrics(m as any);
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
    this.camera.position.set(11, 13, 14);
    this.camera.lookAt(0, 0, 0);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    this.buildArena();
    this.buildSugar(this.sugarPos);
    this.buildBug();

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

    this.bugBody = new THREE.Mesh(new THREE.SphereGeometry(0.42, 16, 12), glow);
    this.bugBody.scale.set(1.4, 0.72, 0.9);
    this.bug.body.add(this.bugBody);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 10), dark);
    head.position.set(0.5, 0.08, 0);
    this.bug.add(head);
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.7 });
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 8), eyeMat);
      eye.position.set(0.62, 0.14, side * 0.16);
      this.bug.add(eye);
      const anten = new THREE.Mesh(new THREE.ConeGeometry(0.02, 0.55, 6), dark);
      anten.rotation.z = side * -0.9;
      anten.position.set(0.42, 0.34, side * 0.2);
      this.bug.add(anten);
    }
    for (let l = 0; l < 6; l++) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.5, 6), dark);
      leg.position.set(-0.05 + l * 0.14 - 0.28, -0.35, (l % 2 === 0 ? -1 : 1) * 0.42);
      this.bug.add(leg);
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

    const motor = m.motor_rates ?? {};
    const dl = motor['descending_left'] ?? 0;
    const dr = motor['descending_right'] ?? 0;
    const ant = motor['motor_antenna'] ?? 0;
    const prob = motor['motor_proboscis'] ?? 0;

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

    // Brain-derived locomotion: bump while hungry, steer by descending activity
    const drive = Math.min(2.4, 0.9 + prob * 900 + ant * 500);
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

    // Emit glowing with brain activity
    const heat = THREE.MathUtils.clamp((m.firing_rate ?? 0) / 0.05, 0, 1);
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
    this.bugBody.scale.y = 0.72 + Math.sin(performance.now() * 0.012) * 0.05;

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

    this.controls?.update();
    this.renderer?.render(this.scene, this.camera);
  };